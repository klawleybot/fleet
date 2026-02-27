import { db } from "../db/index.js";
import { evaluateAutoApproval, getAutoApprovalPolicy } from "./approval.js";
import { approveAndExecuteOperation, requestSupportFromZoraSignal, requestExitCoinOperation, requestSupportCoinOperation } from "./operations.js";
import { getWalletBudgets } from "./balance.js";
import type { OperationRecord, StrategyMode } from "../types.js";
import type { ZoraSignalMode } from "./zoraSignals.js";
import { detectPumpSignals, detectDipSignals, discountOwnActivity } from "./zoraSignals.js";

/** Max age (seconds) an operation can sit in 'executing' before we consider it stale and mark it failed. */
const STALE_EXECUTING_TIMEOUT_SEC = 300; // 5 minutes

interface AutonomyConfig {
  enabled: boolean;
  autoStart: boolean;
  intervalSec: number;
  clusterIds: number[];
  signalMode: ZoraSignalMode;
  watchlistName: string | null;
  minMomentum: number | null;
  totalAmountWei: string;
  slippageBps: number;
  strategyMode: StrategyMode | null;
  requestedBy: string;
  createRequests: boolean;
  autoApprovePending: boolean;
}

interface TickResult {
  startedAt: string;
  finishedAt: string;
  createdOperationIds: number[];
  executedOperationIds: number[];
  skipped: Array<{ operationId?: number; reason: string }>;
  errors: string[];
}

const state: {
  running: boolean;
  timer: NodeJS.Timeout | null;
  intervalSec: number;
  isTicking: boolean;
  lastTick: TickResult | null;
} = {
  running: false,
  timer: null,
  intervalSec: 90,
  isTicking: false,
  lastTick: null,
};

function parseBool(value: string | undefined, fallback: boolean): boolean {
  if (!value) return fallback;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}

function parseIntSafe(value: string | undefined, fallback: number): number {
  if (!value?.trim()) return fallback;
  const n = Number.parseInt(value, 10);
  if (Number.isNaN(n)) return fallback;
  return n;
}

function parseClusterIds(value: string | undefined): number[] {
  if (!value?.trim()) return [];
  return [...new Set(value.split(",").map((v) => Number.parseInt(v.trim(), 10)).filter((n) => Number.isInteger(n) && n > 0))];
}

export function getAutonomyConfig(): AutonomyConfig {
  const signalModeRaw = (process.env.AUTONOMY_SIGNAL_MODE ?? "watchlist_top").trim().toLowerCase();
  const signalMode: ZoraSignalMode = signalModeRaw === "top_momentum" ? "top_momentum" : "watchlist_top";

  const strategyRaw = process.env.AUTONOMY_STRATEGY_MODE?.trim().toLowerCase();
  const strategyMode: StrategyMode | null =
    strategyRaw === "sync" || strategyRaw === "staggered" || strategyRaw === "momentum"
      ? strategyRaw
      : null;

  const minMomentumRaw = process.env.AUTONOMY_MIN_MOMENTUM?.trim();
  const minMomentum = minMomentumRaw ? Number(minMomentumRaw) : null;

  const pumpThresholdRaw = process.env.AUTONOMY_PUMP_THRESHOLD?.trim();
  const dipThresholdRaw = process.env.AUTONOMY_DIP_THRESHOLD?.trim();

  return {
    enabled: parseBool(process.env.AUTONOMY_ENABLED, false),
    autoStart: parseBool(process.env.AUTONOMY_AUTO_START, false),
    intervalSec: Math.max(10, parseIntSafe(process.env.AUTONOMY_INTERVAL_SEC, 90)),
    clusterIds: parseClusterIds(process.env.AUTONOMY_CLUSTER_IDS),
    signalMode,
    watchlistName: process.env.AUTONOMY_WATCHLIST_NAME?.trim() || null,
    minMomentum: minMomentum !== null && !Number.isNaN(minMomentum) ? minMomentum : null,
    totalAmountWei: process.env.AUTONOMY_TOTAL_AMOUNT_WEI?.trim() || "100000000000000",
    slippageBps: Math.max(1, parseIntSafe(process.env.AUTONOMY_SLIPPAGE_BPS, 100)),
    strategyMode,
    requestedBy: process.env.AUTONOMY_REQUESTED_BY?.trim() || "autonomy-worker",
    createRequests: parseBool(process.env.AUTONOMY_CREATE_REQUESTS, true),
    autoApprovePending: parseBool(process.env.AUTONOMY_AUTO_APPROVE_PENDING, true),
    pumpThreshold: pumpThresholdRaw ? Number(pumpThresholdRaw) : 3.0,
    dipThreshold: dipThresholdRaw ? Number(dipThresholdRaw) : 0.5,
    ownDiscountEnabled: parseBool(process.env.AUTONOMY_OWN_DISCOUNT_ENABLED, true),
  };
}

