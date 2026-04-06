/**
 * Trend Coin Indexer
 *
 * Indexes Zora TrendCoins via:
 * 1. On-chain TrendCoinCreated events from the ZoraFactory
 * 2. Zora SDK API for metadata enrichment
 * 3. Periodic snapshots for momentum tracking
 *
 * Stores everything in the intelligence DB and generates alerts.
 */

import { createPublicClient, http, parseAbiItem, type Address, formatEther } from "viem";
import { base } from "viem/chains";
import Database from "better-sqlite3";
import * as zoraSdk from "@zoralabs/coins-sdk";

// SDK function references
const getCoinsLastTraded = (zoraSdk as any).getCoinsLastTraded as (args: any) => Promise<any>;
const getCoinsLastTradedUnique = (zoraSdk as any).getCoinsLastTradedUnique as (args: any) => Promise<any>;
const getCoin = (zoraSdk as any).getCoin as (args: any) => Promise<any>;
const setApiKey = (zoraSdk as any).setApiKey as ((apiKey: string) => void) | undefined;

// ZoraFactory on Base mainnet
const ZORA_FACTORY = "0x777777751622c0d3258f214F9DF38E35BF45baF3" as Address;

// TrendCoinCreated event — not in the deployed protocol-deployments package yet
// event TrendCoinCreated(address indexed caller, string symbol, address coin, PoolKey poolKey, bytes32 poolKeyHash, bytes poolConfig, string version)
const TREND_COIN_CREATED_EVENT = parseAbiItem(
  "event TrendCoinCreated(address indexed caller, string symbol, address coin, (address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks) poolKey, bytes32 poolKeyHash, bytes poolConfig, string version)"
);

// Minimum block to start scanning (approximate deployment block — adjust if needed)
// TrendCoin feature deployed ~March 12 2026
const DEFAULT_START_BLOCK = 30_000_000n; // conservative — will narrow after first successful scan

export interface TrendCoinRecord {
  address: string;
  symbol: string;
  deployer: string;
  block_number: number;
  tx_hash: string;
  created_at: string;
  market_cap: number;
  volume_24h: number;
  unique_holders: number;
  pool_currency: string;
  last_snapshot_at: string | null;
}

export interface TrendCoinSnapshot {
  coin_address: string;
  market_cap: number;
  volume_24h: number;
  unique_holders: number;
  price_usdc: number;
  timestamp: string;
}

/**
 * Apply trend coin schema migrations
 */
export function applyTrendSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS trend_coins (
      address TEXT PRIMARY KEY,
      symbol TEXT NOT NULL,
      deployer TEXT NOT NULL,
      block_number INTEGER,
      tx_hash TEXT,
      created_at TEXT NOT NULL,
      market_cap REAL NOT NULL DEFAULT 0,
      volume_24h REAL NOT NULL DEFAULT 0,
      unique_holders INTEGER NOT NULL DEFAULT 0,
      pool_currency TEXT,
      last_snapshot_at TEXT,
      indexed_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_trend_coins_symbol ON trend_coins(symbol);
    CREATE INDEX IF NOT EXISTS idx_trend_coins_created ON trend_coins(created_at);

    CREATE TABLE IF NOT EXISTS trend_coin_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      coin_address TEXT NOT NULL,
      market_cap REAL NOT NULL DEFAULT 0,
      volume_24h REAL NOT NULL DEFAULT 0,
      unique_holders INTEGER NOT NULL DEFAULT 0,
      price_usdc REAL NOT NULL DEFAULT 0,
      timestamp TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_trend_snapshots_coin ON trend_coin_snapshots(coin_address, timestamp);

    CREATE TABLE IF NOT EXISTS trend_sync_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
}

/**
 * TrendCoinIndexer — discovers and tracks Zora TrendCoins
 */
export class TrendCoinIndexer {
  private db: Database.Database;
  private rpcUrl: string;
  private client;

  constructor(db: Database.Database, opts?: { rpcUrl?: string; zoraApiKey?: string }) {
    this.db = db;
    this.rpcUrl = opts?.rpcUrl || process.env.BASE_RPC_URL || "https://mainnet.base.org";

    if (opts?.zoraApiKey && setApiKey) {
      setApiKey(opts.zoraApiKey);
    }

    this.client = createPublicClient({
      chain: base,
      transport: http(this.rpcUrl),
    });

    applyTrendSchema(db);
  }

