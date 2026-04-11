import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { runMigrations } from "./schema.js";
import type {
  CampaignExecutionRecord,
  CampaignExecutionStatus,
  CampaignMetricsSnapshotRecord,
  CampaignPhase,
  CampaignPlan,
  CampaignPlanStatus,
  CampaignPlanStep,
  CampaignPlanStepStatus,
  CampaignRecord,
  CampaignSettlementMode,
  CampaignStatus,
  CampaignTradeSide,
  ClusterRecord,
  ClusterWalletRecord,
  FundingRecord,
  FundingStatus,
  OperationRecord,
  OperationStatus,
  OperationType,
  PositionRecord,
  StrategyMode,
  SwingConfigRecord,
  TradeRecord,
  TradeStatus,
  WalletRecord,
} from "../types.js";

interface WalletRow {
  id: number;
  name: string;
  address: string;
  cdp_account_name: string;
  owner_address: string;
  type: "smart";
  is_master: number;
  created_at: string;
}

interface TradeRow {
  id: number;
  wallet_id: number;
  from_token: string;
  to_token: string;
  amount_in: string;
  amount_out: string | null;
  operation_id: number | null;
  user_op_hash: string | null;
  tx_hash: string | null;
  status: TradeStatus;
  error_message: string | null;
  created_at: string;
}

interface PositionRow {
  id: number;
  wallet_id: number;
  coin_address: string;
  total_cost_wei: string;
  total_received_wei: string;
  holdings_raw: string;
  realized_pnl_wei: string;
  buy_count: number;
  sell_count: number;
  last_action_at: string;
}

interface FundingRow {
  id: number;
  from_wallet_id: number;
  to_wallet_id: number;
  amount_wei: string;
  user_op_hash: string | null;
  tx_hash: string | null;
  status: FundingStatus;
  error_message: string | null;
  created_at: string;
}

interface ClusterRow {
  id: number;
  name: string;
  strategy_mode: StrategyMode;
  created_at: string;
}

interface ClusterWalletRow {
  cluster_id: number;
  wallet_id: number;
  enabled: number;
  weight: number;
  added_at: string;
}

interface SwingConfigRow {
  id: number;
  fleet_name: string;
  coin_address: string;
  take_profit_bps: number;
  stop_loss_bps: number;
  trailing_stop_bps: number | null;
  cooldown_sec: number;
  slippage_bps: number;
  enabled: number;
  peak_pnl_bps: number | null;
  last_action_at: string | null;
  created_at: string;
}

interface OperationRow {
  id: number;
  type: OperationType;
  cluster_id: number;
  status: OperationStatus;
  requested_by: string | null;
  approved_by: string | null;
  payload_json: string;
  result_json: string | null;
  error_message: string | null;
  created_at: string;
  updated_at: string;
}

