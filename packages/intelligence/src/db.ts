import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { env } from "./config.js";

for (const p of [path.dirname(env.DB_PATH), "./logs", "./runtime", "./data"]) {
  fs.mkdirSync(p, { recursive: true });
}

export const db = new Database(env.DB_PATH);
db.pragma("journal_mode = WAL");

db.exec(`
CREATE TABLE IF NOT EXISTS coins (
  address TEXT PRIMARY KEY,
  name TEXT,
  symbol TEXT,
  coin_type TEXT,
  creator_address TEXT,
  created_at TEXT,
  market_cap REAL,
  volume_24h REAL,
  total_volume REAL,
  chain_id INTEGER,
  raw_json TEXT NOT NULL,
  indexed_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS coin_swaps (
  id TEXT PRIMARY KEY,
  coin_address TEXT NOT NULL,
  chain_id INTEGER,
  tx_hash TEXT,
  block_timestamp TEXT,
  activity_type TEXT,
  sender_address TEXT,
  recipient_address TEXT,
  amount_decimal REAL,
  amount_usdc REAL,
  coin_amount REAL,
  raw_json TEXT NOT NULL,
  indexed_at TEXT NOT NULL,
  UNIQUE(coin_address, tx_hash, sender_address, recipient_address, block_timestamp)
);

CREATE TABLE IF NOT EXISTS addresses (
  address TEXT PRIMARY KEY,
  first_seen_at TEXT,
  last_seen_at TEXT,
  swap_count INTEGER NOT NULL DEFAULT 0,
  buy_count INTEGER NOT NULL DEFAULT 0,
  sell_count INTEGER NOT NULL DEFAULT 0,
  volume_usdc REAL NOT NULL DEFAULT 0,
  last_profile_handle TEXT,
  intelligence_score REAL NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS address_interactions (
  a_address TEXT NOT NULL,
  b_address TEXT NOT NULL,
  interaction_count INTEGER NOT NULL DEFAULT 0,
  last_seen_at TEXT,
  PRIMARY KEY (a_address, b_address)
);

CREATE TABLE IF NOT EXISTS address_clusters (
  id TEXT PRIMARY KEY,
  heuristic TEXT NOT NULL,
  label TEXT,
  member_count INTEGER NOT NULL,
  score REAL NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS address_cluster_members (
  cluster_id TEXT NOT NULL,
  address TEXT NOT NULL,
  weight REAL NOT NULL DEFAULT 1,
  PRIMARY KEY (cluster_id, address)
);

CREATE TABLE IF NOT EXISTS coin_analytics (
  coin_address TEXT PRIMARY KEY,
  swap_count_1h INTEGER NOT NULL DEFAULT 0,
  unique_traders_1h INTEGER NOT NULL DEFAULT 0,
  buy_count_1h INTEGER NOT NULL DEFAULT 0,
  sell_count_1h INTEGER NOT NULL DEFAULT 0,
  buy_volume_usdc_1h REAL NOT NULL DEFAULT 0,
  sell_volume_usdc_1h REAL NOT NULL DEFAULT 0,
  net_flow_usdc_1h REAL NOT NULL DEFAULT 0,
  swap_count_prev_1h INTEGER NOT NULL DEFAULT 0,
  momentum_score_1h REAL NOT NULL DEFAULT 0,
  momentum_acceleration_1h REAL NOT NULL DEFAULT 0,
  swap_count_24h INTEGER NOT NULL,
  unique_traders_24h INTEGER NOT NULL,
  buy_count_24h INTEGER NOT NULL,
  sell_count_24h INTEGER NOT NULL,
  buy_volume_usdc_24h REAL NOT NULL,
  sell_volume_usdc_24h REAL NOT NULL,
  net_flow_usdc_24h REAL NOT NULL,
  momentum_score REAL NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS coin_watchlist (
  list_name TEXT NOT NULL DEFAULT 'default',
  coin_address TEXT NOT NULL,
  label TEXT,
  notes TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (list_name, coin_address)
);
CREATE INDEX IF NOT EXISTS idx_watchlist_enabled ON coin_watchlist(enabled, list_name);

CREATE TABLE IF NOT EXISTS alerts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT,
  type TEXT NOT NULL,
  entity_id TEXT,
  severity TEXT NOT NULL,
  message TEXT NOT NULL,
  payload_json TEXT,
  fingerprint TEXT UNIQUE,
  created_at TEXT NOT NULL,
  sent_discord_at TEXT
);

CREATE TABLE IF NOT EXISTS sync_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT NOT NULL,
  count INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
`);

const alertCols = db.prepare("PRAGMA table_info(alerts)").all() as Array<{ name: string }>;
const hasAlertCol = (name: string) => alertCols.some((c) => c.name === name);

if (!hasAlertCol("kind")) db.exec("ALTER TABLE alerts ADD COLUMN kind TEXT");
if (!hasAlertCol("type")) db.exec("ALTER TABLE alerts ADD COLUMN type TEXT");
if (!hasAlertCol("entity_id")) db.exec("ALTER TABLE alerts ADD COLUMN entity_id TEXT");
if (!hasAlertCol("severity")) db.exec("ALTER TABLE alerts ADD COLUMN severity TEXT");
if (!hasAlertCol("fingerprint")) db.exec("ALTER TABLE alerts ADD COLUMN fingerprint TEXT");
if (!hasAlertCol("sent_discord_at")) db.exec("ALTER TABLE alerts ADD COLUMN sent_discord_at TEXT");
if (!hasAlertCol("payload_json")) db.exec("ALTER TABLE alerts ADD COLUMN payload_json TEXT");

