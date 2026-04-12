import { env } from "./config.js";
import { IntelligenceEngine } from "./engine.js";
export type { DispatchAlertsRich } from "./engine.js";

type FirstKnownCoinRow = {
  address: string;
  symbol: string | null;
  name: string | null;
  created_at: string | null;
  volume_24h: number | null;
  market_cap: number | null;
  coin_url: string | null;
};

type LegacyQueryRow = Record<string, unknown>;
type WatchlistMutation = {
  listName: string;
  coinAddress: string;
  coinUrl: string | null;
};

let engine: IntelligenceEngine | null = null;

function createEngine(): IntelligenceEngine {
  return new IntelligenceEngine({
    dbPath: env.DB_PATH,
    zoraApiKey: env.ZORA_API_KEY,
    zoraChainId: env.ZORA_CHAIN_ID,
    pollIntervalSec: env.POLL_INTERVAL_SEC,
    swapsPerCoin: env.SWAPS_PER_COIN,
    trackedCoinCount: env.TRACKED_COIN_COUNT,
    clusterMinInteractions: env.CLUSTER_MIN_INTERACTIONS,
    alertWhaleSwapUsd: env.ALERT_WHALE_SWAP_USD,
    alertCoinSwaps24h: env.ALERT_COIN_SWAPS_24H,
    alertCoinSwaps1h: env.ALERT_COIN_SWAPS_1H,
    alertMinMomentum1h: env.ALERT_MIN_MOMENTUM_1H,
    alertMinAcceleration1h: env.ALERT_MIN_ACCELERATION_1H,
    alertMaxCoinAlertsPerRun: env.ALERT_MAX_COIN_ALERTS_PER_RUN,
    alertDiversityMode: env.ALERT_DIVERSITY_MODE,
    alertPerCoinCooldownMin: env.ALERT_PER_COIN_COOLDOWN_MIN,
    alertMaxPerCoinPerDispatch: env.ALERT_MAX_PER_COIN_PER_DISPATCH,
    alertNoveltyWindowHours: env.ALERT_NOVELTY_WINDOW_HOURS,
    alertLargeCapPenaltyAboveUsd: env.ALERT_LARGE_CAP_PENALTY_ABOVE_USD,
    watchlistMinSwapUsd: env.WATCHLIST_MIN_SWAP_USD,
    watchlistMinSwaps1h: env.WATCHLIST_MIN_SWAPS_1H,
    watchlistMinNetFlowUsd1h: env.WATCHLIST_MIN_NET_FLOW_USD_1H,
    watchlistMinSwaps24h: env.WATCHLIST_MIN_SWAPS_24H,
    watchlistMinNetFlowUsd24h: env.WATCHLIST_MIN_NET_FLOW_USD_24H,
  });
}

function getEngine(): IntelligenceEngine {
  engine ??= createEngine();
  return engine;
}

function writeLine(message: string): void {
  process.stdout.write(`${message}\n`);
}

export async function syncRecentCoins(count = 100): Promise<number> {
  return getEngine().syncRecentCoins(count);
}

export async function syncTopVolumeCoins(count = 100): Promise<number> {
  return getEngine().syncTopVolumeCoins(count);
}

export async function ingestCoinSwapsForTrackedCoins(
  coinLimit = env.TRACKED_COIN_COUNT,
  swapsPerCoin = env.SWAPS_PER_COIN,
): Promise<number> {
  return getEngine().ingestSwaps(coinLimit, swapsPerCoin);
}

export function rebuildAddressClusters(): number {
  return getEngine().rebuildClusters();
}

export function refreshCoinAnalytics(): number {
  return getEngine().refreshAnalytics();
}

export function generateAlerts(): number {
  return getEngine().generateAlerts();
}

export async function pollOnce() {
  return getEngine().pollOnce();
}

export async function runPollingLoop(): Promise<void> {
  writeLine(`Starting polling loop interval=${env.POLL_INTERVAL_SEC}s`);
  while (true) {
    try {
      const result = await pollOnce();
      writeLine(`[poll] ${new Date().toISOString()} ${JSON.stringify(result)}`);
    } catch (error) {
      console.error("[poll] tick failed:", error);
    }
    await new Promise((resolve) => setTimeout(resolve, env.POLL_INTERVAL_SEC * 1000));
  }
}

export function recentCoins(limit = 20): LegacyQueryRow[] {
  return getEngine().recentCoins(limit) as unknown as LegacyQueryRow[];
}

export function firstKnownCoin(): FirstKnownCoinRow | undefined {
  return getEngine().db.prepare<[], FirstKnownCoinRow>(`
    SELECT address, symbol, name, created_at, volume_24h, market_cap,
           CASE WHEN chain_id = 84532 THEN 'https://zora.co/coin/base-sepolia:' || lower(address)
                ELSE 'https://zora.co/coin/base:' || lower(address)
           END AS coin_url
    FROM coins
    ORDER BY datetime(created_at) ASC
    LIMIT 1
  `).get();
}

export function topVolumeCoins(limit = 20): LegacyQueryRow[] {
  return getEngine().topVolumeCoins(limit) as unknown as LegacyQueryRow[];
}

export function topAnalytics(limit = 20): LegacyQueryRow[] {
  return getEngine().topAnalytics(limit) as unknown as LegacyQueryRow[];
}

export function watchlistAddCoin(
  coinAddress: string,
  listName = "default",
  label?: string,
  notes?: string,
): WatchlistMutation {
  return getEngine().watchlistAdd(coinAddress, listName, label, notes) as WatchlistMutation;
}

export function watchlistRemoveCoin(coinAddress: string, listName = "default"): number {
  return getEngine().watchlistRemove(coinAddress, listName);
}

export function watchlistList(listName = "default"): LegacyQueryRow[] {
  return getEngine().watchlistList(listName) as unknown as LegacyQueryRow[];
}

export function watchlistRecentMoves(listName = "default", limit = 25): LegacyQueryRow[] {
  return getEngine().watchlistMoves(listName, limit) as unknown as LegacyQueryRow[];
}

export function latestAlerts(limit = 20): LegacyQueryRow[] {
  return getEngine().latestAlerts(limit) as unknown as LegacyQueryRow[];
}

export async function dispatchPendingAlerts(limit = 12): Promise<string | null> {
  return getEngine().dispatchPendingAlerts(limit);
}

export async function dispatchPendingAlertsRich(limit = 12) {
  return getEngine().dispatchPendingAlertsRich(limit);
}
