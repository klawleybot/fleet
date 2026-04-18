/**
 * Bad Actor Cluster Tracker
 *
 * Monitors known bad actor addresses for outbound token transfers (ETH, WETH, ZORA, USDC).
 * When a bad actor sends >$250 to a new wallet, auto-adds the recipient to the bad_actors
 * table as a cluster member under the original root actor's label.
 *
 * Uses viem getLogs for ERC-20 Transfer events and eth_getBlockByNumber for native ETH.
 */

import { createPublicClient, http, parseAbiItem, formatEther, formatUnits, type Address, type Hex } from "viem";
import { base } from "viem/chains";
import type Database from "better-sqlite3";
import { addBadActor, listBadActors } from "./bad-actors.js";

// Token addresses on Base mainnet
const WETH = "0x4200000000000000000000000000000000000006" as Address;
const ZORA = "0x1111111111166b7fe7bd91427724b487980afc69" as Address;
const USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913" as Address;

// ERC-20 Transfer event
const TRANSFER_EVENT = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)");

// Minimum USD value to trigger auto-add
const MIN_TRANSFER_USD = 250;

// Approximate token prices — updated each tick from external source if available
// Fallback hardcoded values (conservative)
interface TokenPrices {
  ethUsd: number;
  zoraUsd: number;
  usdcUsd: number;
}

function getDefaultPrices(): TokenPrices {
  return { ethUsd: 2000, zoraUsd: 0.01, usdcUsd: 1.0 };
}

// How many blocks to look back per tick (~2s block time on Base)
const DEFAULT_LOOKBACK_BLOCKS = 1000n; // ~33 minutes
const MAX_LOOKBACK_BLOCKS = 5000n;

export interface TrackerConfig {
  rpcUrl?: string;
  minTransferUsd?: number;
  lookbackBlocks?: bigint;
  maxDepth?: number; // cluster depth: 1 = first-hop only, 2 = two hops, etc.
}

export interface TransferDetection {
  fromAddress: string;
  toAddress: string;
  tokenSymbol: string;
  amountRaw: bigint;
  amountFormatted: string;
  estimatedUsd: number;
  txHash: string;
  blockNumber: bigint;
  rootActor: string; // label of the root bad actor
}

interface TrackerState {
  lastScannedBlock: bigint;
}

interface TrackerClient {
  getBlockNumber(): Promise<bigint>;
  getLogs(args: {
    address: Address;
    event: typeof TRANSFER_EVENT;
    args: { from: Address[] };
    fromBlock: bigint;
    toBlock: bigint;
  }): Promise<TransferLog[]>;
}

type PriceRow = {
  price: number | null;
};

type TransferLog = {
  args?: {
    from?: Address;
    to?: Address;
    value?: bigint;
  };
  transactionHash?: Hex | null;
  blockNumber?: bigint | null;
};

type RecentTransferRow = {
  fromAddress: string;
  toAddress: string;
  tokenSymbol: string;
  amountFormatted: string;
  estimatedUsd: number;
  txHash: string;
  rootActor: string | null;
  autoAdded: number;
  createdAt: string;
};

type ClusterSummaryRow = {
  address: string;
  label: string | null;
  depth: number;
  reason: string | null;
};

function messageFromError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function writeInfoLine(message: string): void {
  process.stdout.write(`${message}\n`);
}

export class BadActorTracker {
  private readonly db: Database.Database;
  private readonly client: TrackerClient;
  private readonly minTransferUsd: number;
  private readonly lookbackBlocks: bigint;
  private readonly maxDepth: number;
  private state: TrackerState;

