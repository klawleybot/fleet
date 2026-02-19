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

    CREATE TABLE IF NOT EXISTS clusters (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      strategy_mode TEXT NOT NULL CHECK (strategy_mode IN ('sync', 'staggered', 'momentum')),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS cluster_wallets (
      cluster_id INTEGER NOT NULL,
      wallet_id INTEGER NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      weight REAL NOT NULL DEFAULT 1,
      added_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY(cluster_id, wallet_id),
      FOREIGN KEY(cluster_id) REFERENCES clusters(id),
      FOREIGN KEY(wallet_id) REFERENCES wallets(id)
    );

    CREATE TABLE IF NOT EXISTS operations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL CHECK (type IN ('FUNDING_REQUEST', 'SUPPORT_COIN', 'EXIT_COIN')),
      cluster_id INTEGER NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'executing', 'complete', 'failed')) DEFAULT 'pending',
      requested_by TEXT,
      approved_by TEXT,
      payload_json TEXT NOT NULL,
      result_json TEXT,
      error_message TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(cluster_id) REFERENCES clusters(id)
    );

    CREATE INDEX IF NOT EXISTS idx_cluster_wallets_cluster ON cluster_wallets(cluster_id);
    CREATE INDEX IF NOT EXISTS idx_operations_status ON operations(status);
    CREATE INDEX IF NOT EXISTS idx_operations_cluster ON operations(cluster_id);
  `);
}

