/**
 * positions.ts — Klawley's position tracker
 *
 * SQLite-backed tracking of open/closed positions with P&L.
 */

import Database from "better-sqlite3";
import { env } from "./config.js";

let _db: Database.Database | null = null;

function getDb(): Database.Database {
  if (!_db) {
    _db = new Database(env.DB_PATH);
    _db.pragma("journal_mode = WAL");
    migrate(_db);
  }
  return _db;
}

function migrate(db: Database.Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS klawley_positions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      coin_address TEXT NOT NULL,
      symbol TEXT,
      name TEXT,
      status TEXT NOT NULL DEFAULT 'open',
      entry_eth_total TEXT NOT NULL DEFAULT '0',
      exit_eth_total TEXT NOT NULL DEFAULT '0',
      token_balance TEXT NOT NULL DEFAULT '0',
      created_at TEXT NOT NULL,
      last_buy_at TEXT,
      closed_at TEXT
    );

    CREATE TABLE IF NOT EXISTS klawley_trades (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      position_id INTEGER,
      coin_address TEXT NOT NULL,
      action TEXT NOT NULL,
      eth_amount TEXT NOT NULL,
      token_amount TEXT NOT NULL,
      tx_hash TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (position_id) REFERENCES klawley_positions(id)
    );
  `);
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Position {
  id: number;
  coin_address: string;
  symbol: string | null;
  name: string | null;
  status: string;
  entry_eth_total: string;
  exit_eth_total: string;
  token_balance: string;
  created_at: string;
  last_buy_at: string | null;
  closed_at: string | null;
}

export interface PositionWithPnl extends Position {
  pnl_eth: bigint;
  pnl_pct: number;
}

// ---------------------------------------------------------------------------
// Record trades
// ---------------------------------------------------------------------------

export function recordBuy(input: {
  coinAddress: string;
  symbol?: string | null;
  name?: string | null;
  ethAmountWei: string;
  tokenAmount: string;
  txHash?: string | null;
}): Position {
  const db = getDb();
  const now = new Date().toISOString();
  const addr = input.coinAddress.toLowerCase();

  // Find or create open position
  let pos = db.prepare(
    "SELECT * FROM klawley_positions WHERE coin_address = ? AND status = 'open'"
  ).get(addr) as Position | undefined;

  if (pos) {
    // Update existing position — reset timer on new buy
    const newEntryTotal = (BigInt(pos.entry_eth_total) + BigInt(input.ethAmountWei)).toString();
    const newTokenBalance = (BigInt(pos.token_balance) + BigInt(input.tokenAmount)).toString();
    db.prepare(
      "UPDATE klawley_positions SET entry_eth_total = ?, token_balance = ?, last_buy_at = ?, symbol = COALESCE(?, symbol), name = COALESCE(?, name) WHERE id = ?"
    ).run(newEntryTotal, newTokenBalance, now, input.symbol ?? null, input.name ?? null, pos.id);
    pos = db.prepare("SELECT * FROM klawley_positions WHERE id = ?").get(pos.id) as Position;
  } else {
    // Create new position
    const result = db.prepare(
      "INSERT INTO klawley_positions (coin_address, symbol, name, status, entry_eth_total, token_balance, created_at, last_buy_at) VALUES (?, ?, ?, 'open', ?, ?, ?, ?)"
    ).run(addr, input.symbol ?? null, input.name ?? null, input.ethAmountWei, input.tokenAmount, now, now);
    pos = db.prepare("SELECT * FROM klawley_positions WHERE id = ?").get(result.lastInsertRowid) as Position;
  }

  // Record trade
  db.prepare(
    "INSERT INTO klawley_trades (position_id, coin_address, action, eth_amount, token_amount, tx_hash) VALUES (?, ?, 'BUY', ?, ?, ?)"
  ).run(pos.id, addr, input.ethAmountWei, input.tokenAmount, input.txHash ?? null);

  return pos;
}

export function recordSell(input: {
  coinAddress: string;
  ethAmountWei: string;
  tokenAmount: string;
  txHash?: string | null;
}): Position | null {
  const db = getDb();
  const addr = input.coinAddress.toLowerCase();

  const pos = db.prepare(
    "SELECT * FROM klawley_positions WHERE coin_address = ? AND status = 'open'"
  ).get(addr) as Position | undefined;

  if (!pos) {
    console.warn(`[positions] No open position for ${addr}`);
    return null;
  }

  const newExitTotal = (BigInt(pos.exit_eth_total) + BigInt(input.ethAmountWei)).toString();
  const newTokenBalance = BigInt(pos.token_balance) - BigInt(input.tokenAmount);
  const tokenBalStr = (newTokenBalance > 0n ? newTokenBalance : 0n).toString();
  const isClosed = newTokenBalance <= 0n;

  db.prepare(
    "UPDATE klawley_positions SET exit_eth_total = ?, token_balance = ?, status = ?, closed_at = ? WHERE id = ?"
  ).run(
    newExitTotal,
    tokenBalStr,
    isClosed ? "closed" : "open",
    isClosed ? new Date().toISOString() : null,
    pos.id,
  );

  db.prepare(
    "INSERT INTO klawley_trades (position_id, coin_address, action, eth_amount, token_amount, tx_hash) VALUES (?, ?, 'SELL', ?, ?, ?)"
  ).run(pos.id, addr, input.ethAmountWei, input.tokenAmount, input.txHash ?? null);

  return db.prepare("SELECT * FROM klawley_positions WHERE id = ?").get(pos.id) as Position;
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

export function getOpenPositions(): Position[] {
  return getDb().prepare(
    "SELECT * FROM klawley_positions WHERE status = 'open' ORDER BY created_at DESC"
  ).all() as Position[];
}

export function getPositionCount(): number {
  const row = getDb().prepare(
    "SELECT COUNT(*) as cnt FROM klawley_positions WHERE status = 'open'"
  ).get() as { cnt: number };
  return row.cnt;
}

export function getPositionByCoin(coinAddress: string): Position | null {
  return (getDb().prepare(
    "SELECT * FROM klawley_positions WHERE coin_address = ? AND status = 'open'"
  ).get(coinAddress.toLowerCase()) as Position) ?? null;
}

export function getClosedPositions(limit = 20): PositionWithPnl[] {
  const rows = getDb().prepare(
    "SELECT * FROM klawley_positions WHERE status = 'closed' ORDER BY closed_at DESC LIMIT ?"
  ).all(limit) as Position[];

  return rows.map(p => {
    const entry = BigInt(p.entry_eth_total);
    const exit = BigInt(p.exit_eth_total);
    const pnl_eth = exit - entry;
    const pnl_pct = entry > 0n ? Number((pnl_eth * 10000n) / entry) / 100 : 0;
    return { ...p, pnl_eth, pnl_pct };
  });
}

/**
 * Force-close a position (set token_balance=0, status=closed).
 * Used when on-chain balance is 0 but DB still shows tokens (ghost position).
 */
export function forceClosePosition(coinAddress: string, reason?: string): Position | null {
  const db = getDb();
  const addr = coinAddress.toLowerCase();
  const pos = db.prepare(
    "SELECT * FROM klawley_positions WHERE coin_address = ? AND status = 'open'"
  ).get(addr) as Position | undefined;

  if (!pos) return null;

  db.prepare(
    "UPDATE klawley_positions SET token_balance = '0', status = 'closed', closed_at = ? WHERE id = ?"
  ).run(new Date().toISOString(), pos.id);

  console.log(`[positions] Force-closed ${pos.symbol || addr}: ${reason || "on-chain balance is 0"}`);

  return db.prepare("SELECT * FROM klawley_positions WHERE id = ?").get(pos.id) as Position;
}

export function closeDb() {
  if (_db) {
    _db.close();
    _db = null;
  }
}