  // ============================================================
  // On-chain event indexing
  // ============================================================

  /**
   * Scan for TrendCoinCreated events from the ZoraFactory.
   * Picks up from last scanned block (stored in trend_sync_state).
   */
  async syncFromChain(): Promise<number> {
    const lastBlock = this.getLastScannedBlock();
    const currentBlock = await this.client.getBlockNumber();

    // Cap at 10k blocks per scan to stay within RPC limits
    const maxBlockRange = 10_000n;
    const fromBlock = lastBlock + 1n;
    const toBlock = currentBlock - fromBlock > maxBlockRange
      ? fromBlock + maxBlockRange
      : currentBlock;

    if (fromBlock > toBlock) return 0;

    let logs;
    try {
      logs = await this.client.getLogs({
        address: ZORA_FACTORY,
        event: TREND_COIN_CREATED_EVENT,
        fromBlock,
        toBlock,
      });
    } catch (err: any) {
      // If the event doesn't exist on this factory version, skip gracefully
      if (err?.message?.includes("invalid") || err?.message?.includes("unknown")) {
        console.warn("[trend-indexer] TrendCoinCreated event not found on factory, likely older version");
        this.setLastScannedBlock(toBlock);
        return 0;
      }
      throw err;
    }

    const now = new Date().toISOString();
    const upsert = this.db.prepare(`
      INSERT INTO trend_coins (address, symbol, deployer, block_number, tx_hash, created_at, indexed_at)
      VALUES (@address, @symbol, @deployer, @block_number, @tx_hash, @created_at, @indexed_at)
      ON CONFLICT(address) DO UPDATE SET
        symbol = excluded.symbol,
        deployer = excluded.deployer,
        block_number = COALESCE(excluded.block_number, trend_coins.block_number),
        tx_hash = COALESCE(excluded.tx_hash, trend_coins.tx_hash)
    `);

    let count = 0;
    for (const log of logs) {
      const args = log.args as any;
      if (!args?.coin) continue;

      upsert.run({
        address: String(args.coin).toLowerCase(),
        symbol: args.symbol || "unknown",
        deployer: String(args.caller).toLowerCase(),
        block_number: Number(log.blockNumber),
        tx_hash: log.transactionHash,
        created_at: now, // Will be refined by API enrichment
        indexed_at: now,
      });
      count++;
    }

    this.setLastScannedBlock(toBlock);
    console.log(`[trend-indexer] Scanned blocks ${fromBlock}-${toBlock}, found ${count} new trend coins`);
    return count;
  }

  /**
   * Discover trend coins from the Zora API (LAST_TRADED + LAST_TRADED_UNIQUE).
   * Catches coins that might have been missed during block scanning gaps.
   */
  async syncFromApi(): Promise<number> {
    const seenAddresses = new Set<string>();
    let newCount = 0;

    for (const fetcher of [getCoinsLastTraded, getCoinsLastTradedUnique]) {
      try {
        const response = await fetcher({ count: 100 });
        const edges = response?.data?.exploreList?.edges ?? [];

        for (const edge of edges) {
          const node = edge.node;
          if (node.coinType !== "TREND") continue;

          const addr = String(node.address).toLowerCase();
          if (seenAddresses.has(addr)) continue;
          seenAddresses.add(addr);

          const existing = this.db.prepare("SELECT address FROM trend_coins WHERE address = ?").get(addr);
          if (!existing) newCount++;

          this.upsertFromApi(node);
        }
      } catch (err: any) {
        console.warn(`[trend-indexer] API fetch error:`, err?.message);
      }
    }

    return newCount;
  }

