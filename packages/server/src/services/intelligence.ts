import { IntelligenceEngine } from "@fleet/intelligence";
import type { PollResult } from "@fleet/intelligence";
import { logger } from "../logger.js";

// ============================================================
// Singleton engine
// ============================================================

let engine: IntelligenceEngine | null = null;

export function initIntelligenceEngine(config?: {
  zoraApiKey?: string;
  zoraChainId?: number;
  dbPath?: string;
}): IntelligenceEngine {
  if (engine) return engine;

  const zoraApiKey = config?.zoraApiKey ?? process.env.ZORA_API_KEY;
  const zoraChainId = config?.zoraChainId ?? (process.env.ZORA_CHAIN_ID ? Number(process.env.ZORA_CHAIN_ID) : undefined);
  const dbPath = config?.dbPath
    ?? process.env.VITEST_INTEL_DB_PATH
    ?? process.env.ZORA_INTEL_DB_PATH
    ?? process.env.INTEL_DB_PATH
    ?? process.env.DB_PATH;

  // Parse optional alert threshold overrides from env
  const envNum = (key: string) => {
    const v = process.env[key];
    return v ? Number(v) : undefined;
  };

  const optionalNumbers = {
    alertCoinSwaps1h: envNum("ALERT_COIN_SWAPS_1H"),
    alertMinMomentum1h: envNum("ALERT_MIN_MOMENTUM_1H"),
    alertMinAcceleration1h: envNum("ALERT_MIN_ACCELERATION_1H"),
    alertAccelSpikeMinSwaps1h: envNum("ALERT_ACCEL_SPIKE_MIN_SWAPS_1H"),
    alertAccelSpikeMinAcceleration1h: envNum("ALERT_ACCEL_SPIKE_MIN_ACCELERATION_1H"),
    alertPerCoinCooldownMin: envNum("ALERT_PER_COIN_COOLDOWN_MIN"),
    alertNoveltyWindowHours: envNum("ALERT_NOVELTY_WINDOW_HOURS"),
    alertWhaleSwapUsd: envNum("ALERT_WHALE_SWAP_USD"),
  };

  engine = new IntelligenceEngine({
    ...(zoraApiKey ? { zoraApiKey } : {}),
    ...(zoraChainId !== undefined ? { zoraChainId } : {}),
    ...(dbPath ? { dbPath } : {}),
    ...Object.fromEntries(
      Object.entries(optionalNumbers).filter(([, value]) => value !== undefined),
    ),
  });

  logger.info({ dbPath: engine.config.dbPath }, "intelligence engine initialized");
  return engine;
}

export function getIntelligenceEngine(): IntelligenceEngine {
  if (!engine) {
    return initIntelligenceEngine();
  }
  return engine;
}

/** @internal Test-only: reset the singleton so it can be re-initialized. */
export function _resetEngine(): void {
  if (engine) {
    try {
      engine.close();
    } catch {
      // Best-effort test cleanup.
    }
  }
  engine = null;
}

// ============================================================
// Daemon state (mirrors autonomy.ts pattern)
// ============================================================

interface IntelligenceTickResult extends PollResult {
  startedAt: string;
  finishedAt: string;
  errors: string[];
}

export interface IntelligenceStatus {
  running: boolean;
  intervalSec: number;
  isTicking: boolean;
  lastTick: IntelligenceTickResult | null;
}

const state: {
  running: boolean;
  timer: NodeJS.Timeout | null;
  intervalSec: number;
  isTicking: boolean;
  lastTick: IntelligenceTickResult | null;
} = {
  running: false,
  timer: null,
  intervalSec: 60,
  isTicking: false,
  lastTick: null,
};

// ============================================================
// Tick + loop
// ============================================================

export async function runIntelligenceTick(): Promise<IntelligenceTickResult> {
  if (state.isTicking) throw new Error("Intelligence tick already in progress");
  state.isTicking = true;
  const startedAt = new Date().toISOString();
  const errors: string[] = [];

  try {
    const e = getIntelligenceEngine();
    const poll = await e.pollOnce();
    const result: IntelligenceTickResult = {
      ...poll,
      startedAt,
      finishedAt: new Date().toISOString(),
      errors,
    };
    state.lastTick = result;
    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : "intelligence tick failed";
    errors.push(message);
    const result: IntelligenceTickResult = {
      syncedRecent: 0,
      syncedTop: 0,
      swaps: 0,
      clusters: 0,
      analytics: 0,
      alerts: 0,
      startedAt,
      finishedAt: new Date().toISOString(),
      errors,
    };
    state.lastTick = result;
    throw err;
  } finally {
    state.isTicking = false;
  }
}

export function startIntelligenceLoop(input?: { intervalSec?: number }): IntelligenceStatus {
  const intervalSec = Math.max(10, input?.intervalSec ?? Number(process.env.INTELLIGENCE_INTERVAL_SEC ?? "60"));

  if (state.timer) clearInterval(state.timer);
  state.intervalSec = intervalSec;
  state.running = true;

  state.timer = setInterval(() => {
    void runIntelligenceTick().catch((err) => {
      logger.error({ err }, "intelligence tick failed");
    });
  }, intervalSec * 1000);

  // Run first tick immediately
  void runIntelligenceTick().catch((err) => {
    logger.error({ err }, "intelligence initial tick failed");
  });

  return getIntelligenceStatus();
}

export function stopIntelligenceLoop(): IntelligenceStatus {
  if (state.timer) {
    clearInterval(state.timer);
    state.timer = null;
  }
  state.running = false;
  return getIntelligenceStatus();
}

export function getIntelligenceStatus(): IntelligenceStatus {
  return {
    running: state.running,
    intervalSec: state.intervalSec,
    isTicking: state.isTicking,
    lastTick: state.lastTick,
  };
}
