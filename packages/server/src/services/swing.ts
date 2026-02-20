/**
 * Swing Trading Engine
 *
 * Monitors fleet positions and auto-sells on profit targets or stop losses.
 * Uses sequential single-hop quoting (Doppler-compatible) to evaluate P&L.
 */
import { createPublicClient, http, formatEther, type Address } from "viem";
import { base } from "viem/chains";
import { db } from "../db/index.js";
import type { SwingConfigRecord } from "../types.js";
import { getFleetByName } from "./fleet.js";
import { getCoinBalance, type CoinRouteClient } from "./coinRoute.js";
import { quoteCoinToEth } from "./quoter.js";
import { swapFromSmartAccount } from "./cdp.js";
import { recordTradePosition } from "./monitor.js";
import { getChainConfig } from "./network.js";
import { logger } from "../logger.js";

const WETH_BASE: Address = "0x4200000000000000000000000000000000000006";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SwingEvaluation {
  configId: number;
  fleetName: string;
  coinAddress: string;
  totalHoldings: bigint;
  currentValueWei: bigint;
  costBasisWei: bigint;
  pnlBps: number;
  trigger: "take_profit" | "stop_loss" | "trailing_stop" | "none";
  reason: string;
  skipped: boolean;
  skipReason?: string;
}

export interface SwingSellResult {
  configId: number;
  walletsProcessed: number;
  walletsSucceeded: number;
  walletsFailed: number;
  walletsSkipped: number;
  totalEthRecovered: bigint;
}

export interface SwingTickResult {
  startedAt: string;
  finishedAt: string;
  evaluations: SwingEvaluation[];
  sells: SwingSellResult[];
  errors: string[];
}