  /**
   * Enrich all trend coins with fresh API data (market cap, volume, holders).
   * This is the detailed per-coin fetch.
   */
  async enrichAll(): Promise<number> {
    // Only enrich coins not snapshotted in the last 10 minutes, capped at 20 per tick
    // This prevents hammering the API with 100+ calls and causing rate-limit bleed
    const staleThreshold = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    const coins = this.db.prepare(
      `SELECT address FROM trend_coins
       WHERE last_snapshot_at IS NULL OR last_snapshot_at < ?
       ORDER BY created_at DESC LIMIT 20`
    ).all(staleThreshold) as Array<{ address: string }>;
    let enriched = 0;

    for (const { address } of coins) {
      // Small delay between calls to avoid API rate limiting
      if (enriched > 0) await new Promise(r => setTimeout(r, 150));
      try {
        const response = await getCoin({ address, chain: 8453 });
        const token = response?.data?.zora20Token;
        if (!token) continue;

        this.db.prepare(`
          UPDATE trend_coins SET
            market_cap = @market_cap,
            volume_24h = @volume_24h,
            unique_holders = @unique_holders,
            pool_currency = @pool_currency,
            created_at = COALESCE(@created_at, trend_coins.created_at),
            last_snapshot_at = @snapshot_at
          WHERE address = @address
        `).run({
          address,
          market_cap: Number(token.marketCap ?? 0),
          volume_24h: Number(token.volume24h ?? 0),
          unique_holders: Number(token.uniqueHolders ?? 0),
          pool_currency: token.poolCurrencyToken?.address?.toLowerCase() ?? null,
          created_at: token.createdAt ?? null,
          snapshot_at: new Date().toISOString(),
        });

        // Record snapshot
        this.db.prepare(`
          INSERT INTO trend_coin_snapshots (coin_address, market_cap, volume_24h, unique_holders, price_usdc, timestamp)
          VALUES (@coin_address, @market_cap, @volume_24h, @unique_holders, @price_usdc, @timestamp)
        `).run({
          coin_address: address,
          market_cap: Number(token.marketCap ?? 0),
          volume_24h: Number(token.volume24h ?? 0),
          unique_holders: Number(token.uniqueHolders ?? 0),
          price_usdc: Number(token.tokenPrice?.priceInUsdc ?? 0),
          timestamp: new Date().toISOString(),
        });

        // Also upsert into the main coins table for cross-referencing
        this.upsertMainCoinsTable(token);

        enriched++;
      } catch (err: any) {
        console.warn(`[trend-indexer] Enrich error for ${address}:`, err?.message);
      }
    }

    return enriched;
  }

  // ============================================================
  // Alert generation
  // ============================================================

  /**
   * Generate alerts for new trend coins and momentum shifts.
   * Returns the number of alerts generated.
   */
  generateAlerts(): number {
    const now = new Date().toISOString();
    let count = 0;

    // 1. Alert on newly discovered trend coins (no alert sent yet)
    const newCoins = this.db.prepare(`
      SELECT tc.* FROM trend_coins tc
      WHERE NOT EXISTS (
        SELECT 1 FROM alerts a
        WHERE a.entity_id = tc.address
        AND a.type = 'TREND_COIN_NEW'
      )
    `).all() as TrendCoinRecord[];

    for (const coin of newCoins) {
      const link = `https://zora.co/coin/base:${coin.address}`;
      const mcapStr = coin.market_cap > 0 ? ` • $${formatNum(coin.market_cap)} mcap` : "";
      const holdersStr = coin.unique_holders > 0 ? ` • ${coin.unique_holders} holders` : "";
      const message = `🔥 New Trend Coin: $${coin.symbol}${mcapStr}${holdersStr} — deployed by ${truncAddr(coin.deployer)}`;

      this.insertAlert({
        type: "TREND_COIN_NEW",
        kind: "TREND",
        entity_id: coin.address,
        severity: "info",
        message: addLink(message, link),
        fingerprint: `trend-new-${coin.address}`,
      });
      count++;
    }

    // 2. Alert on trend coins gaining momentum (mcap jump, holder spike)
    const hotCoins = this.db.prepare(`
      SELECT tc.*,
        (SELECT s.market_cap FROM trend_coin_snapshots s 
         WHERE s.coin_address = tc.address 
         ORDER BY s.timestamp DESC LIMIT 1 OFFSET 1) AS prev_mcap,
        (SELECT s.unique_holders FROM trend_coin_snapshots s 
         WHERE s.coin_address = tc.address 
         ORDER BY s.timestamp DESC LIMIT 1 OFFSET 1) AS prev_holders
      FROM trend_coins tc
      WHERE tc.market_cap > 5000
      AND tc.unique_holders >= 5
    `).all() as Array<TrendCoinRecord & { prev_mcap: number | null; prev_holders: number | null }>;

    for (const coin of hotCoins) {
      if (coin.prev_mcap && coin.prev_mcap > 0) {
        const mcapGrowth = coin.market_cap / coin.prev_mcap;
        if (mcapGrowth >= 1.5) {
          const link = `https://zora.co/coin/base:${coin.address}`;
          const pctStr = `${((mcapGrowth - 1) * 100).toFixed(0)}%`;
          const fp = `trend-pump-${coin.address}-${Math.floor(Date.now() / 3600000)}`;

          // Check cooldown
          const existing = this.db.prepare(
            "SELECT 1 FROM alerts WHERE fingerprint = ?"
          ).get(fp);
          if (!existing) {
            this.insertAlert({
              type: "TREND_COIN_PUMP",
              kind: "TREND",
              entity_id: coin.address,
              severity: "warning",
              message: addLink(
                `📈 Trend Coin Pumping: $${coin.symbol} up ${pctStr} — $${formatNum(coin.market_cap)} mcap, ${coin.unique_holders} holders, $${formatNum(coin.volume_24h)} vol`,
                link
              ),
              fingerprint: fp,
            });
            count++;
          }
        }
      }

      // Holder surge alert
      if (coin.prev_holders && coin.prev_holders > 0 && coin.unique_holders >= 10) {
        const holderGrowth = coin.unique_holders / coin.prev_holders;
        if (holderGrowth >= 2.0) {
          const link = `https://zora.co/coin/base:${coin.address}`;
          const fp = `trend-holders-${coin.address}-${Math.floor(Date.now() / 3600000)}`;
          const existing = this.db.prepare("SELECT 1 FROM alerts WHERE fingerprint = ?").get(fp);
          if (!existing) {
            this.insertAlert({
              type: "TREND_COIN_HOLDER_SURGE",
              kind: "TREND",
              entity_id: coin.address,
              severity: "info",
              message: addLink(
                `👥 Trend Coin Holder Surge: $${coin.symbol} — ${coin.prev_holders} → ${coin.unique_holders} holders, $${formatNum(coin.market_cap)} mcap`,
                link
              ),
              fingerprint: fp,
            });
            count++;
          }
        }
      }
    }

    return count;
  }

