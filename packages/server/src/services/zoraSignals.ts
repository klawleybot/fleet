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
  return path.resolve(process.cwd(), "../../zora-intelligence/data/zora-intelligence.db");
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
