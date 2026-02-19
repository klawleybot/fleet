import { db } from "../db/index.js";
import { evaluateAutoApproval, getAutoApprovalPolicy } from "./approval.js";
import { approveAndExecuteOperation, requestSupportFromZoraSignal } from "./operations.js";
import type { OperationRecord, StrategyMode } from "../types.js";
import type { ZoraSignalMode } from "./zoraSignals.js";

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

    if (config.clusterIds.length === 0) {
      result.skipped.push({ reason: "AUTONOMY_CLUSTER_IDS is empty" });
    } else if (config.createRequests) {
      for (const clusterId of config.clusterIds) {
        try {
          if (db.hasOpenOperationForCluster(clusterId)) {
            result.skipped.push({ reason: `cluster ${clusterId} has open operation` });
            continue;
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