  // ============================================================
  // Full sync cycle (call from intelligence loop)
  // ============================================================

  async tick(): Promise<{ chainEvents: number; apiDiscovered: number; enriched: number; alerts: number }> {
    const chainEvents = await this.syncFromChain();
    const apiDiscovered = await this.syncFromApi();
    const enriched = await this.enrichAll();
    const alerts = this.generateAlerts();

    console.log(`[trend-indexer] tick: chain=${chainEvents} api=${apiDiscovered} enriched=${enriched} alerts=${alerts}`);
    return { chainEvents, apiDiscovered, enriched, alerts };
  }

  // ============================================================
  // Query helpers
  // ============================================================

  getAllTrendCoins(): TrendCoinRecord[] {
    return this.db.prepare(`
      SELECT * FROM trend_coins ORDER BY market_cap DESC
    `).all() as TrendCoinRecord[];
  }

  getHotTrendCoins(minMcap = 5000, minHolders = 5): TrendCoinRecord[] {
    return this.db.prepare(`
      SELECT * FROM trend_coins 
      WHERE market_cap >= ? AND unique_holders >= ?
      ORDER BY volume_24h DESC
    `).all(minMcap, minHolders) as TrendCoinRecord[];
  }

  getTrendCoinBySymbol(symbol: string): TrendCoinRecord | null {
    return (this.db.prepare(`
      SELECT * FROM trend_coins WHERE LOWER(symbol) = LOWER(?)
    `).get(symbol) as TrendCoinRecord) ?? null;
  }

  getSnapshots(coinAddress: string, limit = 50): TrendCoinSnapshot[] {
    return this.db.prepare(`
      SELECT * FROM trend_coin_snapshots 
      WHERE coin_address = ? 
      ORDER BY timestamp DESC LIMIT ?
    `).all(coinAddress.toLowerCase(), limit) as TrendCoinSnapshot[];
  }

  getStats(): { total: number; hot: number; totalVolume24h: number; totalMcap: number } {
    const row = this.db.prepare(`
      SELECT 
        COUNT(*) as total,
        SUM(CASE WHEN market_cap >= 5000 AND unique_holders >= 5 THEN 1 ELSE 0 END) as hot,
        SUM(volume_24h) as totalVolume24h,
        SUM(market_cap) as totalMcap
      FROM trend_coins
    `).get() as any;
    return {
      total: row?.total ?? 0,
      hot: row?.hot ?? 0,
      totalVolume24h: row?.totalVolume24h ?? 0,
      totalMcap: row?.totalMcap ?? 0,
    };
  }

  // ============================================================
  // Internal helpers
  // ============================================================

