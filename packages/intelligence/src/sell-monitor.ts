/**
 * sell-monitor.ts — Monitors open positions and triggers sells.
 *
 * Checks three exit conditions:
 * 1. PUMP: acceleration ≥ threshold → take profit (sell into strength)
 * 2. STOP LOSS: current value < entry * (1 - threshold) → cut losses
 * 3. TIME STOP: position age > threshold → don't hold bags forever
 *
 * Runs on a 15-min cron. Uses analytics DB for pump detection (free),
 * v4Quoter for value estimation (eth_call, no gas), and executes sells
 * via the fleet's swap pipeline.
 */

import {
  createPublicClient,
  http,
  formatEther,
  erc20Abi,
  type Address,
} from "viem";

// Coins that must NEVER be auto-sold
const NEVER_SELL: Set<string> = new Set([
  "0x4d70f5970b0b6b3edc7c9e6e4ceb69e8b8f9e642", // $CLAWD
]);
import { base } from "viem/chains";
import {
  getOpenPositions,
  recordSell,
  forceClosePosition,
  closeDb,
  type Position,
} from "./positions.js";
import { IntelligenceEngine } from "./engine.js";
import { formatSellAnnouncement } from "./scout-live.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const KLAWLEY_SA: Address = "0x097677d3e2cde65af10be80ae5e67b8b68eb613d";
const WETH: Address = "0x4200000000000000000000000000000000000006";
const BASE_CHAIN_ID = 8453;

interface SellPolicy {
  /** Sell when 1h acceleration exceeds this */
  pumpAcceleration: number;
  /** Sell when loss exceeds this fraction (0.2 = 20%) */
  stopLossFraction: number;
  /** Sell when position age exceeds this (hours) */
  timeStopHours: number;
  /** Slippage for sell execution */
  slippageBps: number;
  /** Skip sells below this ETH value (dust filter) */
  minSellValueEth: number;
  /** Minimum hold time before ANY sell trigger fires (minutes) */
  cooldownMinutes: number;
  /** Pump exit only fires if position is in profit by at least this % */
  pumpMinProfitPct: number;
  /** Take profit: sell immediately if up by this % regardless of acceleration */
  takeProfitPct: number;
}

const DEFAULT_SELL_POLICY: SellPolicy = {
  pumpAcceleration: 3.0,
  stopLossFraction: 0.20,   // 20% stop loss (was 30% — cut losers faster)
  timeStopHours: 24,        // 24h time stop (was 48h — don't hold dead weight)
  slippageBps: 300,
  minSellValueEth: 0.0001,
  cooldownMinutes: 30,      // Don't sell within 30 min of buying
  pumpMinProfitPct: 5.0,    // Pump exit only if we're up ≥5%
  takeProfitPct: 15.0,      // Sell immediately if up ≥15% (don't get greedy)
};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SellTrigger = "pump" | "stop_loss" | "time_stop";

export interface SellSignal {
  position: Position;
  trigger: SellTrigger;
  reason: string;
  acceleration: number | null;
  estimatedValueEth: bigint | null;
  estimatedPnlPct: number | null;
}

export interface SellResult {
  signal: SellSignal;
  executed: boolean;
  txHash: string | null;
  ethReceived: string;
  error?: string;
}

export interface MonitorReport {
  timestamp: string;
  positionsChecked: number;
  signals: SellSignal[];
  results: SellResult[];
  announcements: string[];
}

// ---------------------------------------------------------------------------
// Quoter — estimate sell value via eth_call
// ---------------------------------------------------------------------------