db.exec("UPDATE alerts SET kind = COALESCE(kind, type, 'INFO')");
db.exec("UPDATE alerts SET type = COALESCE(type, kind, 'INFO')");
db.exec("UPDATE alerts SET severity = COALESCE(severity, 'info')");
db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_alerts_fingerprint ON alerts(fingerprint)");

const analyticsCols = db.prepare("PRAGMA table_info(coin_analytics)").all() as Array<{ name: string }>;
const hasAnalyticsCol = (name: string) => analyticsCols.some((c) => c.name === name);

if (!hasAnalyticsCol("swap_count_1h")) db.exec("ALTER TABLE coin_analytics ADD COLUMN swap_count_1h INTEGER NOT NULL DEFAULT 0");
if (!hasAnalyticsCol("unique_traders_1h")) db.exec("ALTER TABLE coin_analytics ADD COLUMN unique_traders_1h INTEGER NOT NULL DEFAULT 0");
if (!hasAnalyticsCol("buy_count_1h")) db.exec("ALTER TABLE coin_analytics ADD COLUMN buy_count_1h INTEGER NOT NULL DEFAULT 0");
if (!hasAnalyticsCol("sell_count_1h")) db.exec("ALTER TABLE coin_analytics ADD COLUMN sell_count_1h INTEGER NOT NULL DEFAULT 0");
if (!hasAnalyticsCol("buy_volume_usdc_1h")) db.exec("ALTER TABLE coin_analytics ADD COLUMN buy_volume_usdc_1h REAL NOT NULL DEFAULT 0");
if (!hasAnalyticsCol("sell_volume_usdc_1h")) db.exec("ALTER TABLE coin_analytics ADD COLUMN sell_volume_usdc_1h REAL NOT NULL DEFAULT 0");
if (!hasAnalyticsCol("net_flow_usdc_1h")) db.exec("ALTER TABLE coin_analytics ADD COLUMN net_flow_usdc_1h REAL NOT NULL DEFAULT 0");
if (!hasAnalyticsCol("swap_count_prev_1h")) db.exec("ALTER TABLE coin_analytics ADD COLUMN swap_count_prev_1h INTEGER NOT NULL DEFAULT 0");
if (!hasAnalyticsCol("momentum_score_1h")) db.exec("ALTER TABLE coin_analytics ADD COLUMN momentum_score_1h REAL NOT NULL DEFAULT 0");
if (!hasAnalyticsCol("momentum_acceleration_1h")) db.exec("ALTER TABLE coin_analytics ADD COLUMN momentum_acceleration_1h REAL NOT NULL DEFAULT 0");

export function upsertCoin(node: any) {
  db.prepare(`
    INSERT INTO coins (
      address, name, symbol, coin_type, creator_address, created_at,
      market_cap, volume_24h, total_volume, chain_id, raw_json, indexed_at
    ) VALUES (
      @address, @name, @symbol, @coin_type, @creator_address, @created_at,
      @market_cap, @volume_24h, @total_volume, @chain_id, @raw_json, @indexed_at
    )
    ON CONFLICT(address) DO UPDATE SET
      name=excluded.name,
      symbol=excluded.symbol,
      coin_type=excluded.coin_type,
      creator_address=excluded.creator_address,
      created_at=excluded.created_at,
      market_cap=excluded.market_cap,
      volume_24h=excluded.volume_24h,
      total_volume=excluded.total_volume,
      chain_id=excluded.chain_id,
      raw_json=excluded.raw_json,
      indexed_at=excluded.indexed_at
  `).run({
    address: String(node.address ?? "").toLowerCase(),
    name: node.name ?? null,
    symbol: node.symbol ?? null,
    coin_type: node.coinType ?? null,
    creator_address: node.creatorAddress?.toLowerCase?.() ?? null,
    created_at: node.createdAt ?? null,
    market_cap: Number(node.marketCap ?? 0),
    volume_24h: Number(node.volume24h ?? 0),
    total_volume: Number(node.totalVolume ?? 0),
    chain_id: Number(node.chainId ?? 0),
    raw_json: JSON.stringify(node),
    indexed_at: new Date().toISOString(),
  });
}

export function getUnsentAlerts(limit = 20) {
  return db.prepare(`
    SELECT id, type, entity_id, severity, message, created_at
    FROM alerts
    WHERE sent_discord_at IS NULL
    ORDER BY id ASC
    LIMIT ?
  `).all(limit) as Array<{
    id: number;
    type: string;
    entity_id: string | null;
    severity: string;
    message: string;
    created_at: string;
  }>;
}

export function markAlertsSent(ids: number[]) {
  if (!ids.length) return 0;
  const q = ids.map(() => "?").join(",");
  const r = db.prepare(`UPDATE alerts SET sent_discord_at = ? WHERE id IN (${q})`).run(new Date().toISOString(), ...ids);
  return r.changes;
}
