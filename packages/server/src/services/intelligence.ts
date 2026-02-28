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
}): IntelligenceEngine {
  if (engine) return engine;

  const zoraApiKey = config?.zoraApiKey ?? process.env.ZORA_API_KEY;
  const zoraChainId = config?.zoraChainId ?? (process.env.ZORA_CHAIN_ID ? Number(process.env.ZORA_CHAIN_ID) : undefined);

  engine = new IntelligenceEngine({
    ...(zoraApiKey ? { zoraApiKey } : {}),
    ...(zoraChainId ? { zoraChainId } : {}),
  });

  logger.info({ dbPath: engine.config.dbPath }, "intelligence engine initialized");
  return engine;
}

export function getIntelligenceEngine(): IntelligenceEngine {
  if (!engine) throw new Error("Intelligence engine not initialized — call initIntelligenceEngine() first");
  return engine;
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