export async function estimateSellValue(
  coinAddress: Address,
  tokenAmount: bigint,
): Promise<bigint | null> {
  if (tokenAmount <= 0n) return 0n;

  try {
    // Lazy import server swap infrastructure
    const coinRouteMod = await import(
      new URL("../../server/src/services/coinRoute.js", import.meta.url).pathname
    );
    const quoterMod = await import(
      new URL("../../server/src/services/v4Quoter.js", import.meta.url).pathname
    );

    const client = createPublicClient({
      chain: base,
      transport: http(process.env.BASE_RPC_URL),
    });

    // Resolve route
    const route = await coinRouteMod.resolveCoinRoute({
      client,
      coinAddress,
    });

    // Try multi-hop quote first, fall back to sequential single-hop
    try {
      const quote = await quoterMod.quoteExactInput({
        chainId: BASE_CHAIN_ID,
        client,
        path: route.sellPath,
        poolParams: route.sellPoolParams,
        amountIn: tokenAmount,
        exactInput: true,
      });
      return quote.amountOut as bigint;
    } catch {
      // Sequential single-hop quoting for Doppler-hooked pools
      let currentAmount = tokenAmount;
      for (let i = 0; i < route.sellPoolParams.length; i++) {
        const hop = route.sellPoolParams[i]!;
        const tokenIn = route.sellPath[i]!;
        const tokenOut = route.sellPath[i + 1]!;
        const inNorm = tokenIn.toLowerCase();
        const outNorm = tokenOut.toLowerCase();
        const zeroForOne = inNorm < outNorm;
        const currency0 = zeroForOne ? tokenIn : tokenOut;
        const currency1 = zeroForOne ? tokenOut : tokenIn;

        const hopQuote = await quoterMod.quoteExactInputSingle({
          chainId: BASE_CHAIN_ID,
          client,
          poolKey: {
            currency0,
            currency1,
            fee: hop.fee,
            tickSpacing: hop.tickSpacing,
            hooks: hop.hooks,
          },
          zeroForOne,
          amountIn: currentAmount,
          hookData: hop.hookData ?? "0x",
        });
        currentAmount = hopQuote.amountOut;
      }
      return currentAmount;
    }
  } catch (err) {
    console.error(`[sell-monitor] Quote failed for ${coinAddress}:`, (err as Error).message?.slice(0, 100));
    return null;
  }
}

// ---------------------------------------------------------------------------
// Check positions
// ---------------------------------------------------------------------------

