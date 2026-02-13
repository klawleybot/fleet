import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { runMigrations } from "./schema.js";
import type {
  FundingRecord,
  FundingStatus,
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
};