interface CampaignRow {
  id: number;
  coin_address: string;
  name: string;
  symbol: string;
  status: CampaignStatus;
  phase: CampaignPhase;
  deploy_tx_hash: string | null;
  deploy_source: string | null;
  metadata_uri: string | null;
  target_allocation_bps: number;
  self_snipe_eth_wei: string;
  total_buy_eth_wei: string;
  total_sell_eth_wei: string;
  total_burned_tokens: string;
  pnl_eth_wei: string;
  holders: number;
  external_volume_24h_usd: number;
  external_swap_count_24h: number;
  last_metrics_at: string | null;
  last_execution_at: string | null;
  started_at: string;
  ends_at: string;
  settlement_mode: CampaignSettlementMode | null;
  settlement_at: string | null;
  settlement_notes: string | null;
  retained_allocation_bps: number;
  recover_allocation_bps: number;
  treasury_retained_eth_wei: string;
  burn_gain_eth_wei: string;
  dry_run: number;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

interface CampaignMetricsSnapshotRow {
  id: number;
  campaign_id: number;
  holders: number;
  volume_24h_usd: number;
  swaps_24h: number;
  net_flow_24h_usd: number;
  momentum_score: number;
  external_wallet_buy_count_24h: number;
  created_at: string;
}

interface CampaignPlanRow {
  id: number;
  campaign_id: number;
  phase: CampaignPhase;
  rationale: string;
  status: CampaignPlanStatus;
  planned_for: string;
  max_concurrent_campaigns: number;
  created_at: string;
}

interface CampaignPlanStepRow {
  id: number;
  campaign_id: number;
  plan_id: number;
  side: CampaignTradeSide;
  sequence_no: number;
  scheduled_for: string;
  amount_wei: string;
  slippage_bps: number;
  status: CampaignPlanStepStatus;
  rationale: string;
  started_at: string | null;
  completed_at: string | null;
  execution_id: number | null;
  created_at: string;
}

interface CampaignExecutionRow {
  id: number;
  campaign_id: number;
  plan_id: number | null;
  step_id: number | null;
  side: CampaignTradeSide;
  status: CampaignExecutionStatus;
  amount_in_wei: string;
  amount_out_raw: string | null;
  tx_hash: string | null;
  user_op_hash: string | null;
  summary: string | null;
  simulation_only: number;
  reason: string | null;
  created_at: string;
  completed_at: string | null;
}

function mapWallet(row: WalletRow): WalletRecord {
  return {
    id: row.id,
    name: row.name,
    address: row.address as `0x${string}`,
    cdpAccountName: row.cdp_account_name,
    ownerAddress: row.owner_address as `0x${string}`,
    type: row.type,
    isMaster: row.is_master === 1,
    createdAt: row.created_at,
  };
}

function mapTrade(row: TradeRow): TradeRecord {
  return {
    id: row.id,
    walletId: row.wallet_id,
    fromToken: row.from_token as `0x${string}`,
    toToken: row.to_token as `0x${string}`,
    amountIn: row.amount_in,
    amountOut: row.amount_out ?? null,
    operationId: row.operation_id ?? null,
    userOpHash: row.user_op_hash as `0x${string}` | null,
    txHash: row.tx_hash as `0x${string}` | null,
    status: row.status,
    errorMessage: row.error_message,
    createdAt: row.created_at,
  };
}

function mapPosition(row: PositionRow): PositionRecord {
  return {
    id: row.id,
    walletId: row.wallet_id,
    coinAddress: row.coin_address as `0x${string}`,
    totalCostWei: row.total_cost_wei,
    totalReceivedWei: row.total_received_wei,
    holdingsRaw: row.holdings_raw,
    realizedPnlWei: row.realized_pnl_wei,
    buyCount: row.buy_count,
    sellCount: row.sell_count,
    lastActionAt: row.last_action_at,
  };
}

function mapFunding(row: FundingRow): FundingRecord {
  return {
    id: row.id,
    fromWalletId: row.from_wallet_id,
    toWalletId: row.to_wallet_id,
    amountWei: row.amount_wei,
    userOpHash: row.user_op_hash as `0x${string}` | null,
    txHash: row.tx_hash as `0x${string}` | null,
    status: row.status,
    errorMessage: row.error_message,
    createdAt: row.created_at,
  };
}

function mapCluster(row: ClusterRow): ClusterRecord {
  return {
    id: row.id,
    name: row.name,
    strategyMode: row.strategy_mode,
    createdAt: row.created_at,
  };
}

function mapClusterWallet(row: ClusterWalletRow): ClusterWalletRecord {
  return {
    clusterId: row.cluster_id,
    walletId: row.wallet_id,
    enabled: row.enabled === 1,
    weight: row.weight,
    addedAt: row.added_at,
  };
}

function mapSwingConfig(row: SwingConfigRow): SwingConfigRecord {
  return {
    id: row.id,
    fleetName: row.fleet_name,
    coinAddress: row.coin_address as `0x${string}`,
    takeProfitBps: row.take_profit_bps,
    stopLossBps: row.stop_loss_bps,
    trailingStopBps: row.trailing_stop_bps,
    cooldownSec: row.cooldown_sec,
    slippageBps: row.slippage_bps,
    enabled: row.enabled === 1,
    peakPnlBps: row.peak_pnl_bps,
    lastActionAt: row.last_action_at,
    createdAt: row.created_at,
  };
}

function mapOperation(row: OperationRow): OperationRecord {
  return {
    id: row.id,
    type: row.type,
    clusterId: row.cluster_id,
    status: row.status,
    requestedBy: row.requested_by,
    approvedBy: row.approved_by,
    payloadJson: row.payload_json,
    resultJson: row.result_json,
    errorMessage: row.error_message,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapCampaign(row: CampaignRow): CampaignRecord {
  return {
    id: row.id,
    coinAddress: row.coin_address as `0x${string}`,
    name: row.name,
    symbol: row.symbol,
    status: row.status,
    phase: row.phase,
    deployTxHash: row.deploy_tx_hash as `0x${string}` | null,
    deploySource: row.deploy_source,
    metadataUri: row.metadata_uri,
    targetAllocationBps: row.target_allocation_bps,
    selfSnipeEthWei: row.self_snipe_eth_wei,
    totalBuyEthWei: row.total_buy_eth_wei,
    totalSellEthWei: row.total_sell_eth_wei,
    totalBurnedTokens: row.total_burned_tokens,
    pnlEthWei: row.pnl_eth_wei,
    holders: row.holders,
    externalVolume24hUsd: row.external_volume_24h_usd,
    externalSwapCount24h: row.external_swap_count_24h,
    lastMetricsAt: row.last_metrics_at,
    lastExecutionAt: row.last_execution_at,
    startedAt: row.started_at,
    endsAt: row.ends_at,
    settlementMode: row.settlement_mode,
    settlementAt: row.settlement_at,
    settlementNotes: row.settlement_notes,
    retainedAllocationBps: row.retained_allocation_bps,
    recoverAllocationBps: row.recover_allocation_bps,
    treasuryRetainedEthWei: row.treasury_retained_eth_wei,
    burnGainEthWei: row.burn_gain_eth_wei,
    dryRun: row.dry_run === 1,
    notes: row.notes,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapCampaignMetricsSnapshot(row: CampaignMetricsSnapshotRow): CampaignMetricsSnapshotRecord {
  return {
    id: row.id,
    campaignId: row.campaign_id,
    holders: row.holders,
    volume24hUsd: row.volume_24h_usd,
    swaps24h: row.swaps_24h,
    netFlow24hUsd: row.net_flow_24h_usd,
    momentumScore: row.momentum_score,
    externalWalletBuyCount24h: row.external_wallet_buy_count_24h,
    createdAt: row.created_at,
  };
}

function mapCampaignPlan(row: CampaignPlanRow): CampaignPlan {
  return {
    id: row.id,
    campaignId: row.campaign_id,
    phase: row.phase,
    rationale: row.rationale,
    status: row.status,
    plannedFor: row.planned_for,
    maxConcurrentCampaigns: row.max_concurrent_campaigns,
    createdAt: row.created_at,
  };
}

function mapCampaignPlanStep(row: CampaignPlanStepRow): CampaignPlanStep {
  return {
    id: row.id,
    campaignId: row.campaign_id,
    planId: row.plan_id,
    side: row.side,
    sequenceNo: row.sequence_no,
    scheduledFor: row.scheduled_for,
    amountWei: row.amount_wei,
    slippageBps: row.slippage_bps,
    status: row.status,
    rationale: row.rationale,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    executionId: row.execution_id,
    createdAt: row.created_at,
  };
}

function mapCampaignExecution(row: CampaignExecutionRow): CampaignExecutionRecord {
  return {
    id: row.id,
    campaignId: row.campaign_id,
    planId: row.plan_id,
    stepId: row.step_id,
    side: row.side,
    status: row.status,
    amountInWei: row.amount_in_wei,
    amountOutRaw: row.amount_out_raw,
    txHash: row.tx_hash as `0x${string}` | null,
    userOpHash: row.user_op_hash as `0x${string}` | null,
    summary: row.summary,
    simulationOnly: row.simulation_only === 1,
    reason: row.reason,
    createdAt: row.created_at,
    completedAt: row.completed_at,
  };
}

let _sqlite: Database.Database | null = null;

function resolveDbPath(): string {
  const envPath = process.env.SQLITE_PATH?.trim();

  if (process.env.VITEST && !envPath) {
    throw new Error(
      "DB safety violation: Vitest is active but SQLITE_PATH is not set. " +
        "Add env.SQLITE_PATH to your vitest config so tests never touch the production database.",
    );
  }

  if (envPath) return path.resolve(envPath);
  const packageRoot = path.resolve(new URL(".", import.meta.url).pathname, "..", "..");
  return path.join(packageRoot, ".data", "pump-it-up.db");
}

function getSqlite(): Database.Database {
  if (_sqlite) return _sqlite;
  const dbPath = resolveDbPath();
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  _sqlite = new Database(dbPath);
  runMigrations(_sqlite);
  return _sqlite;
}

export function resetDb() {
  if (_sqlite) {
    _sqlite.close();
    _sqlite = null;
  }
}

export const db = {
  createWallet(input: {
    name: string;
    address: `0x${string}`;
    cdpAccountName: string;
    ownerAddress: `0x${string}`;
    type: "smart";
    isMaster: boolean;
  }): WalletRecord {
    const result = getSqlite().prepare(
      `INSERT INTO wallets (name, address, cdp_account_name, owner_address, type, is_master)
       VALUES (@name, @address, @cdp_account_name, @owner_address, @type, @is_master)`,
    ).run({
      name: input.name,
      address: input.address,
      cdp_account_name: input.cdpAccountName,
      owner_address: input.ownerAddress,
      type: input.type,
      is_master: input.isMaster ? 1 : 0,
    });
    return mapWallet(getSqlite().prepare("SELECT * FROM wallets WHERE id = ?").get(result.lastInsertRowid) as WalletRow);
  },
  getWalletById(id: number) { const row = getSqlite().prepare("SELECT * FROM wallets WHERE id = ?").get(id) as WalletRow | undefined; return row ? mapWallet(row) : null; },
  getWalletByName(name: string) { const row = getSqlite().prepare("SELECT * FROM wallets WHERE name = ?").get(name) as WalletRow | undefined; return row ? mapWallet(row) : null; },
  getMasterWallet() { const row = getSqlite().prepare("SELECT * FROM wallets WHERE is_master = 1 LIMIT 1").get() as WalletRow | undefined; return row ? mapWallet(row) : null; },
  listWallets() { return (getSqlite().prepare("SELECT * FROM wallets ORDER BY id ASC").all() as WalletRow[]).map(mapWallet); },

  createTrade(input: { walletId: number; fromToken: `0x${string}`; toToken: `0x${string}`; amountIn: string; amountOut?: string | null; operationId?: number | null; userOpHash: `0x${string}` | null; txHash: `0x${string}` | null; status: TradeStatus; errorMessage: string | null; }): TradeRecord {
    const result = getSqlite().prepare(
      `INSERT INTO trades (wallet_id, from_token, to_token, amount_in, amount_out, operation_id, user_op_hash, tx_hash, status, error_message)
       VALUES (@wallet_id, @from_token, @to_token, @amount_in, @amount_out, @operation_id, @user_op_hash, @tx_hash, @status, @error_message)`,
    ).run({ wallet_id: input.walletId, from_token: input.fromToken, to_token: input.toToken, amount_in: input.amountIn, amount_out: input.amountOut ?? null, operation_id: input.operationId ?? null, user_op_hash: input.userOpHash, tx_hash: input.txHash, status: input.status, error_message: input.errorMessage });
    return mapTrade(getSqlite().prepare("SELECT * FROM trades WHERE id = ?").get(result.lastInsertRowid) as TradeRow);
  },
  updateTradeAmountOut(tradeId: number, amountOut: string) { getSqlite().prepare("UPDATE trades SET amount_out = ? WHERE id = ?").run(amountOut, tradeId); },
  listTrades() { return (getSqlite().prepare("SELECT * FROM trades ORDER BY id DESC").all() as TradeRow[]).map(mapTrade); },

  createFunding(input: { fromWalletId: number; toWalletId: number; amountWei: string; userOpHash: `0x${string}` | null; txHash: `0x${string}` | null; status: FundingStatus; errorMessage: string | null; }): FundingRecord {
    const result = getSqlite().prepare(
      `INSERT INTO funding_txs (from_wallet_id, to_wallet_id, amount_wei, user_op_hash, tx_hash, status, error_message)
       VALUES (@from_wallet_id, @to_wallet_id, @amount_wei, @user_op_hash, @tx_hash, @status, @error_message)`,
    ).run({ from_wallet_id: input.fromWalletId, to_wallet_id: input.toWalletId, amount_wei: input.amountWei, user_op_hash: input.userOpHash, tx_hash: input.txHash, status: input.status, error_message: input.errorMessage });
    return mapFunding(getSqlite().prepare("SELECT * FROM funding_txs WHERE id = ?").get(result.lastInsertRowid) as FundingRow);
  },
  listFunding() { return (getSqlite().prepare("SELECT * FROM funding_txs ORDER BY id DESC").all() as FundingRow[]).map(mapFunding); },

  createCluster(input: { name: string; strategyMode: StrategyMode }): ClusterRecord {
    const result = getSqlite().prepare(`INSERT INTO clusters (name, strategy_mode) VALUES (@name, @strategy_mode)`).run({ name: input.name, strategy_mode: input.strategyMode });
    return mapCluster(getSqlite().prepare("SELECT * FROM clusters WHERE id = ?").get(result.lastInsertRowid) as ClusterRow);
  },
  getClusterById(id: number) { const row = getSqlite().prepare("SELECT * FROM clusters WHERE id = ?").get(id) as ClusterRow | undefined; return row ? mapCluster(row) : null; },
  getClusterByName(name: string) { const row = getSqlite().prepare("SELECT * FROM clusters WHERE name = ?").get(name) as ClusterRow | undefined; return row ? mapCluster(row) : null; },
  listClusters() { return (getSqlite().prepare("SELECT * FROM clusters ORDER BY id ASC").all() as ClusterRow[]).map(mapCluster); },
  setClusterWallets(clusterId: number, walletIds: number[]): ClusterWalletRecord[] {
    const uniqueWalletIds = [...new Set(walletIds)];
    getSqlite().transaction((ids: number[]) => {
      getSqlite().prepare("DELETE FROM cluster_wallets WHERE cluster_id = ?").run(clusterId);
      const insert = getSqlite().prepare(`INSERT INTO cluster_wallets (cluster_id, wallet_id, enabled, weight) VALUES (?, ?, 1, 1)`);
      for (const walletId of ids) insert.run(clusterId, walletId);
    })(uniqueWalletIds);
    return (getSqlite().prepare("SELECT * FROM cluster_wallets WHERE cluster_id = ? ORDER BY wallet_id ASC").all(clusterId) as ClusterWalletRow[]).map(mapClusterWallet);
  },
  listClusterWallets(clusterId: number) { return (getSqlite().prepare("SELECT * FROM cluster_wallets WHERE cluster_id = ? ORDER BY wallet_id ASC").all(clusterId) as ClusterWalletRow[]).map(mapClusterWallet); },
  listClusterWalletDetails(clusterId: number) { return (getSqlite().prepare(`SELECT w.* FROM cluster_wallets cw JOIN wallets w ON w.id = cw.wallet_id WHERE cw.cluster_id = ? AND cw.enabled = 1 ORDER BY w.id ASC`).all(clusterId) as WalletRow[]).map(mapWallet); },

  createOperation(input: { type: OperationType; clusterId: number; status?: OperationStatus; requestedBy?: string | null; approvedBy?: string | null; payloadJson: string; resultJson?: string | null; errorMessage?: string | null; }): OperationRecord {
    const result = getSqlite().prepare(`INSERT INTO operations (type, cluster_id, status, requested_by, approved_by, payload_json, result_json, error_message, updated_at) VALUES (@type, @cluster_id, @status, @requested_by, @approved_by, @payload_json, @result_json, @error_message, CURRENT_TIMESTAMP)`).run({ type: input.type, cluster_id: input.clusterId, status: input.status ?? "pending", requested_by: input.requestedBy ?? null, approved_by: input.approvedBy ?? null, payload_json: input.payloadJson, result_json: input.resultJson ?? null, error_message: input.errorMessage ?? null });
    return mapOperation(getSqlite().prepare("SELECT * FROM operations WHERE id = ?").get(result.lastInsertRowid) as OperationRow);
  },
  getOperationById(id: number) { const row = getSqlite().prepare("SELECT * FROM operations WHERE id = ?").get(id) as OperationRow | undefined; return row ? mapOperation(row) : null; },
  updateOperation(input: { id: number; status?: OperationStatus; approvedBy?: string | null; payloadJson?: string; resultJson?: string | null; errorMessage?: string | null; }): OperationRecord {
    const current = getSqlite().prepare("SELECT * FROM operations WHERE id = ?").get(input.id) as OperationRow | undefined;
    if (!current) throw new Error(`Operation ${input.id} not found`);
    getSqlite().prepare(`UPDATE operations SET status = @status, approved_by = @approved_by, payload_json = @payload_json, result_json = @result_json, error_message = @error_message, updated_at = CURRENT_TIMESTAMP WHERE id = @id`).run({ id: input.id, status: input.status ?? current.status, approved_by: input.approvedBy ?? current.approved_by, payload_json: input.payloadJson ?? current.payload_json, result_json: input.resultJson ?? current.result_json, error_message: input.errorMessage ?? current.error_message });
    return mapOperation(getSqlite().prepare("SELECT * FROM operations WHERE id = ?").get(input.id) as OperationRow);
  },
  hasOpenOperationForCluster(clusterId: number) { return Boolean((getSqlite().prepare(`SELECT 1 AS ok FROM operations WHERE cluster_id = ? AND status IN ('pending', 'approved', 'executing') LIMIT 1`).get(clusterId) as { ok: number } | undefined)?.ok); },
  listStaleExecutingOperations(timeoutSec: number) { return (getSqlite().prepare(`SELECT * FROM operations WHERE status = 'executing' AND CAST((strftime('%s','now') - strftime('%s', updated_at)) AS INTEGER) > ? ORDER BY id ASC`).all(timeoutSec) as OperationRow[]).map(mapOperation); },
  updateOperationStatus(id: number, status: OperationStatus, errorMessage?: string) { return this.updateOperation({ id, status, errorMessage: errorMessage ?? null }); },
  listOperationsByStatus(status: OperationStatus, limit = 100) { return (getSqlite().prepare("SELECT * FROM operations WHERE status = ? ORDER BY id ASC LIMIT ?").all(status, limit) as OperationRow[]).map(mapOperation); },
  getLatestClusterOperationAgeSec(clusterId: number, excludeOperationId?: number) { const row = getSqlite().prepare(`SELECT CAST((strftime('%s','now') - strftime('%s', updated_at)) AS INTEGER) AS age_sec FROM operations WHERE cluster_id = ? AND (? IS NULL OR id <> ?) ORDER BY id DESC LIMIT 1`).get(clusterId, excludeOperationId ?? null, excludeOperationId ?? null) as { age_sec: number } | undefined; return row?.age_sec ?? null; },
  listOperations(limit = 100) { return (getSqlite().prepare("SELECT * FROM operations ORDER BY id DESC LIMIT ?").all(limit) as OperationRow[]).map(mapOperation); },

  upsertPosition(input: { walletId: number; coinAddress: `0x${string}`; costDelta: string; receivedDelta: string; holdingsDelta: string; isBuy: boolean; }): PositionRecord {
    const coin = input.coinAddress.toLowerCase();
    const existing = getSqlite().prepare("SELECT * FROM positions WHERE wallet_id = ? AND coin_address = ?").get(input.walletId, coin) as PositionRow | undefined;
    if (!existing) {
      getSqlite().prepare(`INSERT INTO positions (wallet_id, coin_address, total_cost_wei, total_received_wei, holdings_raw, realized_pnl_wei, buy_count, sell_count, last_action_at) VALUES (?, ?, ?, ?, ?, '0', ?, ?, CURRENT_TIMESTAMP)`).run(input.walletId, coin, input.costDelta, input.receivedDelta, input.holdingsDelta, input.isBuy ? 1 : 0, input.isBuy ? 0 : 1);
    } else {
      getSqlite().prepare(`UPDATE positions SET total_cost_wei = ?, total_received_wei = ?, holdings_raw = ?, buy_count = ?, sell_count = ?, last_action_at = CURRENT_TIMESTAMP WHERE wallet_id = ? AND coin_address = ?`).run((BigInt(existing.total_cost_wei) + BigInt(input.costDelta)).toString(), (BigInt(existing.total_received_wei) + BigInt(input.receivedDelta)).toString(), (BigInt(existing.holdings_raw) + BigInt(input.holdingsDelta)).toString(), existing.buy_count + (input.isBuy ? 1 : 0), existing.sell_count + (input.isBuy ? 0 : 1), input.walletId, coin);
    }
    return mapPosition(getSqlite().prepare("SELECT * FROM positions WHERE wallet_id = ? AND coin_address = ?").get(input.walletId, coin) as PositionRow);
  },
  getPosition(walletId: number, coinAddress: `0x${string}`) { const row = getSqlite().prepare("SELECT * FROM positions WHERE wallet_id = ? AND coin_address = ?").get(walletId, coinAddress.toLowerCase()) as PositionRow | undefined; return row ? mapPosition(row) : null; },
  listPositionsByWallet(walletId: number) { return (getSqlite().prepare("SELECT * FROM positions WHERE wallet_id = ? ORDER BY last_action_at DESC").all(walletId) as PositionRow[]).map(mapPosition); },
  listPositionsByCoin(coinAddress: `0x${string}`) { return (getSqlite().prepare("SELECT * FROM positions WHERE coin_address = ? ORDER BY wallet_id ASC").all(coinAddress.toLowerCase()) as PositionRow[]).map(mapPosition); },
  listPositionsByCluster(clusterId: number) { return (getSqlite().prepare(`SELECT p.* FROM positions p JOIN cluster_wallets cw ON cw.wallet_id = p.wallet_id WHERE cw.cluster_id = ? AND cw.enabled = 1 ORDER BY p.coin_address, p.wallet_id`).all(clusterId) as PositionRow[]).map(mapPosition); },
  listAllPositions() { return (getSqlite().prepare("SELECT * FROM positions ORDER BY last_action_at DESC").all() as PositionRow[]).map(mapPosition); },

  createSwingConfig(input: { fleetName: string; coinAddress: `0x${string}`; takeProfitBps?: number; stopLossBps?: number; trailingStopBps?: number | null; cooldownSec?: number; slippageBps?: number; }): SwingConfigRecord {
    const result = getSqlite().prepare(`INSERT INTO swing_configs (fleet_name, coin_address, take_profit_bps, stop_loss_bps, trailing_stop_bps, cooldown_sec, slippage_bps) VALUES (@fleet_name, @coin_address, @take_profit_bps, @stop_loss_bps, @trailing_stop_bps, @cooldown_sec, @slippage_bps)`).run({ fleet_name: input.fleetName, coin_address: input.coinAddress.toLowerCase(), take_profit_bps: input.takeProfitBps ?? 1500, stop_loss_bps: input.stopLossBps ?? 2000, trailing_stop_bps: input.trailingStopBps ?? null, cooldown_sec: input.cooldownSec ?? 300, slippage_bps: input.slippageBps ?? 500 });
    return mapSwingConfig(getSqlite().prepare("SELECT * FROM swing_configs WHERE id = ?").get(result.lastInsertRowid) as SwingConfigRow);
  },
  getSwingConfig(fleetName: string, coinAddress: `0x${string}`) { const row = getSqlite().prepare("SELECT * FROM swing_configs WHERE fleet_name = ? AND coin_address = ?").get(fleetName, coinAddress.toLowerCase()) as SwingConfigRow | undefined; return row ? mapSwingConfig(row) : null; },
  listSwingConfigs(enabledOnly?: boolean) { return (getSqlite().prepare(enabledOnly ? "SELECT * FROM swing_configs WHERE enabled = 1 ORDER BY id ASC" : "SELECT * FROM swing_configs ORDER BY id ASC").all() as SwingConfigRow[]).map(mapSwingConfig); },
  updateSwingConfig(id: number, patch: Partial<{ takeProfitBps: number; stopLossBps: number; trailingStopBps: number | null; cooldownSec: number; slippageBps: number; enabled: boolean; peakPnlBps: number | null; lastActionAt: string | null; }>): SwingConfigRecord {
    const current = getSqlite().prepare("SELECT * FROM swing_configs WHERE id = ?").get(id) as SwingConfigRow | undefined; if (!current) throw new Error(`Swing config ${id} not found`);
    getSqlite().prepare(`UPDATE swing_configs SET take_profit_bps = @take_profit_bps, stop_loss_bps = @stop_loss_bps, trailing_stop_bps = @trailing_stop_bps, cooldown_sec = @cooldown_sec, slippage_bps = @slippage_bps, enabled = @enabled, peak_pnl_bps = @peak_pnl_bps, last_action_at = @last_action_at WHERE id = @id`).run({ id, take_profit_bps: patch.takeProfitBps ?? current.take_profit_bps, stop_loss_bps: patch.stopLossBps ?? current.stop_loss_bps, trailing_stop_bps: patch.trailingStopBps !== undefined ? patch.trailingStopBps : current.trailing_stop_bps, cooldown_sec: patch.cooldownSec ?? current.cooldown_sec, slippage_bps: patch.slippageBps ?? current.slippage_bps, enabled: patch.enabled !== undefined ? (patch.enabled ? 1 : 0) : current.enabled, peak_pnl_bps: patch.peakPnlBps !== undefined ? patch.peakPnlBps : current.peak_pnl_bps, last_action_at: patch.lastActionAt !== undefined ? patch.lastActionAt : current.last_action_at });
    return mapSwingConfig(getSqlite().prepare("SELECT * FROM swing_configs WHERE id = ?").get(id) as SwingConfigRow);
  },
  deleteSwingConfig(id: number) { return getSqlite().prepare("DELETE FROM swing_configs WHERE id = ?").run(id).changes > 0; },

  createCampaign(input: { coinAddress: `0x${string}`; name: string; symbol: string; status: CampaignStatus; phase: CampaignPhase; deployTxHash?: `0x${string}` | null; deploySource?: string | null; metadataUri?: string | null; targetAllocationBps?: number; selfSnipeEthWei?: string; totalBuyEthWei?: string; totalSellEthWei?: string; totalBurnedTokens?: string; pnlEthWei?: string; startedAt: string; endsAt: string; dryRun?: boolean; notes?: string | null; }): CampaignRecord {
    const result = getSqlite().prepare(`INSERT INTO campaigns (coin_address, name, symbol, status, phase, deploy_tx_hash, deploy_source, metadata_uri, target_allocation_bps, self_snipe_eth_wei, total_buy_eth_wei, total_sell_eth_wei, total_burned_tokens, pnl_eth_wei, started_at, ends_at, dry_run, notes, updated_at) VALUES (@coin_address, @name, @symbol, @status, @phase, @deploy_tx_hash, @deploy_source, @metadata_uri, @target_allocation_bps, @self_snipe_eth_wei, @total_buy_eth_wei, @total_sell_eth_wei, @total_burned_tokens, @pnl_eth_wei, @started_at, @ends_at, @dry_run, @notes, CURRENT_TIMESTAMP)`).run({ coin_address: input.coinAddress.toLowerCase(), name: input.name, symbol: input.symbol, status: input.status, phase: input.phase, deploy_tx_hash: input.deployTxHash ?? null, deploy_source: input.deploySource ?? null, metadata_uri: input.metadataUri ?? null, target_allocation_bps: input.targetAllocationBps ?? 100, self_snipe_eth_wei: input.selfSnipeEthWei ?? "0", total_buy_eth_wei: input.totalBuyEthWei ?? "0", total_sell_eth_wei: input.totalSellEthWei ?? "0", total_burned_tokens: input.totalBurnedTokens ?? "0", pnl_eth_wei: input.pnlEthWei ?? "0", started_at: input.startedAt, ends_at: input.endsAt, dry_run: input.dryRun ? 1 : 0, notes: input.notes ?? null });
    return mapCampaign(getSqlite().prepare("SELECT * FROM campaigns WHERE id = ?").get(result.lastInsertRowid) as CampaignRow);
  },
  getCampaignById(id: number) { const row = getSqlite().prepare("SELECT * FROM campaigns WHERE id = ?").get(id) as CampaignRow | undefined; return row ? mapCampaign(row) : null; },
  getCampaignByCoinAddress(coinAddress: `0x${string}`) { const row = getSqlite().prepare("SELECT * FROM campaigns WHERE coin_address = ?").get(coinAddress.toLowerCase()) as CampaignRow | undefined; return row ? mapCampaign(row) : null; },
  listCampaigns() { return (getSqlite().prepare("SELECT * FROM campaigns ORDER BY started_at DESC, id DESC").all() as CampaignRow[]).map(mapCampaign); },
  listCampaignsByStatus(statuses: CampaignStatus[]) { if (!statuses.length) return []; const placeholders = statuses.map(() => "?").join(", "); return (getSqlite().prepare(`SELECT * FROM campaigns WHERE status IN (${placeholders}) ORDER BY started_at ASC, id ASC`).all(...statuses) as CampaignRow[]).map(mapCampaign); },
  updateCampaign(id: number, patch: Partial<{ name: string; symbol: string; status: CampaignStatus; phase: CampaignPhase; deployTxHash: `0x${string}` | null; deploySource: string | null; metadataUri: string | null; targetAllocationBps: number; selfSnipeEthWei: string; totalBuyEthWei: string; totalSellEthWei: string; totalBurnedTokens: string; pnlEthWei: string; holders: number; externalVolume24hUsd: number; externalSwapCount24h: number; lastMetricsAt: string | null; lastExecutionAt: string | null; startedAt: string; endsAt: string; settlementMode: CampaignSettlementMode | null; settlementAt: string | null; settlementNotes: string | null; retainedAllocationBps: number; recoverAllocationBps: number; treasuryRetainedEthWei: string; burnGainEthWei: string; dryRun: boolean; notes: string | null; }>): CampaignRecord {
    const current = getSqlite().prepare("SELECT * FROM campaigns WHERE id = ?").get(id) as CampaignRow | undefined; if (!current) throw new Error(`Campaign ${id} not found`);
    getSqlite().prepare(`UPDATE campaigns SET name=@name, symbol=@symbol, status=@status, phase=@phase, deploy_tx_hash=@deploy_tx_hash, deploy_source=@deploy_source, metadata_uri=@metadata_uri, target_allocation_bps=@target_allocation_bps, self_snipe_eth_wei=@self_snipe_eth_wei, total_buy_eth_wei=@total_buy_eth_wei, total_sell_eth_wei=@total_sell_eth_wei, total_burned_tokens=@total_burned_tokens, pnl_eth_wei=@pnl_eth_wei, holders=@holders, external_volume_24h_usd=@external_volume_24h_usd, external_swap_count_24h=@external_swap_count_24h, last_metrics_at=@last_metrics_at, last_execution_at=@last_execution_at, started_at=@started_at, ends_at=@ends_at, settlement_mode=@settlement_mode, settlement_at=@settlement_at, settlement_notes=@settlement_notes, retained_allocation_bps=@retained_allocation_bps, recover_allocation_bps=@recover_allocation_bps, treasury_retained_eth_wei=@treasury_retained_eth_wei, burn_gain_eth_wei=@burn_gain_eth_wei, dry_run=@dry_run, notes=@notes, updated_at=CURRENT_TIMESTAMP WHERE id=@id`).run({
      id,
      name: patch.name ?? current.name,
      symbol: patch.symbol ?? current.symbol,
      status: patch.status ?? current.status,
      phase: patch.phase ?? current.phase,
      deploy_tx_hash: patch.deployTxHash !== undefined ? patch.deployTxHash : current.deploy_tx_hash,
      deploy_source: patch.deploySource !== undefined ? patch.deploySource : current.deploy_source,
      metadata_uri: patch.metadataUri !== undefined ? patch.metadataUri : current.metadata_uri,
      target_allocation_bps: patch.targetAllocationBps ?? current.target_allocation_bps,
      self_snipe_eth_wei: patch.selfSnipeEthWei ?? current.self_snipe_eth_wei,
      total_buy_eth_wei: patch.totalBuyEthWei ?? current.total_buy_eth_wei,
      total_sell_eth_wei: patch.totalSellEthWei ?? current.total_sell_eth_wei,
      total_burned_tokens: patch.totalBurnedTokens ?? current.total_burned_tokens,
      pnl_eth_wei: patch.pnlEthWei ?? current.pnl_eth_wei,
      holders: patch.holders ?? current.holders,
      external_volume_24h_usd: patch.externalVolume24hUsd ?? current.external_volume_24h_usd,
      external_swap_count_24h: patch.externalSwapCount24h ?? current.external_swap_count_24h,
      last_metrics_at: patch.lastMetricsAt !== undefined ? patch.lastMetricsAt : current.last_metrics_at,
      last_execution_at: patch.lastExecutionAt !== undefined ? patch.lastExecutionAt : current.last_execution_at,
      started_at: patch.startedAt ?? current.started_at,
      ends_at: patch.endsAt ?? current.ends_at,
      settlement_mode: patch.settlementMode !== undefined ? patch.settlementMode : current.settlement_mode,
      settlement_at: patch.settlementAt !== undefined ? patch.settlementAt : current.settlement_at,
      settlement_notes: patch.settlementNotes !== undefined ? patch.settlementNotes : current.settlement_notes,
      retained_allocation_bps: patch.retainedAllocationBps ?? current.retained_allocation_bps,
      recover_allocation_bps: patch.recoverAllocationBps ?? current.recover_allocation_bps,
      treasury_retained_eth_wei: patch.treasuryRetainedEthWei ?? current.treasury_retained_eth_wei,
      burn_gain_eth_wei: patch.burnGainEthWei ?? current.burn_gain_eth_wei,
      dry_run: patch.dryRun !== undefined ? (patch.dryRun ? 1 : 0) : current.dry_run,
      notes: patch.notes !== undefined ? patch.notes : current.notes,
    });
    return mapCampaign(getSqlite().prepare("SELECT * FROM campaigns WHERE id = ?").get(id) as CampaignRow);
  },

  createCampaignMetricsSnapshot(input: { campaignId: number; holders: number; volume24hUsd: number; swaps24h: number; netFlow24hUsd: number; momentumScore: number; externalWalletBuyCount24h: number; createdAt?: string; }): CampaignMetricsSnapshotRecord {
    const result = getSqlite().prepare(`INSERT INTO campaign_metrics_snapshots (campaign_id, holders, volume_24h_usd, swaps_24h, net_flow_24h_usd, momentum_score, external_wallet_buy_count_24h, created_at) VALUES (@campaign_id, @holders, @volume_24h_usd, @swaps_24h, @net_flow_24h_usd, @momentum_score, @external_wallet_buy_count_24h, COALESCE(@created_at, CURRENT_TIMESTAMP))`).run({ campaign_id: input.campaignId, holders: input.holders, volume_24h_usd: input.volume24hUsd, swaps_24h: input.swaps24h, net_flow_24h_usd: input.netFlow24hUsd, momentum_score: input.momentumScore, external_wallet_buy_count_24h: input.externalWalletBuyCount24h, created_at: input.createdAt ?? null });
    return mapCampaignMetricsSnapshot(getSqlite().prepare("SELECT * FROM campaign_metrics_snapshots WHERE id = ?").get(result.lastInsertRowid) as CampaignMetricsSnapshotRow);
  },
  getLatestCampaignMetricsSnapshot(campaignId: number) { const row = getSqlite().prepare("SELECT * FROM campaign_metrics_snapshots WHERE campaign_id = ? ORDER BY created_at DESC, id DESC LIMIT 1").get(campaignId) as CampaignMetricsSnapshotRow | undefined; return row ? mapCampaignMetricsSnapshot(row) : null; },

  createCampaignPlan(input: { campaignId: number; phase: CampaignPhase; rationale: string; status: CampaignPlanStatus; plannedFor: string; maxConcurrentCampaigns: number; }): CampaignPlan {
    const result = getSqlite().prepare(`INSERT INTO campaign_plans (campaign_id, phase, rationale, status, planned_for, max_concurrent_campaigns) VALUES (@campaign_id, @phase, @rationale, @status, @planned_for, @max_concurrent_campaigns)`).run({ campaign_id: input.campaignId, phase: input.phase, rationale: input.rationale, status: input.status, planned_for: input.plannedFor, max_concurrent_campaigns: input.maxConcurrentCampaigns });
    return mapCampaignPlan(getSqlite().prepare("SELECT * FROM campaign_plans WHERE id = ?").get(result.lastInsertRowid) as CampaignPlanRow);
  },

  createCampaignPlanStep(input: { campaignId: number; planId: number; side: CampaignTradeSide; sequenceNo: number; scheduledFor: string; amountWei: string; slippageBps: number; status: CampaignPlanStepStatus; rationale: string; }): CampaignPlanStep {
    const result = getSqlite().prepare(`INSERT INTO campaign_plan_steps (campaign_id, plan_id, side, sequence_no, scheduled_for, amount_wei, slippage_bps, status, rationale) VALUES (@campaign_id, @plan_id, @side, @sequence_no, @scheduled_for, @amount_wei, @slippage_bps, @status, @rationale)`).run({ campaign_id: input.campaignId, plan_id: input.planId, side: input.side, sequence_no: input.sequenceNo, scheduled_for: input.scheduledFor, amount_wei: input.amountWei, slippage_bps: input.slippageBps, status: input.status, rationale: input.rationale });
    return mapCampaignPlanStep(getSqlite().prepare("SELECT * FROM campaign_plan_steps WHERE id = ?").get(result.lastInsertRowid) as CampaignPlanStepRow);
  },
  listCampaignPlanSteps(campaignId: number, statuses?: CampaignPlanStepStatus[]) {
    if (!statuses?.length) return (getSqlite().prepare("SELECT * FROM campaign_plan_steps WHERE campaign_id = ? ORDER BY sequence_no ASC, id ASC").all(campaignId) as CampaignPlanStepRow[]).map(mapCampaignPlanStep);
    const placeholders = statuses.map(() => "?").join(", ");
    return (getSqlite().prepare(`SELECT * FROM campaign_plan_steps WHERE campaign_id = ? AND status IN (${placeholders}) ORDER BY sequence_no ASC, id ASC`).all(campaignId, ...statuses) as CampaignPlanStepRow[]).map(mapCampaignPlanStep);
  },
  listDueCampaignPlanSteps(nowIso: string) { return (getSqlite().prepare("SELECT * FROM campaign_plan_steps WHERE status IN ('ready', 'pending') AND datetime(scheduled_for) <= datetime(?) ORDER BY scheduled_for ASC, id ASC").all(nowIso) as CampaignPlanStepRow[]).map(mapCampaignPlanStep); },
  updateCampaignPlanStep(id: number, patch: Partial<{ status: CampaignPlanStepStatus; scheduledFor: string; amountWei: string; slippageBps: number; rationale: string; startedAt: string | null; completedAt: string | null; executionId: number | null; }>): CampaignPlanStep {
    const current = getSqlite().prepare("SELECT * FROM campaign_plan_steps WHERE id = ?").get(id) as CampaignPlanStepRow | undefined; if (!current) throw new Error(`Campaign plan step ${id} not found`);
    getSqlite().prepare(`UPDATE campaign_plan_steps SET status=@status, scheduled_for=@scheduled_for, amount_wei=@amount_wei, slippage_bps=@slippage_bps, rationale=@rationale, started_at=@started_at, completed_at=@completed_at, execution_id=@execution_id WHERE id=@id`).run({ id, status: patch.status ?? current.status, scheduled_for: patch.scheduledFor ?? current.scheduled_for, amount_wei: patch.amountWei ?? current.amount_wei, slippage_bps: patch.slippageBps ?? current.slippage_bps, rationale: patch.rationale ?? current.rationale, started_at: patch.startedAt !== undefined ? patch.startedAt : current.started_at, completed_at: patch.completedAt !== undefined ? patch.completedAt : current.completed_at, execution_id: patch.executionId !== undefined ? patch.executionId : current.execution_id });
    return mapCampaignPlanStep(getSqlite().prepare("SELECT * FROM campaign_plan_steps WHERE id = ?").get(id) as CampaignPlanStepRow);
  },

  createCampaignExecution(input: { campaignId: number; planId: number | null; stepId: number | null; side: CampaignTradeSide; status: CampaignExecutionStatus; amountInWei: string; amountOutRaw: string | null; txHash: `0x${string}` | null; userOpHash: `0x${string}` | null; summary: string | null; simulationOnly: boolean; reason: string | null; createdAt?: string; completedAt?: string | null; }): CampaignExecutionRecord {
    const result = getSqlite().prepare(`INSERT INTO campaign_executions (campaign_id, plan_id, step_id, side, status, amount_in_wei, amount_out_raw, tx_hash, user_op_hash, summary, simulation_only, reason, created_at, completed_at) VALUES (@campaign_id, @plan_id, @step_id, @side, @status, @amount_in_wei, @amount_out_raw, @tx_hash, @user_op_hash, @summary, @simulation_only, @reason, COALESCE(@created_at, CURRENT_TIMESTAMP), @completed_at)`).run({ campaign_id: input.campaignId, plan_id: input.planId, step_id: input.stepId, side: input.side, status: input.status, amount_in_wei: input.amountInWei, amount_out_raw: input.amountOutRaw, tx_hash: input.txHash, user_op_hash: input.userOpHash, summary: input.summary, simulation_only: input.simulationOnly ? 1 : 0, reason: input.reason, created_at: input.createdAt ?? null, completed_at: input.completedAt ?? null });
    return mapCampaignExecution(getSqlite().prepare("SELECT * FROM campaign_executions WHERE id = ?").get(result.lastInsertRowid) as CampaignExecutionRow);
  },
  listCampaignExecutions(campaignId: number) { return (getSqlite().prepare("SELECT * FROM campaign_executions WHERE campaign_id = ? ORDER BY created_at DESC, id DESC").all(campaignId) as CampaignExecutionRow[]).map(mapCampaignExecution); },

  deleteWallet(id: number) { const sqlite = getSqlite(); sqlite.prepare("DELETE FROM cluster_wallets WHERE wallet_id = ?").run(id); return sqlite.prepare("DELETE FROM wallets WHERE id = ?").run(id).changes > 0; },
  deleteCluster(id: number) { const sqlite = getSqlite(); sqlite.prepare("DELETE FROM cluster_wallets WHERE cluster_id = ?").run(id); return sqlite.prepare("DELETE FROM clusters WHERE id = ?").run(id).changes > 0; },
};
