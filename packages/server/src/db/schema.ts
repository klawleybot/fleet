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

  const tradeColumns = db.prepare("PRAGMA table_info(trades)").all() as Array<{ name: string }>;
  const tradeColNames = new Set(tradeColumns.map((c) => c.name));
  if (!tradeColNames.has("amount_out")) db.exec("ALTER TABLE trades ADD COLUMN amount_out TEXT");
  if (!tradeColNames.has("operation_id")) db.exec("ALTER TABLE trades ADD COLUMN operation_id INTEGER REFERENCES operations(id)");

  db.exec(`
    CREATE TABLE IF NOT EXISTS swing_configs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      fleet_name TEXT NOT NULL,
      coin_address TEXT NOT NULL,
      take_profit_bps INTEGER NOT NULL DEFAULT 1500,
      stop_loss_bps INTEGER NOT NULL DEFAULT 2000,
      trailing_stop_bps INTEGER,
      cooldown_sec INTEGER NOT NULL DEFAULT 300,
      slippage_bps INTEGER NOT NULL DEFAULT 500,
      enabled INTEGER NOT NULL DEFAULT 1,
      peak_pnl_bps INTEGER,
      last_action_at TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(fleet_name, coin_address)
    );

    CREATE TABLE IF NOT EXISTS positions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      wallet_id INTEGER NOT NULL,
      coin_address TEXT NOT NULL,
      total_cost_wei TEXT NOT NULL DEFAULT '0',
      total_received_wei TEXT NOT NULL DEFAULT '0',
      holdings_raw TEXT NOT NULL DEFAULT '0',
      realized_pnl_wei TEXT NOT NULL DEFAULT '0',
      buy_count INTEGER NOT NULL DEFAULT 0,
      sell_count INTEGER NOT NULL DEFAULT 0,
      last_action_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(wallet_id, coin_address),
      FOREIGN KEY(wallet_id) REFERENCES wallets(id)
    );

    CREATE INDEX IF NOT EXISTS idx_positions_wallet ON positions(wallet_id);
    CREATE INDEX IF NOT EXISTS idx_positions_coin ON positions(coin_address);
    CREATE INDEX IF NOT EXISTS idx_trades_operation ON trades(operation_id);
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS campaigns (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      coin_address TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      symbol TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('planned', 'active', 'paused', 'settled', 'cancelled')),
      phase TEXT NOT NULL CHECK (phase IN ('launch', 'mid', 'late', 'settlement')),
      deploy_tx_hash TEXT,
      deploy_source TEXT,
      metadata_uri TEXT,
      target_allocation_bps INTEGER NOT NULL DEFAULT 100,
      self_snipe_eth_wei TEXT NOT NULL DEFAULT '0',
      total_buy_eth_wei TEXT NOT NULL DEFAULT '0',
      total_sell_eth_wei TEXT NOT NULL DEFAULT '0',
      total_burned_tokens TEXT NOT NULL DEFAULT '0',
      pnl_eth_wei TEXT NOT NULL DEFAULT '0',
      holders INTEGER NOT NULL DEFAULT 0,
      external_volume_24h_usd REAL NOT NULL DEFAULT 0,
      external_swap_count_24h INTEGER NOT NULL DEFAULT 0,
      last_metrics_at TEXT,
      last_execution_at TEXT,
      started_at TEXT NOT NULL,
      ends_at TEXT NOT NULL,
      settlement_mode TEXT CHECK (settlement_mode IN ('recover_1pct', 'retain_1pct')),
      settlement_at TEXT,
      settlement_notes TEXT,
      retained_allocation_bps INTEGER NOT NULL DEFAULT 0,
      recover_allocation_bps INTEGER NOT NULL DEFAULT 0,
      treasury_retained_eth_wei TEXT NOT NULL DEFAULT '0',
      burn_gain_eth_wei TEXT NOT NULL DEFAULT '0',
      dry_run INTEGER NOT NULL DEFAULT 0,
      notes TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS campaign_metrics_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      campaign_id INTEGER NOT NULL,
      holders INTEGER NOT NULL DEFAULT 0,
      volume_24h_usd REAL NOT NULL DEFAULT 0,
      swaps_24h INTEGER NOT NULL DEFAULT 0,
      net_flow_24h_usd REAL NOT NULL DEFAULT 0,
      momentum_score REAL NOT NULL DEFAULT 0,
      external_wallet_buy_count_24h INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(campaign_id) REFERENCES campaigns(id)
    );

    CREATE TABLE IF NOT EXISTS campaign_plans (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      campaign_id INTEGER NOT NULL,
      phase TEXT NOT NULL CHECK (phase IN ('launch', 'mid', 'late', 'settlement')),
      rationale TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('draft', 'approved', 'superseded', 'completed')),
      planned_for TEXT NOT NULL,
      max_concurrent_campaigns INTEGER NOT NULL DEFAULT 3,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(campaign_id) REFERENCES campaigns(id)
    );

    CREATE TABLE IF NOT EXISTS campaign_plan_steps (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      campaign_id INTEGER NOT NULL,
      plan_id INTEGER NOT NULL,
      side TEXT NOT NULL CHECK (side IN ('buy', 'sell', 'burn')),
      sequence_no INTEGER NOT NULL,
      scheduled_for TEXT NOT NULL,
      amount_wei TEXT NOT NULL,
      slippage_bps INTEGER NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('pending', 'ready', 'executing', 'confirmed', 'failed', 'cancelled')),
      rationale TEXT NOT NULL,
      started_at TEXT,
      completed_at TEXT,
      execution_id INTEGER,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(campaign_id) REFERENCES campaigns(id),
      FOREIGN KEY(plan_id) REFERENCES campaign_plans(id)
    );

    CREATE TABLE IF NOT EXISTS campaign_executions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      campaign_id INTEGER NOT NULL,
      plan_id INTEGER,
      step_id INTEGER,
      side TEXT NOT NULL CHECK (side IN ('buy', 'sell', 'burn')),
      status TEXT NOT NULL CHECK (status IN ('simulated', 'confirmed', 'failed', 'skipped')),
      amount_in_wei TEXT NOT NULL,
      amount_out_raw TEXT,
      tx_hash TEXT,
      user_op_hash TEXT,
      summary TEXT,
      simulation_only INTEGER NOT NULL DEFAULT 0,
      reason TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      completed_at TEXT,
      FOREIGN KEY(campaign_id) REFERENCES campaigns(id),
      FOREIGN KEY(plan_id) REFERENCES campaign_plans(id),
      FOREIGN KEY(step_id) REFERENCES campaign_plan_steps(id)
    );

    CREATE INDEX IF NOT EXISTS idx_campaigns_status ON campaigns(status);
    CREATE INDEX IF NOT EXISTS idx_campaigns_phase ON campaigns(phase);
    CREATE INDEX IF NOT EXISTS idx_campaigns_started_at ON campaigns(started_at);
    CREATE INDEX IF NOT EXISTS idx_campaign_metrics_campaign_created ON campaign_metrics_snapshots(campaign_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_campaign_plans_campaign ON campaign_plans(campaign_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_campaign_plan_steps_due ON campaign_plan_steps(status, scheduled_for);
    CREATE INDEX IF NOT EXISTS idx_campaign_plan_steps_campaign ON campaign_plan_steps(campaign_id, status, scheduled_for);
    CREATE INDEX IF NOT EXISTS idx_campaign_executions_campaign ON campaign_executions(campaign_id, created_at DESC);
  `);
}