  constructor(db: Database.Database, config: TrackerConfig = {}) {
    this.db = db;
    this.minTransferUsd = config.minTransferUsd ?? MIN_TRANSFER_USD;
    this.lookbackBlocks = config.lookbackBlocks ?? DEFAULT_LOOKBACK_BLOCKS;
    this.maxDepth = config.maxDepth ?? 1;

    const rpcUrl = config.rpcUrl || process.env.BASE_RPC_URL;
    if (!rpcUrl) throw new Error("[bad-actor-tracker] BASE_RPC_URL required");

    this.client = createPublicClient({
      chain: base,
      transport: http(rpcUrl),
    });

    // Ensure schema
    this.ensureSchema();

    // Load state
    const row = this.db.prepare(
      `SELECT last_scanned_block FROM bad_actor_tracker_state WHERE id = 1`
    ).get() as { last_scanned_block: number } | undefined;
    this.state = { lastScannedBlock: BigInt(row?.last_scanned_block ?? 0) };
  }

  private ensureSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS bad_actor_tracker_state (
        id INTEGER PRIMARY KEY DEFAULT 1,
        last_scanned_block INTEGER NOT NULL DEFAULT 0
      );
      INSERT OR IGNORE INTO bad_actor_tracker_state (id, last_scanned_block) VALUES (1, 0);
    `);

    // Add root_actor and cluster_id columns to bad_actors if missing
    const cols = this.db.prepare("PRAGMA table_info(bad_actors)").all() as Array<{ name: string }>;
    const hasCol = (name: string) => cols.some(c => c.name === name);
    if (!hasCol("root_actor")) {
      this.db.exec("ALTER TABLE bad_actors ADD COLUMN root_actor TEXT");
    }
    if (!hasCol("cluster_id")) {
      this.db.exec("ALTER TABLE bad_actors ADD COLUMN cluster_id TEXT");
    }
    if (!hasCol("depth")) {
      this.db.exec("ALTER TABLE bad_actors ADD COLUMN depth INTEGER NOT NULL DEFAULT 0");
    }

    // Create transfer log table for audit trail
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS bad_actor_transfers (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        from_address TEXT NOT NULL,
        to_address TEXT NOT NULL,
        token_symbol TEXT NOT NULL,
        amount_formatted TEXT NOT NULL,
        estimated_usd REAL NOT NULL,
        tx_hash TEXT NOT NULL,
        block_number INTEGER NOT NULL,
        root_actor TEXT,
        auto_added INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        UNIQUE(tx_hash, from_address, to_address, token_symbol)
      );
    `);
  }

  private saveState(): void {
    this.db.prepare(
      `UPDATE bad_actor_tracker_state SET last_scanned_block = ? WHERE id = 1`
    ).run(Number(this.state.lastScannedBlock));
  }

  /**
   * Get approximate token prices. Uses coin_swaps data if available,
   * otherwise falls back to hardcoded defaults.
   */
  private getPrices(): TokenPrices {
    const defaults = getDefaultPrices();

    // Try to get ETH price from recent USDC swaps
    try {
      const ethRow = this.db.prepare(`
        SELECT AVG(amount_usdc / NULLIF(coin_amount / 1e18, 0)) AS price
        FROM coin_swaps
        WHERE datetime(block_timestamp) >= datetime('now', '-1 hour')
          AND amount_usdc > 10 AND coin_amount > 0
        LIMIT 100
      `).get() as PriceRow | undefined;
      const ethUsd = Number(ethRow?.price ?? 0);
      if (Number.isFinite(ethUsd) && ethUsd > 100) {
        return { ...defaults, ethUsd };
      }
    } catch { /* use defaults */ }

    return defaults;
  }

  /**
   * Get the root actor label for a given bad actor address.
   * Walks up the cluster chain to find the original root.
   */
  private getRootActorLabel(address: string): string | null {
    const addr = address.toLowerCase();
    const row = this.db.prepare(
      `SELECT label, root_actor FROM bad_actors WHERE address = ?`
    ).get(addr) as { label: string | null; root_actor: string | null } | undefined;

    if (!row) return null;
    if (!row.root_actor) return row.label; // This IS the root
    // Return the root actor's label
    const rootRow = this.db.prepare(
      `SELECT label FROM bad_actors WHERE address = ?`
    ).get(row.root_actor.toLowerCase()) as { label: string | null } | undefined;
    return rootRow?.label ?? row.root_actor.slice(0, 10);
  }

  /**
   * Get the depth of a bad actor in the cluster chain.
   */
  private getActorDepth(address: string): number {
    const row = this.db.prepare(
      `SELECT depth FROM bad_actors WHERE address = ?`
    ).get(address.toLowerCase()) as { depth: number } | undefined;
    return row?.depth ?? 0;
  }

  /**
   * Get the root address for a bad actor (either themselves or their root_actor).
   */
  private getRootAddress(address: string): string {
    const row = this.db.prepare(
      `SELECT root_actor FROM bad_actors WHERE address = ?`
    ).get(address.toLowerCase()) as { root_actor: string | null } | undefined;
    return row?.root_actor ?? address.toLowerCase();
  }

  /**
   * Count cluster members for a root actor.
   */
  private getClusterSize(rootAddress: string): number {
    const row = this.db.prepare(
      `SELECT COUNT(*) AS cnt FROM bad_actors WHERE root_actor = ? OR address = ?`
    ).get(rootAddress.toLowerCase(), rootAddress.toLowerCase()) as { cnt: number };
    return row.cnt;
  }

  /**
   * Main tick — scan recent blocks for transfers from bad actors.
   * Returns list of detected transfers and any auto-added addresses.
   */
  async tick(): Promise<{
    scannedBlocks: number;
    transfersDetected: number;
    autoAdded: number;
    detections: TransferDetection[];
  }> {
    const actors = listBadActors(this.db);
    if (!actors.length) return { scannedBlocks: 0, transfersDetected: 0, autoAdded: 0, detections: [] };

    const currentBlock = await this.client.getBlockNumber();

    // Determine scan range
    let fromBlock: bigint;
    if (this.state.lastScannedBlock > 0n) {
      fromBlock = this.state.lastScannedBlock + 1n;
    } else {
      // First run — start from recent blocks only
      fromBlock = currentBlock - this.lookbackBlocks;
    }

    // Cap lookback
    if (currentBlock - fromBlock > MAX_LOOKBACK_BLOCKS) {
      fromBlock = currentBlock - MAX_LOOKBACK_BLOCKS;
    }

    if (fromBlock >= currentBlock) {
      return { scannedBlocks: 0, transfersDetected: 0, autoAdded: 0, detections: [] };
    }

    const actorAddresses = actors.map(a => a.address.toLowerCase() as Address);
    const actorSet = new Set(actorAddresses.map(a => a.toLowerCase()));
    const prices = this.getPrices();

    const detections: TransferDetection[] = [];

    // Scan ERC-20 Transfer events for each tracked token
    for (const { token, symbol, decimals, priceUsd } of [
      { token: WETH, symbol: "WETH", decimals: 18, priceUsd: prices.ethUsd },
      { token: ZORA, symbol: "ZORA", decimals: 18, priceUsd: prices.zoraUsd },
      { token: USDC, symbol: "USDC", decimals: 6, priceUsd: prices.usdcUsd },
    ]) {
      try {
        const logs = await this.client.getLogs({
          address: token,
          event: TRANSFER_EVENT,
          args: { from: actorAddresses },
          fromBlock,
          toBlock: currentBlock,
        });

        for (const log of logs) {
          const from = log.args?.from?.toLowerCase();
          const to = log.args?.to?.toLowerCase();
          const value = log.args?.value;

          if (!from || !to || value === undefined) continue;
          if (!actorSet.has(from)) continue;
          if (to === "0x0000000000000000000000000000000000000000") continue; // burn

          const formatted = decimals === 18 ? formatEther(value) : formatUnits(value, decimals);
          const usdValue = Number(formatted) * priceUsd;

          if (usdValue < this.minTransferUsd) continue;

          const rootLabel = this.getRootActorLabel(from) ?? from.slice(0, 10);

          detections.push({
            fromAddress: from,
            toAddress: to,
            tokenSymbol: symbol,
            amountRaw: value,
            amountFormatted: formatted,
            estimatedUsd: usdValue,
            txHash: log.transactionHash ?? "",
            blockNumber: log.blockNumber ?? 0n,
            rootActor: rootLabel,
          });
        }
      } catch (error) {
        console.warn(`[bad-actor-tracker] getLogs failed for ${symbol}:`, messageFromError(error));
      }
    }

    // Process detections — auto-add new addresses
    let autoAdded = 0;
    const insertTransfer = this.db.prepare(`
      INSERT OR IGNORE INTO bad_actor_transfers 
      (from_address, to_address, token_symbol, amount_formatted, estimated_usd, tx_hash, block_number, root_actor, auto_added, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    for (const d of detections) {
      const isAlreadyKnown = actorSet.has(d.toAddress);
      const senderDepth = this.getActorDepth(d.fromAddress);
      const rootAddr = this.getRootAddress(d.fromAddress);
      const clusterSize = this.getClusterSize(rootAddr);

      // Log the transfer
      insertTransfer.run(
        d.fromAddress, d.toAddress, d.tokenSymbol, d.amountFormatted,
        d.estimatedUsd, d.txHash, Number(d.blockNumber),
        d.rootActor, isAlreadyKnown ? 0 : 1, new Date().toISOString(),
      );

      // Auto-add if not already known and within depth limit
      if (!isAlreadyKnown && senderDepth < this.maxDepth) {
        const clusterLabel = `${d.rootActor}-cluster-${clusterSize + 1}`;
        addBadActor(
          this.db,
          d.toAddress,
          clusterLabel,
          `Auto-detected: received $${d.estimatedUsd.toFixed(0)} ${d.tokenSymbol} from ${d.rootActor} (${d.fromAddress.slice(0, 10)}...)`,
          "warning",
        );
        // Set cluster metadata
        this.db.prepare(
          `UPDATE bad_actors SET root_actor = ?, cluster_id = ?, depth = ? WHERE address = ?`
        ).run(rootAddr, rootAddr, senderDepth + 1, d.toAddress);

        actorSet.add(d.toAddress); // prevent duplicate adds in same tick
        autoAdded++;
        writeInfoLine(`[bad-actor-tracker] Auto-added ${d.toAddress} as ${clusterLabel} (received $${d.estimatedUsd.toFixed(0)} ${d.tokenSymbol} from ${d.fromAddress.slice(0, 10)})`);
      }
    }

    // Update state
    this.state.lastScannedBlock = currentBlock;
    this.saveState();

    const blockCount = Number(currentBlock - fromBlock);
    if (detections.length > 0 || autoAdded > 0) {
      writeInfoLine(`[bad-actor-tracker] scanned ${blockCount} blocks: ${detections.length} transfers, ${autoAdded} auto-added`);
    }

    return {
      scannedBlocks: blockCount,
      transfersDetected: detections.length,
      autoAdded,
      detections,
    };
  }

  /**
   * Get recent transfer detections from the audit log.
   */
  getRecentTransfers(limit = 20): Array<{
    fromAddress: string;
    toAddress: string;
    tokenSymbol: string;
    amountFormatted: string;
    estimatedUsd: number;
    txHash: string;
    rootActor: string | null;
    autoAdded: boolean;
    createdAt: string;
  }> {
    return this.db.prepare(`
      SELECT from_address AS fromAddress, to_address AS toAddress, token_symbol AS tokenSymbol,
             amount_formatted AS amountFormatted, estimated_usd AS estimatedUsd, tx_hash AS txHash,
             root_actor AS rootActor, auto_added AS autoAdded, created_at AS createdAt
      FROM bad_actor_transfers ORDER BY id DESC LIMIT ?
    `).all(limit).map((row) => ({
      ...(row as RecentTransferRow),
      autoAdded: Boolean((row as RecentTransferRow).autoAdded),
    }));
  }

  /**
   * Get cluster summary for a root actor.
   */
  getClusterSummary(rootAddress: string): Array<{
    address: string;
    label: string | null;
    depth: number;
    reason: string | null;
  }> {
    const addr = rootAddress.toLowerCase();
    return this.db.prepare(`
      SELECT address, label, depth, reason
      FROM bad_actors
      WHERE root_actor = ? OR address = ?
      ORDER BY depth ASC, added_at ASC
    `).all(addr, addr) as ClusterSummaryRow[];
  }
}