export interface SwingLoopStatus {
  running: boolean;
  intervalSec: number;
  isTicking: boolean;
  lastTick: SwingTickResult | null;
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const state: {
  running: boolean;
  timer: NodeJS.Timeout | null;
  intervalSec: number;
  isTicking: boolean;
  lastTick: SwingTickResult | null;
} = {
  running: false,
  timer: null,
  intervalSec: 60,
  isTicking: false,
  lastTick: null,
};

// ---------------------------------------------------------------------------
// P&L Calculation (exported for testing)
// ---------------------------------------------------------------------------

export function calculatePnlBps(currentValueWei: bigint, costBasisWei: bigint): number {
  if (costBasisWei === 0n) return 0;
  return Number(((currentValueWei - costBasisWei) * 10000n) / costBasisWei);
}

export function checkTrigger(
  pnlBps: number,
  config: SwingConfigRecord,
): { trigger: SwingEvaluation["trigger"]; reason: string } {
  // Take profit
  if (pnlBps >= config.takeProfitBps) {
    return { trigger: "take_profit", reason: `P&L ${pnlBps} bps >= take-profit ${config.takeProfitBps} bps` };
  }

  // Stop loss (stopLossBps is stored as positive, triggers on negative P&L)
  if (pnlBps <= -config.stopLossBps) {
    return { trigger: "stop_loss", reason: `P&L ${pnlBps} bps <= -stop-loss ${config.stopLossBps} bps` };
  }

  // Trailing stop
  if (config.trailingStopBps != null && config.peakPnlBps != null) {
    const dropFromPeak = config.peakPnlBps - pnlBps;
    if (dropFromPeak >= config.trailingStopBps && pnlBps < config.peakPnlBps) {
      return {
        trigger: "trailing_stop",
        reason: `P&L dropped ${dropFromPeak} bps from peak ${config.peakPnlBps} bps (threshold: ${config.trailingStopBps} bps)`,
      };
    }
  }

  return { trigger: "none", reason: "No trigger conditions met" };
}

// ---------------------------------------------------------------------------
// Core evaluation
// ---------------------------------------------------------------------------

export async function evaluateSwingPosition(config: SwingConfigRecord): Promise<SwingEvaluation> {
  const log = logger.child({ swing: config.fleetName, coin: config.coinAddress });

  const fleet = getFleetByName(config.fleetName);
  if (!fleet) {
    return {
      configId: config.id,
      fleetName: config.fleetName,
      coinAddress: config.coinAddress,
      totalHoldings: 0n,
      currentValueWei: 0n,
      costBasisWei: 0n,
      pnlBps: 0,
      trigger: "none",
      reason: "Fleet not found",
      skipped: true,
      skipReason: `Fleet "${config.fleetName}" not found`,
    };
  }

  // Check cooldown
  if (config.lastActionAt) {
    const lastAction = new Date(config.lastActionAt).getTime();
    const elapsed = (Date.now() - lastAction) / 1000;
    if (elapsed < config.cooldownSec) {
      return {
        configId: config.id,
        fleetName: config.fleetName,
        coinAddress: config.coinAddress,
        totalHoldings: 0n,
        currentValueWei: 0n,
        costBasisWei: 0n,
        pnlBps: 0,
        trigger: "none",
        reason: "In cooldown",
        skipped: true,
        skipReason: `Cooldown: ${Math.ceil(config.cooldownSec - elapsed)}s remaining`,
      };
    }
  }

  // Get positions and sum holdings + cost basis
  const coinAddr = config.coinAddress.toLowerCase() as `0x${string}`;
  const positions = db.listPositionsByCoin(coinAddr).filter((p) =>
    fleet.wallets.some((w) => w.id === p.walletId),
  );

  let totalHoldings = 0n;
  let costBasisWei = 0n;
  for (const pos of positions) {
    totalHoldings += BigInt(pos.holdingsRaw);
    costBasisWei += BigInt(pos.totalCostWei);
  }

  if (totalHoldings === 0n) {
    return {
      configId: config.id,
      fleetName: config.fleetName,
      coinAddress: config.coinAddress,
      totalHoldings: 0n,
      currentValueWei: 0n,
      costBasisWei,
      pnlBps: 0,
      trigger: "none",
      reason: "No holdings",
      skipped: true,
      skipReason: "No coin holdings",
    };
  }

  // Quote current value
  let currentValueWei: bigint;
  try {
    currentValueWei = await quoteCoinToEth({
      coinAddress: coinAddr,
      amount: totalHoldings,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error({ err }, "Failed to quote coin value");
    return {
      configId: config.id,
      fleetName: config.fleetName,
      coinAddress: config.coinAddress,
      totalHoldings,
      currentValueWei: 0n,
      costBasisWei,
      pnlBps: 0,
      trigger: "none",
      reason: `Quote failed: ${msg}`,
      skipped: true,
      skipReason: `Quote failed: ${msg}`,
    };
  }

  const pnlBps = calculatePnlBps(currentValueWei, costBasisWei);

  // Update peak tracking for trailing stop
  if (config.trailingStopBps != null) {
    if (config.peakPnlBps == null || pnlBps > config.peakPnlBps) {
      db.updateSwingConfig(config.id, { peakPnlBps: pnlBps });
    }
  }

  const { trigger, reason } = checkTrigger(pnlBps, config);

  log.info(
    { totalHoldings: totalHoldings.toString(), currentValueWei: currentValueWei.toString(), costBasisWei: costBasisWei.toString(), pnlBps, trigger },
    `Swing eval: ${reason}`,
  );

  return {
    configId: config.id,
    fleetName: config.fleetName,
    coinAddress: config.coinAddress,
    totalHoldings,
    currentValueWei,
    costBasisWei,
    pnlBps,
    trigger,
    reason,
    skipped: false,
  };
}

// ---------------------------------------------------------------------------
// Sell execution
// ---------------------------------------------------------------------------

export async function executeSwingSell(config: SwingConfigRecord): Promise<SwingSellResult> {
  const log = logger.child({ swing: config.fleetName, coin: config.coinAddress });
  const fleet = getFleetByName(config.fleetName);
  if (!fleet) throw new Error(`Fleet "${config.fleetName}" not found`);

  const coinAddr = config.coinAddress as Address;
  const cfg = getChainConfig();
  const client = createPublicClient({ chain: base, transport: http(cfg.rpcUrl) });

  let totalRecovered = 0n;
  let successes = 0;
  let failures = 0;
  let skipped = 0;

  for (const wallet of fleet.wallets) {
    const balance = await getCoinBalance(
      client as unknown as CoinRouteClient,
      coinAddr,
      wallet.address as Address,
    );

    if (balance === 0n) {
      skipped++;
      continue;
    }

    log.info({ wallet: wallet.name, balance: balance.toString() }, "Swing selling");

    try {
      const result = await swapFromSmartAccount({
        smartAccountName: wallet.cdpAccountName,
        fromToken: coinAddr,
        toToken: WETH_BASE,
        fromAmount: balance,
        slippageBps: config.slippageBps,
      });

      if (result.status === "complete") {
        const out = BigInt(result.amountOut ?? "0");
        totalRecovered += out;
        successes++;
        log.info({ wallet: wallet.name, ethRecovered: formatEther(out) }, "Swing sell complete");

        recordTradePosition({
          walletId: wallet.id,
          coinAddress: coinAddr,
          isBuy: false,
          ethAmountWei: out.toString(),
          tokenAmount: balance.toString(),
        });
      } else {
        failures++;
        log.warn({ wallet: wallet.name, status: result.status }, "Swing sell non-complete status");
      }
    } catch (err) {
      failures++;
      log.error({ wallet: wallet.name, err }, "Swing sell failed");
    }
  }

  // Update config: reset peak, set last action
  db.updateSwingConfig(config.id, {
    peakPnlBps: null,
    lastActionAt: new Date().toISOString(),
  });

  return {
    configId: config.id,
    walletsProcessed: fleet.wallets.length,
    walletsSucceeded: successes,
    walletsFailed: failures,
    walletsSkipped: skipped,
    totalEthRecovered: totalRecovered,
  };
}

// ---------------------------------------------------------------------------
// Swing tick
// ---------------------------------------------------------------------------

export async function runSwingTick(): Promise<SwingTickResult> {
  if (state.isTicking) {
    throw new Error("Swing tick already in progress");
  }
  state.isTicking = true;

  const startedAt = new Date().toISOString();
  const result: SwingTickResult = {
    startedAt,
    finishedAt: startedAt,
    evaluations: [],
    sells: [],
    errors: [],
  };

  try {
    const configs = db.listSwingConfigs(true);
    if (configs.length === 0) {
      return result;
    }

    for (const config of configs) {
      try {
        const evaluation = await evaluateSwingPosition(config);
        result.evaluations.push(evaluation);

        if (!evaluation.skipped && evaluation.trigger !== "none") {
          try {
            const sellResult = await executeSwingSell(config);
            result.sells.push(sellResult);
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            result.errors.push(`Sell failed for ${config.fleetName}/${config.coinAddress}: ${msg}`);
          }
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        result.errors.push(`Eval failed for ${config.fleetName}/${config.coinAddress}: ${msg}`);
      }
    }

    return result;
  } finally {
    result.finishedAt = new Date().toISOString();
    state.lastTick = result;
    state.isTicking = false;
  }
}

// ---------------------------------------------------------------------------
// Swing loop
// ---------------------------------------------------------------------------

export function startSwingLoop(intervalSec?: number): SwingLoopStatus {
  const sec = Math.max(10, intervalSec ?? 60);

  if (state.timer) clearInterval(state.timer);
  state.intervalSec = sec;
  state.running = true;

  state.timer = setInterval(() => {
    void runSwingTick().catch((error) => {
      const message = error instanceof Error ? error.message : "swing tick failed";
      logger.error({ err: error }, message);
    });
  }, sec * 1000);

  // Run immediately
  void runSwingTick().catch(() => {});

  return getSwingStatus();
}

export function stopSwingLoop(): SwingLoopStatus {
  if (state.timer) {
    clearInterval(state.timer);
    state.timer = null;
  }
  state.running = false;
  return getSwingStatus();
}

export function getSwingStatus(): SwingLoopStatus {
  return {
    running: state.running,
    intervalSec: state.intervalSec,
    isTicking: state.isTicking,
    lastTick: state.lastTick,
  };
}
