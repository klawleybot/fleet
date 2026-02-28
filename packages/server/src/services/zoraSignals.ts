import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { isAddress } from "viem";

export type ZoraSignalMode = "top_momentum" | "watchlist_top";

export interface ZoraSignalCoin {
  coinAddress: `0x${string}`;
  symbol: string | null;
  name: string | null;
  momentumScore: number;
  swaps24h: number;
  netFlowUsd24h: number;
  volume24h: number;
  coinUrl: string;
}

function defaultDbPath() {
  // Resolve relative to the package root (packages/server), not cwd.
  const packageRoot = path.resolve(new URL(".", import.meta.url).pathname, "..", "..");
  return path.resolve(packageRoot, "../intelligence/.data/zora-intelligence.db");
}

function getDbPath() {
  return process.env.ZORA_INTEL_DB_PATH ?? defaultDbPath();
}

function ensureDbExists() {
  const dbPath = getDbPath();
  if (!fs.existsSync(dbPath)) {
    throw new Error(`zora-intelligence db not found at ${dbPath}`);
  }
  return dbPath;
}

function withZoraDb<T>(fn: (db: Database.Database) => T): T {
  const dbPath = ensureDbExists();
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

function withZoraDbWrite<T>(fn: (db: Database.Database) => T): T {
  const dbPath = ensureDbExists();
  const db = new Database(dbPath, { fileMustExist: true });
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

function coinUrl(chainId: number | null | undefined, coinAddress: string) {
  const chainSlug = Number(chainId) === 84532 ? "base-sepolia" : "base";
  return `https://zora.co/coin/${chainSlug}:${coinAddress.toLowerCase()}`;
}

export function topMovers(input?: { limit?: number; minMomentum?: number }): ZoraSignalCoin[] {
  const limit = Math.max(1, Math.min(50, input?.limit ?? 10));
  const minMomentum = Number(input?.minMomentum ?? 0);

  return withZoraDb((db) => {
    const rows = db
      .prepare(`
        SELECT a.coin_address, c.symbol, c.name, c.chain_id,
               COALESCE(a.momentum_score, 0) AS momentum_score,
               COALESCE(a.swap_count_24h, 0) AS swap_count_24h,
               COALESCE(a.net_flow_usdc_24h, 0) AS net_flow_usdc_24h,
               COALESCE(c.volume_24h, 0) AS volume_24h
        FROM coin_analytics a
        LEFT JOIN coins c ON c.address = a.coin_address
        WHERE COALESCE(a.momentum_score, 0) >= ?
        ORDER BY a.momentum_score DESC
        LIMIT ?
      `)
      .all(minMomentum, limit) as Array<any>;

    return rows
      .filter((r) => typeof r.coin_address === "string" && isAddress(r.coin_address))
      .map((r) => ({
        coinAddress: r.coin_address.toLowerCase() as `0x${string}`,
        symbol: r.symbol ?? null,
        name: r.name ?? null,
        momentumScore: Number(r.momentum_score ?? 0),
        swaps24h: Number(r.swap_count_24h ?? 0),
        netFlowUsd24h: Number(r.net_flow_usdc_24h ?? 0),
        volume24h: Number(r.volume_24h ?? 0),
        coinUrl: coinUrl(r.chain_id, r.coin_address),
      }));
  });
}

export function watchlistSignals(input?: { listName?: string; limit?: number }): ZoraSignalCoin[] {
  const limit = Math.max(1, Math.min(50, input?.limit ?? 10));
  const listName = input?.listName?.trim() || null;

  return withZoraDb((db) => {
    const rows = db
      .prepare(`
        SELECT w.coin_address, c.symbol, c.name, c.chain_id,
               COALESCE(a.momentum_score, 0) AS momentum_score,
               COALESCE(a.swap_count_24h, 0) AS swap_count_24h,
               COALESCE(a.net_flow_usdc_24h, 0) AS net_flow_usdc_24h,
               COALESCE(c.volume_24h, 0) AS volume_24h
        FROM coin_watchlist w
        LEFT JOIN coins c ON c.address = w.coin_address
        LEFT JOIN coin_analytics a ON a.coin_address = w.coin_address
        WHERE w.enabled = 1
          AND (? IS NULL OR w.list_name = ?)
        ORDER BY COALESCE(a.momentum_score, 0) DESC
        LIMIT ?
      `)
      .all(listName, listName, limit) as Array<any>;

    return rows
      .filter((r) => typeof r.coin_address === "string" && isAddress(r.coin_address))
      .map((r) => ({
        coinAddress: r.coin_address.toLowerCase() as `0x${string}`,
        symbol: r.symbol ?? null,
        name: r.name ?? null,
        momentumScore: Number(r.momentum_score ?? 0),
        swaps24h: Number(r.swap_count_24h ?? 0),
        netFlowUsd24h: Number(r.net_flow_usdc_24h ?? 0),
        volume24h: Number(r.volume_24h ?? 0),
        coinUrl: coinUrl(r.chain_id, r.coin_address),
      }));
  });
}

// --- P4: Momentum Intelligence ---

export interface PumpSignal {
  coinAddress: `0x${string}`;
  symbol: string | null;
  name: string | null;
  momentumAcceleration1h: number;
  netFlowUsdc1h: number;
  momentumScore: number;
  coinUrl: string;
}

export interface DipSignal {
  coinAddress: `0x${string}`;
  symbol: string | null;
  name: string | null;
  momentumAcceleration1h: number;
  netFlowUsdc1h: number;
  swapCount24h: number;
  momentumScore: number;
  coinUrl: string;
}

/**
 * Detect coins with pump signals — high acceleration + positive net flow.
 * Used to identify selling opportunities on coins the fleet holds.
 * @param coinAddresses - only check these coins (active positions)
 */
export function detectPumpSignals(input: {
  coinAddresses: `0x${string}`[];
  accelerationThreshold?: number;
  netFlowMinUsdc?: number;
}): PumpSignal[] {
  const threshold = input.accelerationThreshold ?? 3.0;
  const netFlowMin = input.netFlowMinUsdc ?? 0;

  if (input.coinAddresses.length === 0) return [];

  return withZoraDb((db) => {
    const placeholders = input.coinAddresses.map(() => "?").join(",");
    const rows = db
      .prepare(`
        SELECT a.coin_address, c.symbol, c.name, c.chain_id,
               COALESCE(a.momentum_acceleration_1h, 0) AS momentum_acceleration_1h,
               COALESCE(a.net_flow_usdc_1h, 0) AS net_flow_usdc_1h,
               COALESCE(a.momentum_score, 0) AS momentum_score
        FROM coin_analytics a
        LEFT JOIN coins c ON c.address = a.coin_address
        WHERE lower(a.coin_address) IN (${placeholders})
          AND COALESCE(a.momentum_acceleration_1h, 0) >= ?
          AND COALESCE(a.net_flow_usdc_1h, 0) >= ?
        ORDER BY a.momentum_acceleration_1h DESC
      `)
      .all(...input.coinAddresses.map((a) => a.toLowerCase()), threshold, netFlowMin) as Array<any>;

    return rows
      .filter((r) => typeof r.coin_address === "string" && isAddress(r.coin_address))
      .map((r) => ({
        coinAddress: r.coin_address.toLowerCase() as `0x${string}`,
        symbol: r.symbol ?? null,
        name: r.name ?? null,
        momentumAcceleration1h: Number(r.momentum_acceleration_1h),
        netFlowUsdc1h: Number(r.net_flow_usdc_1h),
        momentumScore: Number(r.momentum_score),
        coinUrl: coinUrl(r.chain_id, r.coin_address),
      }));
  });
}

/**
 * Detect coins showing dip signals — were active recently but decelerating with negative flow.
 * Checks watchlist + previously traded coins.
 * @param previouslyTradedAddresses - coins the fleet has traded before
 */
export function detectDipSignals(input: {
  previouslyTradedAddresses?: `0x${string}`[];
  accelerationThreshold?: number;
  minSwapCount24h?: number;
  listName?: string;
}): DipSignal[] {
  const threshold = input.accelerationThreshold ?? 0.5;
  const minSwaps = input.minSwapCount24h ?? 10;

  return withZoraDb((db) => {
    // Get watchlist coins with dip characteristics
    const watchlistRows = db
      .prepare(`
        SELECT a.coin_address, c.symbol, c.name, c.chain_id,
               COALESCE(a.momentum_acceleration_1h, 0) AS momentum_acceleration_1h,
               COALESCE(a.net_flow_usdc_1h, 0) AS net_flow_usdc_1h,
               COALESCE(a.swap_count_24h, 0) AS swap_count_24h,
               COALESCE(a.momentum_score, 0) AS momentum_score
        FROM coin_watchlist w
        JOIN coin_analytics a ON lower(a.coin_address) = lower(w.coin_address)
        LEFT JOIN coins c ON c.address = a.coin_address
        WHERE w.enabled = 1
          AND (? IS NULL OR w.list_name = ?)
          AND COALESCE(a.momentum_acceleration_1h, 0) <= ?
          AND COALESCE(a.swap_count_24h, 0) >= ?
          AND COALESCE(a.net_flow_usdc_1h, 0) < 0
        ORDER BY a.net_flow_usdc_1h ASC
      `)
      .all(
        input.listName ?? null,
        input.listName ?? null,
        threshold,
        minSwaps,
      ) as Array<any>;

    // Also check previously traded coins
    let tradedRows: Array<any> = [];
    if (input.previouslyTradedAddresses && input.previouslyTradedAddresses.length > 0) {
      const placeholders = input.previouslyTradedAddresses.map(() => "?").join(",");
      tradedRows = db
        .prepare(`
          SELECT a.coin_address, c.symbol, c.name, c.chain_id,
                 COALESCE(a.momentum_acceleration_1h, 0) AS momentum_acceleration_1h,
                 COALESCE(a.net_flow_usdc_1h, 0) AS net_flow_usdc_1h,
                 COALESCE(a.swap_count_24h, 0) AS swap_count_24h,
                 COALESCE(a.momentum_score, 0) AS momentum_score
          FROM coin_analytics a
          LEFT JOIN coins c ON c.address = a.coin_address
          WHERE lower(a.coin_address) IN (${placeholders})
            AND COALESCE(a.momentum_acceleration_1h, 0) <= ?
            AND COALESCE(a.swap_count_24h, 0) >= ?
            AND COALESCE(a.net_flow_usdc_1h, 0) < 0
          ORDER BY a.net_flow_usdc_1h ASC
        `)
        .all(
          ...input.previouslyTradedAddresses.map((a) => a.toLowerCase()),
          threshold,
          minSwaps,
        ) as Array<any>;
    }

    // Deduplicate by coin_address
    const seen = new Set<string>();
    const allRows = [...watchlistRows, ...tradedRows];
    const results: DipSignal[] = [];

    for (const r of allRows) {
      if (typeof r.coin_address !== "string" || !isAddress(r.coin_address)) continue;
      const addr = r.coin_address.toLowerCase();
      if (seen.has(addr)) continue;
      seen.add(addr);
      results.push({
        coinAddress: addr as `0x${string}`,
        symbol: r.symbol ?? null,
        name: r.name ?? null,
        momentumAcceleration1h: Number(r.momentum_acceleration_1h),
        netFlowUsdc1h: Number(r.net_flow_usdc_1h),
        swapCount24h: Number(r.swap_count_24h),
        momentumScore: Number(r.momentum_score),
        coinUrl: coinUrl(r.chain_id, r.coin_address),
      });
    }

    return results;
  });
}

/**
 * Calculate a discount factor (0.0-1.0) for own-cluster activity on a coin.
 * 1.0 = no own activity, lower = own wallets are inflating the signal.
 */
export function discountOwnActivity(
  coinAddress: `0x${string}`,
  clusterWalletAddresses: string[],
): number {
  if (clusterWalletAddresses.length === 0) return 1.0;

  return withZoraDb((db) => {
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const addr = coinAddress.toLowerCase();

    // Total swaps in last 1h for this coin
    const totalRow = db
      .prepare(`
        SELECT COUNT(*) AS cnt
        FROM coin_swaps
        WHERE lower(coin_address) = ?
          AND block_timestamp >= ?
      `)
      .get(addr, oneHourAgo) as { cnt: number } | undefined;

    const totalSwaps = totalRow?.cnt ?? 0;
    if (totalSwaps === 0) return 1.0;

    // Own swaps (sender_address matches any cluster wallet)
    const lowerAddresses = clusterWalletAddresses.map((a) => a.toLowerCase());
    const placeholders = lowerAddresses.map(() => "?").join(",");
    const ownRow = db
      .prepare(`
        SELECT COUNT(*) AS cnt
        FROM coin_swaps
        WHERE lower(coin_address) = ?
          AND block_timestamp >= ?
          AND lower(sender_address) IN (${placeholders})
      `)
      .get(addr, oneHourAgo, ...lowerAddresses) as { cnt: number } | undefined;

    const ownSwaps = ownRow?.cnt ?? 0;
    if (ownSwaps === 0) return 1.0;

    // Discount = 1 - (ownSwaps / totalSwaps)
    return Math.max(0, 1.0 - ownSwaps / totalSwaps);
  });
}

export function selectSignalCoin(input: {
  mode: ZoraSignalMode;
  listName?: string;
  minMomentum?: number;
}): ZoraSignalCoin {
  if (input.mode === "watchlist_top") {
    const list = watchlistSignals({
      ...(input.listName ? { listName: input.listName } : {}),
      limit: 1,
    });
    if (!list.length) throw new Error("No watchlist signal candidates found");
    return list[0]!;
  }

  const movers = topMovers({ limit: 1, minMomentum: input.minMomentum ?? 0 });
  if (!movers.length) throw new Error("No top-momentum signal candidates found");
  return movers[0]!;
}

export function getFleetWatchlistName(): string {
  return process.env.FLEET_WATCHLIST_NAME?.trim() || "Active Positions";
}

export function addToWatchlist(
  coinAddress: `0x${string}`,
  input?: { listName?: string; label?: string; notes?: string },
): void {
  const listName = input?.listName ?? getFleetWatchlistName();
  const addr = coinAddress.toLowerCase();
  const now = new Date().toISOString();

  withZoraDbWrite((db) => {
    db.prepare(`
      INSERT INTO coin_watchlist (list_name, coin_address, label, notes, enabled, created_at, updated_at)
      VALUES (?, ?, ?, ?, 1, ?, ?)
      ON CONFLICT(list_name, coin_address) DO UPDATE SET
        label = COALESCE(excluded.label, coin_watchlist.label),
        notes = COALESCE(excluded.notes, coin_watchlist.notes),
        enabled = 1,
        updated_at = excluded.updated_at
    `).run(listName, addr, input?.label ?? null, input?.notes ?? null, now, now);
  });
}

export function removeFromWatchlist(
  coinAddress: `0x${string}`,
  listName?: string,
): boolean {
  const list = listName ?? getFleetWatchlistName();
  const addr = coinAddress.toLowerCase();

  return withZoraDbWrite((db) => {
    const r = db.prepare(
      `UPDATE coin_watchlist SET enabled = 0, updated_at = ? WHERE list_name = ? AND lower(coin_address) = ?`,
    ).run(new Date().toISOString(), list, addr);
    return r.changes > 0;
  });
}

export function isCoinInWatchlist(coinAddress: `0x${string}`, listName?: string): boolean {
  return withZoraDb((db) => {
    const row = db
      .prepare(`
        SELECT 1 AS ok
        FROM coin_watchlist
        WHERE enabled = 1
          AND lower(coin_address) = lower(?)
          AND (? IS NULL OR list_name = ?)
        LIMIT 1
      `)
      .get(coinAddress, listName ?? null, listName ?? null) as { ok: number } | undefined;
    return Boolean(row?.ok);
  });
}