  private getLastScannedBlock(): bigint {
    const row = this.db.prepare("SELECT value FROM trend_sync_state WHERE key = 'last_scanned_block'").get() as { value: string } | undefined;
    return row ? BigInt(row.value) : DEFAULT_START_BLOCK;
  }

  private setLastScannedBlock(block: bigint): void {
    this.db.prepare(`
      INSERT INTO trend_sync_state (key, value) VALUES ('last_scanned_block', @value)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run({ value: block.toString() });
  }

  private upsertFromApi(node: any): void {
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO trend_coins (address, symbol, deployer, created_at, market_cap, volume_24h, unique_holders, pool_currency, indexed_at)
      VALUES (@address, @symbol, @deployer, @created_at, @market_cap, @volume_24h, @unique_holders, @pool_currency, @indexed_at)
      ON CONFLICT(address) DO UPDATE SET
        market_cap = excluded.market_cap,
        volume_24h = excluded.volume_24h,
        unique_holders = excluded.unique_holders,
        pool_currency = excluded.pool_currency,
        last_snapshot_at = excluded.indexed_at
    `).run({
      address: String(node.address).toLowerCase(),
      symbol: node.symbol ?? node.name ?? "unknown",
      deployer: String(node.creatorAddress ?? "0x0").toLowerCase(),
      created_at: node.createdAt ?? now,
      market_cap: Number(node.marketCap ?? 0),
      volume_24h: Number(node.volume24h ?? 0),
      unique_holders: Number(node.uniqueHolders ?? 0),
      pool_currency: node.poolCurrencyToken?.address?.toLowerCase() ?? null,
      indexed_at: now,
    });

    // Also record a snapshot
    this.db.prepare(`
      INSERT INTO trend_coin_snapshots (coin_address, market_cap, volume_24h, unique_holders, price_usdc, timestamp)
      VALUES (@coin_address, @market_cap, @volume_24h, @unique_holders, @price_usdc, @timestamp)
    `).run({
      coin_address: String(node.address).toLowerCase(),
      market_cap: Number(node.marketCap ?? 0),
      volume_24h: Number(node.volume24h ?? 0),
      unique_holders: Number(node.uniqueHolders ?? 0),
      price_usdc: Number(node.tokenPrice?.priceInUsdc ?? 0),
      timestamp: now,
    });
  }

  private upsertMainCoinsTable(token: any): void {
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO coins (address, name, symbol, coin_type, creator_address, created_at, market_cap, volume_24h, total_volume, chain_id, raw_json, indexed_at)
      VALUES (@address, @name, @symbol, @coin_type, @creator_address, @created_at, @market_cap, @volume_24h, @total_volume, @chain_id, @raw_json, @indexed_at)
      ON CONFLICT(address) DO UPDATE SET
        name=excluded.name, symbol=excluded.symbol, coin_type=excluded.coin_type,
        market_cap=excluded.market_cap, volume_24h=excluded.volume_24h,
        total_volume=excluded.total_volume, raw_json=excluded.raw_json, indexed_at=excluded.indexed_at
    `).run({
      address: String(token.address).toLowerCase(),
      name: token.name ?? null,
      symbol: token.symbol ?? null,
      coin_type: "TREND",
      creator_address: token.creatorAddress?.toLowerCase?.() ?? null,
      created_at: token.createdAt ?? null,
      market_cap: Number(token.marketCap ?? 0),
      volume_24h: Number(token.volume24h ?? 0),
      total_volume: Number(token.totalVolume ?? 0),
      chain_id: 8453,
      raw_json: JSON.stringify(token),
      indexed_at: now,
    });
  }

  private insertAlert(a: { type: string; kind: string; entity_id: string; severity: string; message: string; fingerprint: string }): void {
    try {
      this.db.prepare(`
        INSERT INTO alerts (type, kind, entity_id, severity, message, fingerprint, created_at)
        VALUES (@type, @kind, @entity_id, @severity, @message, @fingerprint, @created_at)
        ON CONFLICT(fingerprint) DO NOTHING
      `).run({ ...a, created_at: new Date().toISOString() });
    } catch {
      // fingerprint collision — alert already exists
    }
  }
}

// ============================================================
// Formatting utilities
// ============================================================

function formatNum(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return n.toFixed(2);
}

function truncAddr(addr: string): string {
  if (!addr || addr.length < 10) return addr ?? "unknown";
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

function addLink(message: string, link: string): string {
  return `${message} <${link}>`;
}