function pendingOperations(limit = 100): OperationRecord[] {
  return db.listOperationsByStatus("pending", limit);
}

export async function runAutonomyTick(): Promise<TickResult> {
  if (state.isTicking) {
    throw new Error("Autonomy tick already in progress");
  }
  state.isTicking = true;

  const startedAt = new Date().toISOString();
  const config = getAutonomyConfig();
  const result: TickResult = {
    startedAt,
    finishedAt: startedAt,
    createdOperationIds: [],
    executedOperationIds: [],
    skipped: [],
    errors: [],
  };

  try {
    if (!config.enabled) {
      result.skipped.push({ reason: "AUTONOMY_ENABLED is false" });
      return result;
    }

    // --- Housekeeping: mark stale 'executing' ops as failed ---
    const staleOps = db.listStaleExecutingOperations(STALE_EXECUTING_TIMEOUT_SEC);
    for (const staleOp of staleOps) {
      db.updateOperationStatus(staleOp.id, "failed", `Timed out after ${STALE_EXECUTING_TIMEOUT_SEC}s in executing state`);
      result.errors.push(`operation ${staleOp.id} marked failed (stale executing)`);
    }

    if (config.clusterIds.length === 0) {
      result.skipped.push({ reason: "AUTONOMY_CLUSTER_IDS is empty" });
    } else if (config.createRequests) {
      for (const clusterId of config.clusterIds) {
        try {
          if (db.hasOpenOperationForCluster(clusterId)) {
            result.skipped.push({ reason: `cluster ${clusterId} has open operation` });
            continue;
          }

          // Pre-check cooldown before creating an op that would just get stuck
          const lastOpAge = db.getLatestClusterOperationAgeSec(clusterId);
          const cooldownSec = parseInt(process.env.CLUSTER_COOLDOWN_SEC ?? "45", 10);
          if (lastOpAge !== null && lastOpAge < cooldownSec) {
            result.skipped.push({ reason: `cluster ${clusterId} cooldown (${lastOpAge}s/${cooldownSec}s)` });
            continue;
          }

          // Pre-check cluster buy budget — skip if wallets have no ETH
          // (skipped in mock mode since test wallets have no real balance)
          if (process.env.CDP_MOCK_MODE !== "1") {
            const clusterWalletRows = db.listClusterWalletDetails(clusterId);
            const budgets = await getWalletBudgets(
              clusterWalletRows.map((w) => ({ id: w.id, address: w.address as `0x${string}` })),
            );
            const requestedWei = BigInt(config.totalAmountWei);
            const perWalletTarget = requestedWei / BigInt(clusterWalletRows.length || 1);
            // Count wallets that can actually cover their per-wallet share
            const tradeReady = budgets.wallets.filter((w) => w.balance >= perWalletTarget).length;
            if (tradeReady === 0) {
              const maxBal = budgets.wallets.reduce((m, w) => w.balance > m ? w.balance : m, 0n);
              result.skipped.push({
                reason: `cluster ${clusterId} no wallets can cover per-wallet amount (need ${(Number(perWalletTarget) / 1e18).toFixed(6)} ETH/wallet, max balance ${(Number(maxBal) / 1e18).toFixed(6)} ETH)`,
              });
              continue;
            }
          }

          const operation = requestSupportFromZoraSignal({
            clusterId,
            mode: config.signalMode,
            ...(config.watchlistName ? { listName: config.watchlistName } : {}),
            ...(config.minMomentum !== null ? { minMomentum: config.minMomentum } : {}),
            totalAmountWei: config.totalAmountWei,
            slippageBps: config.slippageBps,
            ...(config.strategyMode ? { strategyMode: config.strategyMode } : {}),
            requestedBy: config.requestedBy,
          });
          result.createdOperationIds.push(operation.id);
        } catch (error) {
          const message = error instanceof Error ? error.message : "unknown cluster creation error";
          result.errors.push(`cluster ${clusterId}: ${message}`);
        }
      }
    }

    // --- P4: Momentum intelligence — pump/dip detection ---
    for (const clusterId of config.clusterIds) {
      try {
        // Get cluster wallet addresses for own-activity discount
        const clusterWallets = db.listClusterWalletDetails(clusterId);
        const walletAddresses = clusterWallets.map((w) => w.address);

        // Pump detection: check active positions for sell opportunities
        const positions = db.listPositionsByCluster(clusterId);
        const heldCoins = [...new Set(
          positions
            .filter((p) => BigInt(p.holdingsRaw) > 0n)
            .map((p) => p.coinAddress),
        )];

        if (heldCoins.length > 0) {
          const pumpSignals = detectPumpSignals({
            coinAddresses: heldCoins,
            accelerationThreshold: config.pumpThreshold,
          });

          for (const signal of pumpSignals) {
            let discount = 1.0;
            if (config.ownDiscountEnabled) {
              discount = discountOwnActivity(signal.coinAddress, walletAddresses);
            }
            // Skip if most activity is our own (discount < 0.3)
            if (discount < 0.3) {
              result.skipped.push({ reason: `pump signal ${signal.coinAddress} discounted (own activity ${((1 - discount) * 100).toFixed(0)}%)` });
              continue;
            }

            if (db.hasOpenOperationForCluster(clusterId)) {
              result.skipped.push({ reason: `cluster ${clusterId} has open operation (pump sell)` });
              break;
            }

            try {
              // Find total holdings to sell
              const coinPositions = positions.filter((p) => p.coinAddress === signal.coinAddress && BigInt(p.holdingsRaw) > 0n);
              const totalHoldings = coinPositions.reduce((sum, p) => sum + BigInt(p.holdingsRaw), 0n);
              if (totalHoldings <= 0n) continue;

              const operation = requestExitCoinOperation({
                clusterId,
                coinAddress: signal.coinAddress,
                totalAmountWei: totalHoldings.toString(),
                slippageBps: config.slippageBps,
                ...(config.strategyMode ? { strategyMode: config.strategyMode } : {}),
                requestedBy: `${config.requestedBy}:pump`,
              });
              result.createdOperationIds.push(operation.id);
            } catch (error) {
              const message = error instanceof Error ? error.message : "pump sell error";
              result.errors.push(`cluster ${clusterId} pump sell ${signal.coinAddress}: ${message}`);
            }
          }
        }

        // Dip detection: check for buy opportunities
        const previouslyTraded = [...new Set(positions.map((p) => p.coinAddress))];
        const dipSignals = detectDipSignals({
          previouslyTradedAddresses: previouslyTraded,
          accelerationThreshold: config.dipThreshold,
          ...(config.watchlistName ? { listName: config.watchlistName } : {}),
        });

        for (const signal of dipSignals) {
          let discount = 1.0;
          if (config.ownDiscountEnabled) {
            discount = discountOwnActivity(signal.coinAddress, walletAddresses);
          }
          if (discount < 0.3) {
            result.skipped.push({ reason: `dip signal ${signal.coinAddress} discounted (own activity ${((1 - discount) * 100).toFixed(0)}%)` });
            continue;
          }

          if (db.hasOpenOperationForCluster(clusterId)) {
            result.skipped.push({ reason: `cluster ${clusterId} has open operation (dip buy)` });
            break;
          }

          // Dip buys need budget — check cluster wallets (skip in mock mode)
          if (process.env.CDP_MOCK_MODE !== "1") {
            const dipBudgets = await getWalletBudgets(
              clusterWallets.map((w) => ({ id: w.id, address: w.address as `0x${string}` })),
            );
            const dipPerWallet = BigInt(config.totalAmountWei) / BigInt(clusterWallets.length || 1);
            const dipReady = dipBudgets.wallets.filter((w) => w.balance >= dipPerWallet).length;
            if (dipReady === 0) {
              result.skipped.push({ reason: `cluster ${clusterId} no wallets can cover dip buy (need ${(Number(dipPerWallet) / 1e18).toFixed(6)} ETH/wallet)` });
              break;
            }
          }

          try {
            const operation = requestSupportCoinOperation({
              clusterId,
              coinAddress: signal.coinAddress,
              totalAmountWei: config.totalAmountWei,
              slippageBps: config.slippageBps,
              ...(config.strategyMode ? { strategyMode: config.strategyMode } : {}),
              requestedBy: `${config.requestedBy}:dip`,
            });
            result.createdOperationIds.push(operation.id);
          } catch (error) {
            const message = error instanceof Error ? error.message : "dip buy error";
            result.errors.push(`cluster ${clusterId} dip buy ${signal.coinAddress}: ${message}`);
          }
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : "momentum intel error";
        result.errors.push(`cluster ${clusterId} momentum: ${message}`);
      }
    }

    if (config.autoApprovePending) {
      const approver = getAutoApprovalPolicy().approver;
      for (const operation of pendingOperations(200)) {
        const decision = evaluateAutoApproval(operation);
        if (!decision.allow) {
          result.skipped.push({ operationId: operation.id, reason: decision.reason });
          continue;
        }

        try {
          const executed = await approveAndExecuteOperation({ operationId: operation.id, approvedBy: approver });
          if (executed.status === "complete") {
            result.executedOperationIds.push(executed.id);
          } else {
            result.skipped.push({ operationId: operation.id, reason: `execution status=${executed.status}` });
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : "unknown execution error";
          result.errors.push(`operation ${operation.id}: ${message}`);
        }
      }
    }

    return result;
  } finally {
    result.finishedAt = new Date().toISOString();
    state.lastTick = result;
    state.isTicking = false;
  }
}

export function getAutonomyStatus() {
  return {
    running: state.running,
    intervalSec: state.intervalSec,
    isTicking: state.isTicking,
    config: getAutonomyConfig(),
    lastTick: state.lastTick,
  };
}

export function startAutonomyLoop(input?: { intervalSec?: number }) {
  const cfg = getAutonomyConfig();
  if (!cfg.enabled) {
    throw new Error("AUTONOMY_ENABLED is false");
  }

  const intervalSec = Math.max(10, input?.intervalSec ?? cfg.intervalSec);

  if (state.timer) clearInterval(state.timer);
  state.intervalSec = intervalSec;
  state.running = true;

  state.timer = setInterval(() => {
    void runAutonomyTick().catch((error) => {
      const message = error instanceof Error ? error.message : "tick failed";
      state.lastTick = {
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        createdOperationIds: [],
        executedOperationIds: [],
        skipped: [],
        errors: [message],
      };
    });
  }, intervalSec * 1000);

  void runAutonomyTick().catch(() => {});

  return getAutonomyStatus();
}

export function stopAutonomyLoop() {
  if (state.timer) {
    clearInterval(state.timer);
    state.timer = null;
  }
  state.running = false;
  return getAutonomyStatus();
}
