import type { Database } from "better-sqlite3";

export function runMigrations(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS wallets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      address TEXT NOT NULL UNIQUE,
      cdp_account_name TEXT NOT NULL UNIQUE,
      owner_address TEXT NOT NULL,
      type TEXT NOT NULL CHECK (type IN ('smart')),
      is_master INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS trades (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      wallet_id INTEGER NOT NULL,
      from_token TEXT NOT NULL,
      to_token TEXT NOT NULL,
      amount_in TEXT NOT NULL,
      user_op_hash TEXT,
      tx_hash TEXT,
      status TEXT NOT NULL CHECK (status IN ('pending', 'complete', 'failed')),
      error_message TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(wallet_id) REFERENCES wallets(id)
    );

    CREATE TABLE IF NOT EXISTS funding_txs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      from_wallet_id INTEGER NOT NULL,
      to_wallet_id INTEGER NOT NULL,
      amount_wei TEXT NOT NULL,
      user_op_hash TEXT,
      tx_hash TEXT,
      status TEXT NOT NULL CHECK (status IN ('pending', 'complete', 'failed')),
      error_message TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(from_wallet_id) REFERENCES wallets(id),
      FOREIGN KEY(to_wallet_id) REFERENCES wallets(id)
    );
  `);
}

