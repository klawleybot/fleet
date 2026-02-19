import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { runMigrations } from "./schema.js";
import type {
  ClusterRecord,
  ClusterWalletRecord,
  FundingRecord,
  FundingStatus,
  OperationRecord,
  OperationStatus,
  OperationType,
  StrategyMode,
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
  user_op_hash: string | null;
  tx_hash: string | null;
  status: TradeStatus;
  error_message: string | null;
  created_at: string;
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
    userOpHash: row.user_op_hash as `0x${string}` | null,
    txHash: row.tx_hash as `0x${string}` | null,
    status: row.status,
    errorMessage: row.error_message,
    createdAt: row.created_at,
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

const dbDirectory = path.resolve(process.cwd(), ".data");
fs.mkdirSync(dbDirectory, { recursive: true });
const dbPath = process.env.SQLITE_PATH ?? path.resolve(dbDirectory, "pump-it-up.db");

const sqlite = new Database(dbPath);
runMigrations(sqlite);

export const db = {
  createWallet(input: {
    name: string;
    address: `0x${string}`;
    cdpAccountName: string;
    ownerAddress: `0x${string}`;
    type: "smart";
    isMaster: boolean;
  }): WalletRecord {
    const result = sqlite
      .prepare(
        `INSERT INTO wallets (name, address, cdp_account_name, owner_address, type, is_master)
         VALUES (@name, @address, @cdp_account_name, @owner_address, @type, @is_master)`,
      )
      .run({
        name: input.name,
        address: input.address,
        cdp_account_name: input.cdpAccountName,
        owner_address: input.ownerAddress,
        type: input.type,
        is_master: input.isMaster ? 1 : 0,
      });

    const row = sqlite
      .prepare("SELECT * FROM wallets WHERE id = ?")
      .get(result.lastInsertRowid) as WalletRow;
    return mapWallet(row);
  },

  getWalletById(id: number): WalletRecord | null {
    const row = sqlite.prepare("SELECT * FROM wallets WHERE id = ?").get(id) as
      | WalletRow
      | undefined;
    return row ? mapWallet(row) : null;
  },

  getWalletByName(name: string): WalletRecord | null {
    const row = sqlite.prepare("SELECT * FROM wallets WHERE name = ?").get(name) as
      | WalletRow
      | undefined;
    return row ? mapWallet(row) : null;
  },

  getMasterWallet(): WalletRecord | null {
    const row = sqlite
      .prepare("SELECT * FROM wallets WHERE is_master = 1 LIMIT 1")
      .get() as WalletRow | undefined;
    return row ? mapWallet(row) : null;
  },

  listWallets(): WalletRecord[] {
    const rows = sqlite
      .prepare("SELECT * FROM wallets ORDER BY id ASC")
      .all() as WalletRow[];
    return rows.map(mapWallet);
  },

  createTrade(input: {
    walletId: number;
    fromToken: `0x${string}`;
    toToken: `0x${string}`;
    amountIn: string;
    userOpHash: `0x${string}` | null;
    txHash: `0x${string}` | null;
    status: TradeStatus;
    errorMessage: string | null;
  }): TradeRecord {
    const result = sqlite
      .prepare(
        `INSERT INTO trades (wallet_id, from_token, to_token, amount_in, user_op_hash, tx_hash, status, error_message)
         VALUES (@wallet_id, @from_token, @to_token, @amount_in, @user_op_hash, @tx_hash, @status, @error_message)`,
      )
      .run({
        wallet_id: input.walletId,
        from_token: input.fromToken,
        to_token: input.toToken,
        amount_in: input.amountIn,
        user_op_hash: input.userOpHash,
        tx_hash: input.txHash,
        status: input.status,
        error_message: input.errorMessage,
      });

    const row = sqlite
      .prepare("SELECT * FROM trades WHERE id = ?")
      .get(result.lastInsertRowid) as TradeRow;
    return mapTrade(row);
  },

  listTrades(): TradeRecord[] {
    const rows = sqlite
      .prepare("SELECT * FROM trades ORDER BY id DESC")
      .all() as TradeRow[];
    return rows.map(mapTrade);
  },

  createFunding(input: {
    fromWalletId: number;
    toWalletId: number;
    amountWei: string;
    userOpHash: `0x${string}` | null;
    txHash: `0x${string}` | null;
    status: FundingStatus;
    errorMessage: string | null;
  }): FundingRecord {
    const result = sqlite
      .prepare(
        `INSERT INTO funding_txs (from_wallet_id, to_wallet_id, amount_wei, user_op_hash, tx_hash, status, error_message)
         VALUES (@from_wallet_id, @to_wallet_id, @amount_wei, @user_op_hash, @tx_hash, @status, @error_message)`,
      )
      .run({
        from_wallet_id: input.fromWalletId,
        to_wallet_id: input.toWalletId,
        amount_wei: input.amountWei,
        user_op_hash: input.userOpHash,
        tx_hash: input.txHash,
        status: input.status,
        error_message: input.errorMessage,
      });

    const row = sqlite
      .prepare("SELECT * FROM funding_txs WHERE id = ?")
      .get(result.lastInsertRowid) as FundingRow;
    return mapFunding(row);
  },

  listFunding(): FundingRecord[] {
    const rows = sqlite
      .prepare("SELECT * FROM funding_txs ORDER BY id DESC")
      .all() as FundingRow[];
    return rows.map(mapFunding);
  },

  createCluster(input: { name: string; strategyMode: StrategyMode }): ClusterRecord {
    const result = sqlite
      .prepare(`INSERT INTO clusters (name, strategy_mode) VALUES (@name, @strategy_mode)`)
      .run({ name: input.name, strategy_mode: input.strategyMode });
    const row = sqlite.prepare("SELECT * FROM clusters WHERE id = ?").get(result.lastInsertRowid) as ClusterRow;
    return mapCluster(row);
  },

  getClusterById(id: number): ClusterRecord | null {
    const row = sqlite.prepare("SELECT * FROM clusters WHERE id = ?").get(id) as ClusterRow | undefined;
    return row ? mapCluster(row) : null;
  },

  getClusterByName(name: string): ClusterRecord | null {
    const row = sqlite.prepare("SELECT * FROM clusters WHERE name = ?").get(name) as ClusterRow | undefined;
    return row ? mapCluster(row) : null;
  },

  listClusters(): ClusterRecord[] {
    const rows = sqlite.prepare("SELECT * FROM clusters ORDER BY id ASC").all() as ClusterRow[];
    return rows.map(mapCluster);
  },

  setClusterWallets(clusterId: number, walletIds: number[]): ClusterWalletRecord[] {
    const uniqueWalletIds = [...new Set(walletIds)];
    const tx = sqlite.transaction((ids: number[]) => {
      sqlite.prepare("DELETE FROM cluster_wallets WHERE cluster_id = ?").run(clusterId);
      const insert = sqlite.prepare(`
        INSERT INTO cluster_wallets (cluster_id, wallet_id, enabled, weight)
        VALUES (?, ?, 1, 1)
      `);
      for (const walletId of ids) {
        insert.run(clusterId, walletId);
      }
    });
    tx(uniqueWalletIds);

    const rows = sqlite
      .prepare("SELECT * FROM cluster_wallets WHERE cluster_id = ? ORDER BY wallet_id ASC")
      .all(clusterId) as ClusterWalletRow[];
    return rows.map(mapClusterWallet);
  },

  listClusterWallets(clusterId: number): ClusterWalletRecord[] {
    const rows = sqlite
      .prepare("SELECT * FROM cluster_wallets WHERE cluster_id = ? ORDER BY wallet_id ASC")
      .all(clusterId) as ClusterWalletRow[];
    return rows.map(mapClusterWallet);
  },

  listClusterWalletDetails(clusterId: number): WalletRecord[] {
    const rows = sqlite
      .prepare(`
        SELECT w.*
        FROM cluster_wallets cw
        JOIN wallets w ON w.id = cw.wallet_id
        WHERE cw.cluster_id = ? AND cw.enabled = 1
        ORDER BY w.id ASC
      `)
      .all(clusterId) as WalletRow[];
    return rows.map(mapWallet);
  },

  createOperation(input: {
    type: OperationType;
    clusterId: number;
    status?: OperationStatus;
    requestedBy?: string | null;
    approvedBy?: string | null;
    payloadJson: string;
    resultJson?: string | null;
    errorMessage?: string | null;
  }): OperationRecord {
    const result = sqlite
      .prepare(`
        INSERT INTO operations (type, cluster_id, status, requested_by, approved_by, payload_json, result_json, error_message, updated_at)
        VALUES (@type, @cluster_id, @status, @requested_by, @approved_by, @payload_json, @result_json, @error_message, CURRENT_TIMESTAMP)
      `)
      .run({
        type: input.type,
        cluster_id: input.clusterId,
        status: input.status ?? "pending",
        requested_by: input.requestedBy ?? null,
        approved_by: input.approvedBy ?? null,
        payload_json: input.payloadJson,
        result_json: input.resultJson ?? null,
        error_message: input.errorMessage ?? null,
      });

    const row = sqlite.prepare("SELECT * FROM operations WHERE id = ?").get(result.lastInsertRowid) as OperationRow;
    return mapOperation(row);
  },

  getOperationById(id: number): OperationRecord | null {
    const row = sqlite.prepare("SELECT * FROM operations WHERE id = ?").get(id) as OperationRow | undefined;
    return row ? mapOperation(row) : null;
  },

  updateOperation(input: {
    id: number;
    status?: OperationStatus;
    approvedBy?: string | null;
    payloadJson?: string;
    resultJson?: string | null;
    errorMessage?: string | null;
  }): OperationRecord {
    const current = sqlite.prepare("SELECT * FROM operations WHERE id = ?").get(input.id) as OperationRow | undefined;
    if (!current) throw new Error(`Operation ${input.id} not found`);

    sqlite
      .prepare(`
        UPDATE operations
        SET status = @status,
            approved_by = @approved_by,
            payload_json = @payload_json,
            result_json = @result_json,
            error_message = @error_message,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = @id
      `)
      .run({
        id: input.id,
        status: input.status ?? current.status,
        approved_by: input.approvedBy ?? current.approved_by,
        payload_json: input.payloadJson ?? current.payload_json,
        result_json: input.resultJson ?? current.result_json,
        error_message: input.errorMessage ?? current.error_message,
      });

    const row = sqlite.prepare("SELECT * FROM operations WHERE id = ?").get(input.id) as OperationRow;
    return mapOperation(row);
  },

  hasOpenOperationForCluster(clusterId: number): boolean {
    const row = sqlite
      .prepare(`
        SELECT 1 AS ok
        FROM operations
        WHERE cluster_id = ?
          AND status IN ('pending', 'approved', 'executing')
        LIMIT 1
      `)
      .get(clusterId) as { ok: number } | undefined;
    return Boolean(row?.ok);
  },

  listOperationsByStatus(status: OperationStatus, limit = 100): OperationRecord[] {
    const rows = sqlite
      .prepare("SELECT * FROM operations WHERE status = ? ORDER BY id ASC LIMIT ?")
      .all(status, limit) as OperationRow[];
    return rows.map(mapOperation);
  },

  getLatestClusterOperationAgeSec(clusterId: number, excludeOperationId?: number): number | null {
    const row = sqlite
      .prepare(`
        SELECT CAST((strftime('%s','now') - strftime('%s', updated_at)) AS INTEGER) AS age_sec
        FROM operations
        WHERE cluster_id = ?
          AND (? IS NULL OR id <> ?)
        ORDER BY id DESC
        LIMIT 1
      `)
      .get(clusterId, excludeOperationId ?? null, excludeOperationId ?? null) as { age_sec: number } | undefined;

    if (!row || row.age_sec === null || row.age_sec === undefined) return null;
    return Number(row.age_sec);
  },

  listOperations(limit = 100): OperationRecord[] {
    const rows = sqlite
      .prepare("SELECT * FROM operations ORDER BY id DESC LIMIT ?")
      .all(limit) as OperationRow[];
    return rows.map(mapOperation);
  },
};