async function checkPosition(
  position: Position,
  policy: SellPolicy,
  engine: IntelligenceEngine,
): Promise<SellSignal | null> {
  const addr = position.coin_address;
  const tokenBalance = BigInt(position.token_balance);

  if (tokenBalance <= 0n) return null;

  // Use last_buy_at for timers — stacking buys resets the clock
  const timerRef = position.last_buy_at ?? position.created_at;
  const ageMs = Date.now() - new Date(timerRef).getTime();
  const ageHours = ageMs / (1000 * 60 * 60);
  const ageMinutes = ageMs / (1000 * 60);

  // --- Cooldown: don't sell anything within N minutes of buying ---
  // Exception: stop loss still fires during cooldown (protect capital)
  const inCooldown = ageMinutes < policy.cooldownMinutes;

  // --- Time stop (bypasses cooldown — stale is stale) ---
  if (ageHours >= policy.timeStopHours) {
    return {
      position,
      trigger: "time_stop",
      reason: `Position age ${ageHours.toFixed(1)}h exceeds ${policy.timeStopHours}h limit`,
      acceleration: null,
      estimatedValueEth: null,
      estimatedPnlPct: null,
    };
  }

  // --- Take profit: if up ≥15%, sell immediately (bypasses cooldown) ---
  if (!inCooldown) {
    const tpValueWei = await estimateSellValue(addr as Address, tokenBalance);
    if (tpValueWei !== null && tpValueWei > 0n) {
      const entryEth = BigInt(position.entry_eth_total);
      const exitSoFar = BigInt(position.exit_eth_total || "0");
      const remainingEntry = entryEth > exitSoFar ? entryEth - exitSoFar : 0n;
      if (remainingEntry > 0n) {
        const pnlPct = Number((tpValueWei - remainingEntry) * 10000n / remainingEntry) / 100;
        if (pnlPct >= policy.takeProfitPct) {
          return {
            position,
            trigger: "pump" as SellTrigger,
            reason: `Take profit: up ${pnlPct.toFixed(1)}% (threshold: ${policy.takeProfitPct}%) — locking in gains`,
            acceleration: null,
            estimatedValueEth: tpValueWei,
            estimatedPnlPct: pnlPct,
          };
        }
      }
    }
  }

  // --- Pump detection (from analytics DB, no RPC) ---
  const detail = engine.getCoinDetail(addr);
  const accel = Number(detail?.analytics?.momentum_acceleration_1h ?? 0);

  if (accel >= policy.pumpAcceleration && !inCooldown) {
    // Pump detected — but only sell if we're actually in profit.
    // If we're underwater, a pump is GOOD news (recovering), not a sell signal.
    // Quote current value to check P&L before deciding.
    const currentValueWei = await estimateSellValue(addr as Address, tokenBalance);
    if (currentValueWei !== null) {
      const entryEth = BigInt(position.entry_eth_total);
      const exitSoFar = BigInt(position.exit_eth_total || "0");
      const remainingEntry = entryEth > exitSoFar ? entryEth - exitSoFar : 0n;
      if (remainingEntry > 0n) {
        const pnlPct = Number((currentValueWei - remainingEntry) * 10000n / remainingEntry) / 100;
        if (pnlPct >= policy.pumpMinProfitPct) {
          return {
            position,
            trigger: "pump",
            reason: `Acceleration ${accel.toFixed(1)}x ≥ ${policy.pumpAcceleration}x, up ${pnlPct.toFixed(1)}% (min: ${policy.pumpMinProfitPct}%)`,
            acceleration: accel,
            estimatedValueEth: currentValueWei,
            estimatedPnlPct: pnlPct,
          };
        } else {
          console.log(`[sell-monitor] ${position.symbol || addr.slice(0, 10)}: pump detected (${accel.toFixed(1)}x) but P&L is ${pnlPct.toFixed(1)}% — holding (need ≥${policy.pumpMinProfitPct}%)`);
        }
      }
    } else {
      // Couldn't quote — fall through to pump exit anyway as safety valve
      // (better to take profit we can't measure than hold blindly)
      return {
        position,
        trigger: "pump",
        reason: `Acceleration ${accel.toFixed(1)}x ≥ ${policy.pumpAcceleration}x (quote failed, selling as safety)`,
        acceleration: accel,
        estimatedValueEth: null,
        estimatedPnlPct: null,
      };
    }
  } else if (inCooldown && accel >= policy.pumpAcceleration) {
    console.log(`[sell-monitor] ${position.symbol || addr.slice(0, 10)}: pump detected (${accel.toFixed(1)}x) but in cooldown (${ageMinutes.toFixed(0)}/${policy.cooldownMinutes}min) — holding`);
  }

  // --- Stop loss (needs quote) ---
  // Fires at any acceleration — with 20% threshold we can't afford to wait.
  // Stop loss fires even during cooldown — capital protection trumps patience.
  {
    const currentValueWei = await estimateSellValue(
      addr as Address,
      tokenBalance,
    );

    if (currentValueWei !== null) {
      const entryEth = BigInt(position.entry_eth_total);
      const exitSoFar = BigInt(position.exit_eth_total || "0");
      // Remaining cost basis = what we put in minus what we already got back
      const remainingEntry = entryEth > exitSoFar ? entryEth - exitSoFar : 0n;
      if (remainingEntry > 0n) {
        const lossFraction = Number(remainingEntry - currentValueWei) / Number(remainingEntry);
        const pnlPct = -lossFraction * 100;

        if (lossFraction >= policy.stopLossFraction) {
          return {
            position,
            trigger: "stop_loss",
            reason: `Down ${(lossFraction * 100).toFixed(1)}% (threshold: ${(policy.stopLossFraction * 100).toFixed(0)}%)`,
            acceleration: accel,
            estimatedValueEth: currentValueWei,
            estimatedPnlPct: pnlPct,
          };
        }
      }
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Execute sells
// ---------------------------------------------------------------------------

async function executeSell(
  signal: SellSignal,
  policy: SellPolicy,
): Promise<SellResult> {
  const position = signal.position;
  const tokenBalance = BigInt(position.token_balance);
  const coinAddress = position.coin_address as `0x${string}`;

  // Verify we actually hold the tokens (on-chain check)
  const client = createPublicClient({
    chain: base,
    transport: http(process.env.BASE_RPC_URL),
  });
  const onChainBalance = await client.readContract({
    address: coinAddress,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [KLAWLEY_SA],
  });

  // Use the smaller of DB balance and on-chain balance
  const sellAmount = onChainBalance < tokenBalance ? onChainBalance : tokenBalance;

  if (sellAmount <= 0n) {
    // On-chain balance is 0 but DB still shows tokens → ghost position, force-close it
    if (tokenBalance > 0n && onChainBalance <= 0n) {
      forceClosePosition(coinAddress, "on-chain balance is 0 (ghost position reconciliation)");
      console.log(`[sell-monitor] Force-closed ghost position: ${position.symbol || coinAddress}`);
    }
    return {
      signal,
      executed: false,
      txHash: null,
      ethReceived: "0",
      error: "No tokens to sell (on-chain balance is 0) — position force-closed",
    };
  }

  // Dust filter
  const estimatedEth = signal.estimatedValueEth ?? await estimateSellValue(coinAddress, sellAmount);
  if (estimatedEth !== null && Number(formatEther(estimatedEth)) < policy.minSellValueEth) {
    return {
      signal,
      executed: false,
      txHash: null,
      ethReceived: "0",
      error: `Estimated value ${formatEther(estimatedEth)} ETH below dust threshold`,
    };
  }

  console.log(`[sell-monitor] Executing sell: ${position.symbol || coinAddress} (${signal.trigger})`);
  console.log(`  Reason: ${signal.reason}`);
  console.log(`  Amount: ${formatEther(sellAmount)} tokens`);

  try {
    const serverPath = new URL("../../server/src/services/cdp.js", import.meta.url).pathname;
    const { swapFromSmartAccount } = await import(serverPath);

    const result = await swapFromSmartAccount({
      smartAccountName: "klawley",
      fromToken: coinAddress,
      toToken: WETH,
      fromAmount: sellAmount,
      slippageBps: policy.slippageBps,
    });

    if (result.status === "complete") {
      // Record in position tracker
      recordSell({
        coinAddress: position.coin_address,
        ethAmountWei: result.amountOut ?? "0",
        tokenAmount: sellAmount.toString(),
        txHash: result.txHash,
      });

      console.log(`  ✅ Sold | tx: ${result.txHash} | received: ${formatEther(BigInt(result.amountOut ?? "0"))} ETH`);

      // Post-sell reconciliation: check on-chain balance and force-close if dust/zero
      try {
        const postSellBalance = await client.readContract({
          address: coinAddress,
          abi: erc20Abi,
          functionName: "balanceOf",
          args: [KLAWLEY_SA],
        });
        if (postSellBalance <= 0n) {
          forceClosePosition(coinAddress, "post-sell reconciliation: on-chain balance is 0");
          console.log(`  [reconcile] Force-closed position after sell (on-chain balance = 0)`);
        }
      } catch (err) {
        console.warn(`  [reconcile] Failed to check post-sell balance: ${err instanceof Error ? err.message : err}`);
      }

      return {
        signal,
        executed: true,
        txHash: result.txHash,
        ethReceived: result.amountOut ?? "0",
      };
    } else {
      return {
        signal,
        executed: false,
        txHash: result.txHash,
        ethReceived: "0",
        error: `Swap status: ${result.status}`,
      };
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`  ❌ Sell failed: ${msg}`);
    return {
      signal,
      executed: false,
      txHash: null,
      ethReceived: "0",
      error: msg,
    };
  }
}

// ---------------------------------------------------------------------------
// Main monitor loop
// ---------------------------------------------------------------------------

export async function runSellMonitor(opts: {
  dryRun?: boolean;
  policy?: Partial<SellPolicy>;
} = {}): Promise<MonitorReport> {
  const dryRun = opts.dryRun ?? false;
  const policy = { ...DEFAULT_SELL_POLICY, ...opts.policy };

  console.log(`[sell-monitor] Starting${dryRun ? " (DRY RUN)" : ""}...`);

  const positions = getOpenPositions();
  if (positions.length === 0) {
    console.log("[sell-monitor] No open positions.");
    return {
      timestamp: new Date().toISOString(),
      positionsChecked: 0,
      signals: [],
      results: [],
      announcements: [],
    };
  }

  console.log(`[sell-monitor] Checking ${positions.length} open position(s)...`);

  // Initialize engine for analytics data
  const engine = new IntelligenceEngine({
    zoraApiKey: process.env.ZORA_API_KEY,
    zoraChainId: BASE_CHAIN_ID,
  });

  const signals: SellSignal[] = [];
  const results: SellResult[] = [];
  const announcements: string[] = [];

  try {
    // Check each position
    for (const pos of positions) {
      if (NEVER_SELL.has(pos.coin_address.toLowerCase())) {
        console.log(`[sell-monitor] ⛔ NEVER_SELL — skipping ${pos.symbol || pos.coin_address}`);
        continue;
      }
      const signal = await checkPosition(pos, policy, engine);
      if (signal) {
        signals.push(signal);
        console.log(`[sell-monitor] 🚨 ${signal.trigger.toUpperCase()} signal: ${pos.symbol || pos.coin_address.slice(0, 12)} — ${signal.reason}`);
      }
    }

    // Execute sells
    if (signals.length > 0) {
      for (const signal of signals) {
        if (dryRun) {
          console.log(`[sell-monitor] DRY RUN — would sell ${signal.position.symbol || signal.position.coin_address.slice(0, 12)}`);
          results.push({
            signal,
            executed: false,
            txHash: null,
            ethReceived: "0",
            error: "DRY RUN",
          });
        } else {
          const result = await executeSell(signal, policy);
          results.push(result);

          if (result.executed) {
            const pos = signal.position;
            const entryEth = pos.entry_eth_total;
            const exitEth = (BigInt(pos.exit_eth_total) + BigInt(result.ethReceived)).toString();
            const entry = BigInt(entryEth);
            const exit = BigInt(exitEth);
            const pnlPct = entry > 0n ? Number((exit - entry) * 10000n / entry) / 100 : 0;

            const ann = formatSellAnnouncement(
              pos.symbol || pos.coin_address.slice(0, 10),
              entryEth,
              exitEth,
              pnlPct,
              `https://zora.co/coin/base:${pos.coin_address}`,
              result.txHash,
            );
            announcements.push(ann);
          }

          // Delay between sells
          await new Promise(r => setTimeout(r, 2000));
        }
      }
    }
  } finally {
    engine.close();
  }

  const report: MonitorReport = {
    timestamp: new Date().toISOString(),
    positionsChecked: positions.length,
    signals,
    results,
    announcements,
  };

  console.log(`[sell-monitor] Done. Checked: ${positions.length} | Signals: ${signals.length} | Executed: ${results.filter(r => r.executed).length}`);
  return report;
}

// ---------------------------------------------------------------------------
// Report formatting
// ---------------------------------------------------------------------------

export function formatMonitorReport(report: MonitorReport): string {
  if (report.signals.length === 0) {
    return `🛡️ Sell monitor: ${report.positionsChecked} position(s) checked, all holding steady.`;
  }

  const lines: string[] = [
    `🛡️ **Sell Monitor** — ${new Date(report.timestamp).toUTCString()}`,
    `Positions checked: ${report.positionsChecked} | Signals: ${report.signals.length}`,
    "",
  ];

  for (const result of report.results) {
    const sym = result.signal.position.symbol || "???";
    const trigger = result.signal.trigger.replace("_", " ").toUpperCase();
    if (result.executed) {
      const ethStr = Number(formatEther(BigInt(result.ethReceived))).toFixed(6);
      lines.push(`✅ **${sym}** — SOLD (${trigger}) → ${ethStr} ETH`);
    } else if (result.error === "DRY RUN") {
      lines.push(`🏜️ **${sym}** — would sell (${trigger}): ${result.signal.reason}`);
    } else {
      lines.push(`❌ **${sym}** — sell failed (${trigger}): ${result.error?.slice(0, 60)}`);
    }
    lines.push(`  ${result.signal.reason}`);
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  if (dryRun) console.log("🏜️ DRY RUN MODE\n");

  const report = await runSellMonitor({ dryRun });
  console.log("\n" + formatMonitorReport(report));

  if (report.announcements.length > 0) {
    console.log("\n--- ANNOUNCEMENTS ---");
    for (const a of report.announcements) console.log(a + "\n");
  }

  closeDb();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error("Fatal:", err);
    process.exit(1);
  });
}
