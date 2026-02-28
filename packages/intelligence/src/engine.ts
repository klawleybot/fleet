import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import * as zoraSdk from "@zoralabs/coins-sdk";
import { isAddress } from "viem";
import { applySchema } from "./schema.js";
import { dedupeAlertRows, type AlertRow } from "./alerts-dedupe.js";
import { selectDiverseAlerts, type DiversityOptions } from "./alerts-diversity.js";
import { generateBatchCommentary } from "./commentary.js";

// SDK function references (loosely-typed to handle SDK export quirks)
const getCoinSwaps = (zoraSdk as any).getCoinSwaps as (args: any) => Promise<any>;
const getCoinsNew = (zoraSdk as any).getCoinsNew as (args: any) => Promise<any>;
const getCoinsTopVolume24h = (zoraSdk as any).getCoinsTopVolume24h as (args: any) => Promise<any>;
const getCoin = (zoraSdk as any).getCoin as (args: any) => Promise<any>;
const setApiKey = (zoraSdk as any).setApiKey as ((apiKey: string) => void) | undefined;

// ============================================================
// Types
// ============================================================

export interface IntelligenceConfig {
  dbPath?: string;
  zoraApiKey?: string;
  zoraChainId?: number;
  pollIntervalSec?: number;
  swapsPerCoin?: number;
  trackedCoinCount?: number;
  clusterMinInteractions?: number;
  alertWhaleSwapUsd?: number;
  alertCoinSwaps24h?: number;
  alertCoinSwaps1h?: number;
  alertMinMomentum1h?: number;
  alertMinAcceleration1h?: number;
  alertMaxCoinAlertsPerRun?: number;
  alertDiversityMode?: string;
  alertPerCoinCooldownMin?: number;
  alertMaxPerCoinPerDispatch?: number;
  alertNoveltyWindowHours?: number;
  alertLargeCapPenaltyAboveUsd?: number;
  watchlistMinSwapUsd?: number;
  watchlistMinSwaps1h?: number;
  watchlistMinNetFlowUsd1h?: number;
  watchlistMinSwaps24h?: number;
  watchlistMinNetFlowUsd24h?: number;
}

export interface PollResult {
  syncedRecent: number;
  syncedTop: number;
  swaps: number;
  clusters: number;
  analytics: number;
  alerts: number;
}

export interface ZoraSignalCoin {
  coinAddress: `0x${string}`;
  symbol: string | null;
  name: string | null;
  momentumScore: number;
  swaps24h: number;
  netFlowUsd24h: number;
  volume24h: number;
  coinUrl: string;
}

export interface PumpSignal {
  coinAddress: `0x${string}`;
  symbol: string | null;
  name: string | null;
  momentumAcceleration1h: number;
  netFlowUsdc1h: number;
  momentumScore: number;
  coinUrl: string;
}

export interface DipSignal {
  coinAddress: `0x${string}`;
  symbol: string | null;
  name: string | null;
  momentumAcceleration1h: number;
  netFlowUsdc1h: number;
  swapCount24h: number;
  momentumScore: number;
  coinUrl: string;
}

export type ZoraSignalMode = "top_momentum" | "watchlist_top";

export type DispatchAlertsRich = {
  message: string;
  media: Array<{ coinAddress: string; symbol: string | null; name: string | null; filePath: string }>;
};

// ============================================================
// Resolved config with defaults
// ============================================================

interface ResolvedConfig {
  dbPath: string;
  zoraChainId: number;
  pollIntervalSec: number;
  swapsPerCoin: number;
  trackedCoinCount: number;
  clusterMinInteractions: number;
  alertWhaleSwapUsd: number;
  alertCoinSwaps24h: number;
  alertCoinSwaps1h: number;
  alertMinMomentum1h: number;
  alertMinAcceleration1h: number;
  alertMaxCoinAlertsPerRun: number;
  alertDiversityMode: string;
  alertPerCoinCooldownMin: number;
  alertMaxPerCoinPerDispatch: number;
  alertNoveltyWindowHours: number;
  alertLargeCapPenaltyAboveUsd: number;
  watchlistMinSwapUsd: number;
  watchlistMinSwaps1h: number;
  watchlistMinNetFlowUsd1h: number;
  watchlistMinSwaps24h: number;
  watchlistMinNetFlowUsd24h: number;
}

function defaultDbPath(): string {
  // Resolve relative to this file's package — packages/intelligence/.data/
  return new URL("../.data/zora-intelligence.db", import.meta.url).pathname;
}

function resolveConfig(input: IntelligenceConfig): ResolvedConfig {
  return {
    dbPath: input.dbPath ?? defaultDbPath(),
    zoraChainId: input.zoraChainId ?? 8453,
    pollIntervalSec: input.pollIntervalSec ?? 60,
    swapsPerCoin: input.swapsPerCoin ?? 30,
    trackedCoinCount: input.trackedCoinCount ?? 75,
    clusterMinInteractions: input.clusterMinInteractions ?? 2,
    alertWhaleSwapUsd: input.alertWhaleSwapUsd ?? 5000,
    alertCoinSwaps24h: input.alertCoinSwaps24h ?? 50,
    alertCoinSwaps1h: input.alertCoinSwaps1h ?? 60,
    alertMinMomentum1h: input.alertMinMomentum1h ?? 250,
    alertMinAcceleration1h: input.alertMinAcceleration1h ?? 1.4,
    alertMaxCoinAlertsPerRun: input.alertMaxCoinAlertsPerRun ?? 5,
    alertDiversityMode: input.alertDiversityMode ?? "on",
    alertPerCoinCooldownMin: input.alertPerCoinCooldownMin ?? 30,
    alertMaxPerCoinPerDispatch: input.alertMaxPerCoinPerDispatch ?? 1,
    alertNoveltyWindowHours: input.alertNoveltyWindowHours ?? 12,
    alertLargeCapPenaltyAboveUsd: input.alertLargeCapPenaltyAboveUsd ?? 1_000_000,
    watchlistMinSwapUsd: input.watchlistMinSwapUsd ?? 250,
    watchlistMinSwaps1h: input.watchlistMinSwaps1h ?? 18,
    watchlistMinNetFlowUsd1h: input.watchlistMinNetFlowUsd1h ?? 900,
    watchlistMinSwaps24h: input.watchlistMinSwaps24h ?? 20,
    watchlistMinNetFlowUsd24h: input.watchlistMinNetFlowUsd24h ?? 1500,
  };
}

// ============================================================
// Helpers
// ============================================================

type Edge = { node: any; cursor?: string };

function edgesFromResponse(r: any): Edge[] {
  return r?.data?.exploreList?.edges ?? [];
}

function normAddress(v: string) {
  return String(v ?? "").trim().toLowerCase();
}

function chainSlug(chainId?: number | null) {
  return Number(chainId) === 84532 ? "base-sepolia" : "base";
}

function coinLink(address?: string | null, chainId?: number | null) {
  const addr = normAddress(address ?? "");
  if (!addr.startsWith("0x")) return null;
  return `https://zora.co/coin/${chainSlug(chainId)}:${addr}`;
}

function coinUrl(chainId: number | null | undefined, coinAddress: string) {
  const cs = Number(chainId) === 84532 ? "base-sepolia" : "base";
  return `https://zora.co/coin/${cs}:${coinAddress.toLowerCase()}`;
}

function addCoinLinkToMessage(message: string, address?: string | null, chainId?: number | null) {
  const link = coinLink(address, chainId);
  if (!link) return message;
  if (message.includes(link)) return message;
  return `${message} <${link}>`;
}

function escapeRegex(v: string) {
  return v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function cleanAlertMessage(message: string, entityId?: string | null, link?: string | null) {
  let out = String(message ?? "");
  if (link) {
    const reAngle = new RegExp(`<${escapeRegex(link)}>`, "ig");
    const rePlain = new RegExp(escapeRegex(link), "ig");
    out = out.replace(reAngle, "").replace(rePlain, "");
  }
  if (entityId) {
    const reAddr = new RegExp(escapeRegex(entityId), "ig");
    out = out.replace(reAddr, "");
  }
  out = out.replace(/<https?:\/\/zora\.co\/coin\/[a-z-]+:>/ig, "");
  out = out.replace(/\s{2,}/g, " ").replace(/\s+\)/g, ")").trim();
  out = out.replace(/^[-:;,\s]+/, "").trim();
  return out;
}

function formatUsd(v: number) {
  if (!Number.isFinite(v) || v <= 0) return "n/a";
  return Number(v).toLocaleString(undefined, { maximumFractionDigits: 0 });
}

const ALERTS_LOG_PATH = "./logs/alerts.log";

function appendAlertLog(line: string) {
  try {
    fs.mkdirSync(path.dirname(ALERTS_LOG_PATH), { recursive: true });
    fs.appendFileSync(ALERTS_LOG_PATH, `${line}\n`, "utf8");
  } catch { /* non-critical */ }
}

// ============================================================
// IntelligenceEngine
// ============================================================

export class IntelligenceEngine {
  readonly db: Database.Database;
  private readonly cfg: ResolvedConfig;
  private apiKeySet = false;

  constructor(config: IntelligenceConfig = {}) {
    this.cfg = resolveConfig(config);

    // Ensure .data directory exists
    fs.mkdirSync(path.dirname(this.cfg.dbPath), { recursive: true });

    this.db = new Database(this.cfg.dbPath);
    applySchema(this.db);

    if (config.zoraApiKey && setApiKey && !this.apiKeySet) {
      setApiKey(config.zoraApiKey);
      this.apiKeySet = true;
    }
  }

  get config(): Readonly<ResolvedConfig> {
    return this.cfg;
  }

  close(): void {
    this.db.close();
  }

  // ============================================================
  // Coin upsert
  // ============================================================

  private upsertCoin(node: any): void {
    this.db.prepare(`
      INSERT INTO coins (
        address, name, symbol, coin_type, creator_address, created_at,
        market_cap, volume_24h, total_volume, chain_id, raw_json, indexed_at
      ) VALUES (
        @address, @name, @symbol, @coin_type, @creator_address, @created_at,
        @market_cap, @volume_24h, @total_volume, @chain_id, @raw_json, @indexed_at
      )
      ON CONFLICT(address) DO UPDATE SET
        name=excluded.name, symbol=excluded.symbol, coin_type=excluded.coin_type,
        creator_address=excluded.creator_address, created_at=excluded.created_at,
        market_cap=excluded.market_cap, volume_24h=excluded.volume_24h,
        total_volume=excluded.total_volume, chain_id=excluded.chain_id,
        raw_json=excluded.raw_json, indexed_at=excluded.indexed_at
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

  // ============================================================
  // Sync
  // ============================================================

  async syncRecentCoins(count?: number): Promise<number> {
    const c = count ?? this.cfg.trackedCoinCount;
    const r = await getCoinsNew({ count: c });
    const edges = edgesFromResponse(r);
    for (const edge of edges) this.upsertCoin(edge.node);
    this.db.prepare("INSERT INTO sync_runs(source, count, created_at) VALUES (?, ?, ?)")
      .run("getCoinsNew", edges.length, new Date().toISOString());
    return edges.length;
  }

  async syncTopVolumeCoins(count?: number): Promise<number> {
    const c = count ?? this.cfg.trackedCoinCount;
    const r = await getCoinsTopVolume24h({ count: c });
    const edges = edgesFromResponse(r);
    for (const edge of edges) this.upsertCoin(edge.node);
    this.db.prepare("INSERT INTO sync_runs(source, count, created_at) VALUES (?, ?, ?)")
      .run("getCoinsTopVolume24h", edges.length, new Date().toISOString());
    return edges.length;
  }

  // ============================================================
  // Swap ingestion
  // ============================================================

  async ingestSwaps(coinLimit?: number, swapsPerCoin?: number): Promise<number> {
    const limit = coinLimit ?? this.cfg.trackedCoinCount;
    const spc = swapsPerCoin ?? this.cfg.swapsPerCoin;

    const topCoins = this.db.prepare(`
      SELECT address, chain_id FROM coins
      ORDER BY volume_24h DESC, datetime(indexed_at) DESC LIMIT ?
    `).all(limit) as Array<{ address: string; chain_id: number }>;

    const watchlisted = this.db.prepare(`
      SELECT c.address, c.chain_id FROM coin_watchlist w
      JOIN coins c ON c.address = w.coin_address
      WHERE w.coin_address NOT IN (
        SELECT address FROM coins ORDER BY volume_24h DESC, datetime(indexed_at) DESC LIMIT ?
      )
    `).all(limit) as Array<{ address: string; chain_id: number }>;

    const coins = [...topCoins, ...watchlisted];
    let totalInserted = 0;

    for (const coin of coins) {
      try {
        const res = await getCoinSwaps({
          address: coin.address,
          chain: coin.chain_id || this.cfg.zoraChainId,
          first: spc,
        });
        const edges = res?.data?.zora20Token?.swapActivities?.edges ?? [];
        for (const edge of edges) totalInserted += this.upsertSwap(coin.address, coin.chain_id || this.cfg.zoraChainId, edge.node);
      } catch (err) {
        console.error(`swap ingestion failed for ${coin.address}:`, err);
      }
    }

    this.db.prepare("INSERT INTO sync_runs(source, count, created_at) VALUES (?, ?, ?)")
      .run("getCoinSwaps", totalInserted, new Date().toISOString());
    return totalInserted;
  }

  private upsertSwap(coinAddress: string, chainId: number, swap: any): number {
    const sender = String(swap.senderAddress ?? "").toLowerCase();
    const recipient = String(swap.recipientAddress ?? "").toLowerCase();
    const ts = swap.blockTimestamp ?? new Date().toISOString();
    const amountUsdc = Number(swap.currencyAmountWithPrice?.priceUsdc ?? 0);
    const amountDecimal = Number(swap.currencyAmountWithPrice?.currencyAmount?.amountDecimal ?? 0);
    const coinAmount = Number(swap.coinAmount ?? 0);
    const result = this.db.prepare(`
      INSERT OR IGNORE INTO coin_swaps (
        id, coin_address, chain_id, tx_hash, block_timestamp, activity_type,
        sender_address, recipient_address, amount_decimal, amount_usdc, coin_amount,
        raw_json, indexed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      String(swap.id), coinAddress, chainId,
      swap.transactionHash ?? null, ts, swap.activityType ?? null,
      sender || null, recipient || null, amountDecimal, amountUsdc, coinAmount,
      JSON.stringify(swap), new Date().toISOString(),
    );

    if (result.changes > 0) {
      if (sender) this.upsertAddressStats(sender, ts, swap.activityType, amountUsdc, swap.senderProfile?.handle);
      if (recipient) this.upsertAddressStats(recipient, ts, null, amountUsdc, undefined);
      if (sender && recipient && sender !== recipient) this.upsertInteraction(sender, recipient, ts);
    }

    return result.changes;
  }

  private upsertAddressStats(address: string, ts: string, side?: string | null, usd = 0, handle?: string): void {
    this.db.prepare(`
      INSERT INTO addresses (
        address, first_seen_at, last_seen_at, swap_count, buy_count, sell_count,
        volume_usdc, last_profile_handle, intelligence_score, updated_at
      ) VALUES (?, ?, ?, 1, ?, ?, ?, ?, 0, ?)
      ON CONFLICT(address) DO UPDATE SET
        last_seen_at=excluded.last_seen_at,
        swap_count=addresses.swap_count + 1,
        buy_count=addresses.buy_count + excluded.buy_count,
        sell_count=addresses.sell_count + excluded.sell_count,
        volume_usdc=addresses.volume_usdc + excluded.volume_usdc,
        last_profile_handle=COALESCE(excluded.last_profile_handle, addresses.last_profile_handle),
        intelligence_score=(addresses.swap_count + 1) * 0.5 + ((addresses.volume_usdc + excluded.volume_usdc) / 1000.0),
        updated_at=excluded.updated_at
    `).run(address, ts, ts, side === "BUY" ? 1 : 0, side === "SELL" ? 1 : 0, usd, handle ?? null, new Date().toISOString());
  }

  private upsertInteraction(a: string, b: string, ts: string): void {
    const [x, y] = [a, b].sort();
    this.db.prepare(`
      INSERT INTO address_interactions (a_address, b_address, interaction_count, last_seen_at)
      VALUES (?, ?, 1, ?)
      ON CONFLICT(a_address, b_address) DO UPDATE SET
        interaction_count=interaction_count + 1, last_seen_at=excluded.last_seen_at
    `).run(x, y, ts);
  }

  // ============================================================
  // Clusters
  // ============================================================

  rebuildClusters(): number {
    const rows = this.db.prepare(`
      SELECT a_address, b_address FROM address_interactions WHERE interaction_count >= ?
    `).all(this.cfg.clusterMinInteractions) as Array<{ a_address: string; b_address: string }>;

    const graph = new Map<string, Set<string>>();
    for (const row of rows) {
      if (!graph.has(row.a_address)) graph.set(row.a_address, new Set());
      if (!graph.has(row.b_address)) graph.set(row.b_address, new Set());
      graph.get(row.a_address)!.add(row.b_address);
      graph.get(row.b_address)!.add(row.a_address);
    }

    const visited = new Set<string>();
    const clusters: string[][] = [];
    for (const node of graph.keys()) {
      if (visited.has(node)) continue;
      const stack = [node];
      const component: string[] = [];
      visited.add(node);
      while (stack.length) {
        const n = stack.pop()!;
        component.push(n);
        for (const nei of graph.get(n) ?? []) {
          if (!visited.has(nei)) { visited.add(nei); stack.push(nei); }
        }
      }
      if (component.length >= 2) clusters.push(component);
    }

    this.db.prepare("DELETE FROM address_cluster_members").run();
    this.db.prepare("DELETE FROM address_clusters").run();

    const insertCluster = this.db.prepare(
      `INSERT INTO address_clusters (id, heuristic, label, member_count, score, updated_at) VALUES (?, ?, ?, ?, ?, ?)`
    );
    const insertMember = this.db.prepare(
      `INSERT INTO address_cluster_members (cluster_id, address, weight) VALUES (?, ?, ?)`
    );

    clusters.forEach((members, i) => {
      const id = `cluster-${i + 1}`;
      insertCluster.run(id, "shared-swap-counterparty", `interaction_component_${members.length}`, members.length, members.length, new Date().toISOString());
      for (const m of members) insertMember.run(id, m, 1);
    });

    return clusters.length;
  }

  // ============================================================
  // Analytics
  // ============================================================

  refreshAnalytics(): number {
    const rows = this.db.prepare(`
      SELECT
        coin_address,
        SUM(CASE WHEN datetime(block_timestamp) >= datetime('now', '-1 hour') THEN 1 ELSE 0 END) AS swap_count_1h,
        COUNT(DISTINCT CASE WHEN datetime(block_timestamp) >= datetime('now', '-1 hour') THEN sender_address END) AS unique_traders_1h,
        SUM(CASE WHEN datetime(block_timestamp) >= datetime('now', '-1 hour') AND activity_type = 'BUY' THEN 1 ELSE 0 END) AS buy_count_1h,
        SUM(CASE WHEN datetime(block_timestamp) >= datetime('now', '-1 hour') AND activity_type = 'SELL' THEN 1 ELSE 0 END) AS sell_count_1h,
        SUM(CASE WHEN datetime(block_timestamp) >= datetime('now', '-1 hour') AND activity_type = 'BUY' THEN amount_usdc ELSE 0 END) AS buy_volume_usdc_1h,
        SUM(CASE WHEN datetime(block_timestamp) >= datetime('now', '-1 hour') AND activity_type = 'SELL' THEN amount_usdc ELSE 0 END) AS sell_volume_usdc_1h,
        SUM(CASE WHEN datetime(block_timestamp) >= datetime('now', '-2 hours') AND datetime(block_timestamp) < datetime('now', '-1 hour') THEN 1 ELSE 0 END) AS swap_count_prev_1h,
        COUNT(*) AS swap_count_24h,
        COUNT(DISTINCT sender_address) AS unique_traders_24h,
        SUM(CASE WHEN activity_type = 'BUY' THEN 1 ELSE 0 END) AS buy_count_24h,
        SUM(CASE WHEN activity_type = 'SELL' THEN 1 ELSE 0 END) AS sell_count_24h,
        SUM(CASE WHEN activity_type = 'BUY' THEN amount_usdc ELSE 0 END) AS buy_volume_usdc_24h,
        SUM(CASE WHEN activity_type = 'SELL' THEN amount_usdc ELSE 0 END) AS sell_volume_usdc_24h
      FROM coin_swaps
      WHERE datetime(block_timestamp) >= datetime('now', '-1 day')
      GROUP BY coin_address
    `).all() as Array<any>;

    const upsert = this.db.prepare(`
      INSERT INTO coin_analytics (
        coin_address,
        swap_count_1h, unique_traders_1h, buy_count_1h, sell_count_1h,
        buy_volume_usdc_1h, sell_volume_usdc_1h, net_flow_usdc_1h,
        swap_count_prev_1h, momentum_score_1h, momentum_acceleration_1h,
        swap_count_24h, unique_traders_24h, buy_count_24h, sell_count_24h,
        buy_volume_usdc_24h, sell_volume_usdc_24h, net_flow_usdc_24h, momentum_score, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(coin_address) DO UPDATE SET
        swap_count_1h=excluded.swap_count_1h, unique_traders_1h=excluded.unique_traders_1h,
        buy_count_1h=excluded.buy_count_1h, sell_count_1h=excluded.sell_count_1h,
        buy_volume_usdc_1h=excluded.buy_volume_usdc_1h, sell_volume_usdc_1h=excluded.sell_volume_usdc_1h,
        net_flow_usdc_1h=excluded.net_flow_usdc_1h, swap_count_prev_1h=excluded.swap_count_prev_1h,
        momentum_score_1h=excluded.momentum_score_1h, momentum_acceleration_1h=excluded.momentum_acceleration_1h,
        swap_count_24h=excluded.swap_count_24h, unique_traders_24h=excluded.unique_traders_24h,
        buy_count_24h=excluded.buy_count_24h, sell_count_24h=excluded.sell_count_24h,
        buy_volume_usdc_24h=excluded.buy_volume_usdc_24h, sell_volume_usdc_24h=excluded.sell_volume_usdc_24h,
        net_flow_usdc_24h=excluded.net_flow_usdc_24h, momentum_score=excluded.momentum_score,
        updated_at=excluded.updated_at
    `);

    for (const r of rows) {
      const buyVol1h = Number(r.buy_volume_usdc_1h ?? 0);
      const sellVol1h = Number(r.sell_volume_usdc_1h ?? 0);
      const swapCount1h = Number(r.swap_count_1h ?? 0);
      const unique1h = Number(r.unique_traders_1h ?? 0);
      const prev1h = Number(r.swap_count_prev_1h ?? 0);
      const netFlow1h = buyVol1h - sellVol1h;
      const momentum1h = netFlow1h * 0.2 + unique1h * 4 + swapCount1h * 2;
      const accel1h = swapCount1h / Math.max(1, prev1h);

      const buyVol24h = Number(r.buy_volume_usdc_24h ?? 0);
      const sellVol24h = Number(r.sell_volume_usdc_24h ?? 0);
      const swapCount24h = Number(r.swap_count_24h ?? 0);
      const unique24h = Number(r.unique_traders_24h ?? 0);
      const netFlow24h = buyVol24h - sellVol24h;
      const momentum24h = netFlow24h * 0.1 + unique24h * 2 + swapCount24h;

      upsert.run(
        r.coin_address,
        swapCount1h, unique1h, Number(r.buy_count_1h ?? 0), Number(r.sell_count_1h ?? 0),
        buyVol1h, sellVol1h, netFlow1h, prev1h, momentum1h, accel1h,
        swapCount24h, unique24h, Number(r.buy_count_24h ?? 0), Number(r.sell_count_24h ?? 0),
        buyVol24h, sellVol24h, netFlow24h, momentum24h,
        new Date().toISOString(),
      );
    }

    return rows.length;
  }

  // ============================================================
  // Alerts
  // ============================================================

  generateAlerts(): number {
    const cfg = this.cfg;
    const alerts: Array<{ type: string; entity_id: string; severity: string; message: string; fingerprint: string }> = [];

    const hotCoins = this.db.prepare(`
      SELECT a.coin_address, c.chain_id,
             a.swap_count_1h, a.swap_count_prev_1h,
             a.momentum_score_1h, a.momentum_acceleration_1h,
             a.swap_count_24h, a.momentum_score
      FROM coin_analytics a LEFT JOIN coins c ON c.address = a.coin_address
      WHERE a.swap_count_1h >= ? AND a.momentum_score_1h >= ? AND a.momentum_acceleration_1h >= ?
      ORDER BY a.momentum_score_1h DESC LIMIT ?
    `).all(cfg.alertCoinSwaps1h, cfg.alertMinMomentum1h, cfg.alertMinAcceleration1h, cfg.alertMaxCoinAlertsPerRun) as Array<any>;

    for (const c of hotCoins) {
      alerts.push({
        type: "COIN_ACTIVITY_SPIKE", entity_id: c.coin_address,
        severity: Number(c.momentum_score_1h) >= cfg.alertMinMomentum1h * 2 ? "high" : "medium",
        message: addCoinLinkToMessage(
          `Fast momentum: ${c.coin_address} swaps1h=${c.swap_count_1h} prev1h=${c.swap_count_prev_1h} accel1h=${Number(c.momentum_acceleration_1h).toFixed(2)} momentum1h=${Number(c.momentum_score_1h).toFixed(2)} (swaps24h=${c.swap_count_24h})`,
          c.coin_address, c.chain_id,
        ),
        fingerprint: `coin_spike_fast:${c.coin_address}:${new Date().toISOString().slice(0, 13)}`,
      });
    }

    const whales = this.db.prepare(`
      SELECT s.id, s.coin_address, c.chain_id, s.sender_address, s.amount_usdc
      FROM coin_swaps s LEFT JOIN coins c ON c.address = s.coin_address
      WHERE s.amount_usdc >= ? AND datetime(s.block_timestamp) >= datetime('now', '-1 day')
      ORDER BY s.amount_usdc DESC LIMIT 3
    `).all(cfg.alertWhaleSwapUsd * 1.5) as Array<any>;

    for (const w of whales) {
      alerts.push({
        type: "WHALE_SWAP", entity_id: w.coin_address,
        severity: Number(w.amount_usdc) > cfg.alertWhaleSwapUsd * 3 ? "high" : "medium",
        message: addCoinLinkToMessage(
          `Whale swap ${w.id} on ${w.coin_address} by ${w.sender_address} amount_usdc=${Number(w.amount_usdc).toFixed(2)}`,
          w.coin_address, w.chain_id,
        ),
        fingerprint: `whale:${w.id}`,
      });
    }

    alerts.push(...this.watchlistAlertCandidates());

    const insert = this.db.prepare(`
      INSERT OR IGNORE INTO alerts (kind, type, entity_id, severity, message, payload_json, fingerprint, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    let newCount = 0;
    for (const a of alerts) {
      const r = insert.run(a.type, a.type, a.entity_id, a.severity, a.message, null, a.fingerprint, new Date().toISOString());
      if (r.changes > 0) {
        newCount += 1;
        const line = `${new Date().toISOString()} [ALERT:${a.severity}] ${a.message}`;
        console.log(line);
        appendAlertLog(line);
      }
    }
    return newCount;
  }

  private watchlistAlertCandidates(): Array<{ type: string; entity_id: string; severity: string; message: string; fingerprint: string }> {
    const cfg = this.cfg;
    const wl = this.db.prepare(`
      SELECT w.list_name, w.coin_address, w.label, c.symbol, c.name, c.chain_id, c.volume_24h,
             a.swap_count_1h, a.net_flow_usdc_1h, a.momentum_score_1h, a.momentum_acceleration_1h,
             a.swap_count_24h, a.net_flow_usdc_24h
      FROM coin_watchlist w
      LEFT JOIN coins c ON c.address = w.coin_address
      LEFT JOIN coin_analytics a ON a.coin_address = w.coin_address
      WHERE w.enabled = 1
    `).all() as Array<any>;

    const nowHour = new Date().toISOString().slice(0, 13);
    const alerts: Array<{ type: string; entity_id: string; severity: string; message: string; fingerprint: string }> = [];

    for (const w of wl) {
      const label = w.label || w.symbol || w.name || w.coin_address;
      const addr = w.coin_address;
      const listName = w.list_name || "default";

      const moveSummary = this.db.prepare(`
        SELECT COUNT(*) AS large_swaps_1h, MAX(amount_usdc) AS max_swap_usdc, SUM(amount_usdc) AS total_large_swap_usdc
        FROM coin_swaps WHERE coin_address = ? AND datetime(block_timestamp) >= datetime('now', '-1 hour') AND amount_usdc >= ?
      `).get(addr, cfg.watchlistMinSwapUsd) as any;

      const largeSwaps1h = Number(moveSummary?.large_swaps_1h ?? 0);
      const maxSwap1h = Number(moveSummary?.max_swap_usdc ?? 0);
      const totalLarge1h = Number(moveSummary?.total_large_swap_usdc ?? 0);
      if (largeSwaps1h > 0) {
        alerts.push({
          type: "WATCHLIST_MOVE", entity_id: addr,
          severity: maxSwap1h >= cfg.watchlistMinSwapUsd * 8 ? "high" : "medium",
          message: addCoinLinkToMessage(
            `[${listName}] ${label} large-swaps1h=${largeSwaps1h} maxSwap=${maxSwap1h.toFixed(2)} totalLargeSwapUsd=${totalLarge1h.toFixed(2)}`,
            addr, w.chain_id,
          ),
          fingerprint: `watch_move:${listName}:${addr}:${nowHour}`,
        });
      }

      const swaps1h = Number(w.swap_count_1h ?? 0);
      const netFlow1h = Number(w.net_flow_usdc_1h ?? 0);
      const momentum1h = Number(w.momentum_score_1h ?? 0);
      const accel1h = Number(w.momentum_acceleration_1h ?? 0);
      if (swaps1h >= cfg.watchlistMinSwaps1h || Math.abs(netFlow1h) >= cfg.watchlistMinNetFlowUsd1h) {
        alerts.push({
          type: "WATCHLIST_SUMMARY", entity_id: addr,
          severity: momentum1h >= cfg.alertMinMomentum1h * 1.5 || accel1h >= cfg.alertMinAcceleration1h * 1.5 ? "high" : "medium",
          message: addCoinLinkToMessage(
            `[${listName}] ${label} swaps1h=${swaps1h} netFlow1h=${netFlow1h.toFixed(2)} momentum1h=${momentum1h.toFixed(2)} accel1h=${accel1h.toFixed(2)} volume24h=${Number(w.volume_24h ?? 0).toFixed(2)}`,
            addr, w.chain_id,
          ),
          fingerprint: `watch_summary:${listName}:${addr}:${nowHour}`,
        });
      }
    }

    return alerts;
  }

  // ============================================================
  // Poll (combined cycle)
  // ============================================================

  async pollOnce(): Promise<PollResult> {
    const syncedRecent = await this.syncRecentCoins();
    const syncedTop = await this.syncTopVolumeCoins();
    const swaps = await this.ingestSwaps();
    const clusters = this.rebuildClusters();
    const analytics = this.refreshAnalytics();
    const alerts = this.generateAlerts();
    return { syncedRecent, syncedTop, swaps, clusters, analytics, alerts };
  }

  // ============================================================
  // Read-only queries
  // ============================================================

  recentCoins(limit = 20): any[] {
    return this.db.prepare(`
      SELECT address, symbol, name, created_at, volume_24h, market_cap,
             CASE WHEN chain_id = 84532 THEN 'https://zora.co/coin/base-sepolia:' || lower(address)
                  ELSE 'https://zora.co/coin/base:' || lower(address)
             END AS coin_url
      FROM coins ORDER BY datetime(created_at) DESC LIMIT ?
    `).all(limit);
  }

  topVolumeCoins(limit = 20): any[] {
    return this.db.prepare(`
      SELECT address, symbol, name, created_at, volume_24h, market_cap,
             CASE WHEN chain_id = 84532 THEN 'https://zora.co/coin/base-sepolia:' || lower(address)
                  ELSE 'https://zora.co/coin/base:' || lower(address)
             END AS coin_url
      FROM coins ORDER BY volume_24h DESC LIMIT ?
    `).all(limit);
  }

  topAnalytics(limit = 20): any[] {
    return this.db.prepare(`
      SELECT a.coin_address, c.symbol, c.name, c.market_cap, c.volume_24h,
             a.swap_count_1h, a.unique_traders_1h, a.buy_count_1h, a.sell_count_1h,
             a.buy_volume_usdc_1h, a.sell_volume_usdc_1h, a.net_flow_usdc_1h,
             a.momentum_score_1h, a.momentum_acceleration_1h,
             a.swap_count_24h, a.unique_traders_24h, a.net_flow_usdc_24h, a.momentum_score,
             CASE WHEN c.chain_id = 84532 THEN 'https://zora.co/coin/base-sepolia:' || lower(a.coin_address)
                  ELSE 'https://zora.co/coin/base:' || lower(a.coin_address)
             END AS coin_url
      FROM coin_analytics a LEFT JOIN coins c ON c.address = a.coin_address
      ORDER BY a.momentum_score_1h DESC, a.momentum_score DESC LIMIT ?
    `).all(limit);
  }

  getCoinDetail(address: string): any {
    const addr = normAddress(address);
    const coin = this.db.prepare(`
      SELECT address, symbol, name, created_at, volume_24h, market_cap, total_volume, creator_address, chain_id,
             CASE WHEN chain_id = 84532 THEN 'https://zora.co/coin/base-sepolia:' || lower(address)
                  ELSE 'https://zora.co/coin/base:' || lower(address)
             END AS coin_url
      FROM coins WHERE address = ?
    `).get(addr);
    const analytics = this.db.prepare(`SELECT * FROM coin_analytics WHERE coin_address = ?`).get(addr);
    return { coin: coin ?? null, analytics: analytics ?? null };
  }

  latestAlerts(limit = 20): any[] {
    return this.db.prepare(`
      SELECT type, entity_id, severity, message, created_at,
             CASE WHEN entity_id LIKE '0x%' THEN 'https://zora.co/coin/base:' || lower(entity_id) ELSE NULL END AS coin_url
      FROM alerts ORDER BY id DESC LIMIT ?
    `).all(limit);
  }

  coinCount(): number {
    const row = this.db.prepare("SELECT COUNT(*) AS cnt FROM coins").get() as { cnt: number };
    return row.cnt;
  }

  alertCount(): number {
    const row = this.db.prepare("SELECT COUNT(*) AS cnt FROM alerts WHERE sent_discord_at IS NULL").get() as { cnt: number };
    return row.cnt;
  }

  // ============================================================
  // Watchlist
  // ============================================================

  watchlistAdd(coinAddress: string, listName = "default", label?: string, notes?: string): any {
    const addr = normAddress(coinAddress);
    if (!addr || !addr.startsWith("0x")) throw new Error("Invalid coin address");
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO coin_watchlist (list_name, coin_address, label, notes, enabled, created_at, updated_at)
      VALUES (?, ?, ?, ?, 1, ?, ?)
      ON CONFLICT(list_name, coin_address) DO UPDATE SET
        enabled=1, label=COALESCE(excluded.label, coin_watchlist.label),
        notes=COALESCE(excluded.notes, coin_watchlist.notes), updated_at=excluded.updated_at
    `).run(listName, addr, label ?? null, notes ?? null, now, now);
    return { listName, coinAddress: addr, coinUrl: coinLink(addr, this.cfg.zoraChainId) };
  }

  watchlistRemove(coinAddress: string, listName = "default"): number {
    const addr = normAddress(coinAddress);
    const r = this.db.prepare(`DELETE FROM coin_watchlist WHERE list_name=? AND coin_address=?`).run(listName, addr);
    return r.changes;
  }

  watchlistList(listName = "default"): any[] {
    return this.db.prepare(`
      SELECT w.list_name, w.coin_address, w.label, w.notes, w.enabled, w.updated_at,
             c.symbol, c.name, c.volume_24h,
             a.swap_count_1h, a.net_flow_usdc_1h, a.momentum_score_1h, a.momentum_acceleration_1h,
             a.swap_count_24h, a.unique_traders_24h, a.net_flow_usdc_24h, a.momentum_score,
             CASE WHEN c.chain_id = 84532 THEN 'https://zora.co/coin/base-sepolia:' || lower(w.coin_address)
                  ELSE 'https://zora.co/coin/base:' || lower(w.coin_address)
             END AS coin_url
      FROM coin_watchlist w
      LEFT JOIN coins c ON c.address = w.coin_address
      LEFT JOIN coin_analytics a ON a.coin_address = w.coin_address
      WHERE w.list_name = ?
      ORDER BY w.enabled DESC, COALESCE(a.momentum_score, 0) DESC, w.updated_at DESC
    `).all(listName);
  }

  watchlistMoves(listName = "default", limit = 25): any[] {
    return this.db.prepare(`
      SELECT w.list_name, w.coin_address, COALESCE(w.label, c.symbol, c.name, w.coin_address) label,
             s.activity_type, s.amount_usdc, s.sender_address, s.recipient_address, s.block_timestamp,
             CASE WHEN c.chain_id = 84532 THEN 'https://zora.co/coin/base-sepolia:' || lower(w.coin_address)
                  ELSE 'https://zora.co/coin/base:' || lower(w.coin_address)
             END AS coin_url
      FROM coin_watchlist w
      JOIN coin_swaps s ON s.coin_address = w.coin_address
      LEFT JOIN coins c ON c.address = w.coin_address
      WHERE w.list_name = ? AND w.enabled = 1
      ORDER BY datetime(s.block_timestamp) DESC LIMIT ?
    `).all(listName, limit);
  }

  watchlistCount(listName?: string): number {
    if (listName) {
      const row = this.db.prepare("SELECT COUNT(*) AS cnt FROM coin_watchlist WHERE enabled = 1 AND list_name = ?").get(listName) as { cnt: number };
      return row.cnt;
    }
    const row = this.db.prepare("SELECT COUNT(*) AS cnt FROM coin_watchlist WHERE enabled = 1").get() as { cnt: number };
    return row.cnt;
  }

  // ============================================================
  // Signal queries (used by server's autonomy/zoraSignals)
  // ============================================================

  topMovers(input?: { limit?: number; minMomentum?: number }): ZoraSignalCoin[] {
    const limit = Math.max(1, Math.min(50, input?.limit ?? 10));
    const minMomentum = Number(input?.minMomentum ?? 0);

    const rows = this.db.prepare(`
      SELECT a.coin_address, c.symbol, c.name, c.chain_id,
             COALESCE(a.momentum_score, 0) AS momentum_score,
             COALESCE(a.swap_count_24h, 0) AS swap_count_24h,
             COALESCE(a.net_flow_usdc_24h, 0) AS net_flow_usdc_24h,
             COALESCE(c.volume_24h, 0) AS volume_24h
      FROM coin_analytics a LEFT JOIN coins c ON c.address = a.coin_address
      WHERE COALESCE(a.momentum_score, 0) >= ?
      ORDER BY a.momentum_score DESC LIMIT ?
    `).all(minMomentum, limit) as Array<any>;

    return rows
      .filter((r) => typeof r.coin_address === "string" && isAddress(r.coin_address))
      .map((r) => ({
        coinAddress: r.coin_address.toLowerCase() as `0x${string}`,
        symbol: r.symbol ?? null,
        name: r.name ?? null,
        momentumScore: Number(r.momentum_score ?? 0),
        swaps24h: Number(r.swap_count_24h ?? 0),
        netFlowUsd24h: Number(r.net_flow_usdc_24h ?? 0),
        volume24h: Number(r.volume_24h ?? 0),
        coinUrl: coinUrl(r.chain_id, r.coin_address),
      }));
  }

  watchlistSignals(input?: { listName?: string; limit?: number }): ZoraSignalCoin[] {
    const limit = Math.max(1, Math.min(50, input?.limit ?? 10));
    const listName = input?.listName?.trim() || null;

    const rows = this.db.prepare(`
      SELECT w.coin_address, c.symbol, c.name, c.chain_id,
             COALESCE(a.momentum_score, 0) AS momentum_score,
             COALESCE(a.swap_count_24h, 0) AS swap_count_24h,
             COALESCE(a.net_flow_usdc_24h, 0) AS net_flow_usdc_24h,
             COALESCE(c.volume_24h, 0) AS volume_24h
      FROM coin_watchlist w
      LEFT JOIN coins c ON c.address = w.coin_address
      LEFT JOIN coin_analytics a ON a.coin_address = w.coin_address
      WHERE w.enabled = 1 AND (? IS NULL OR w.list_name = ?)
      ORDER BY COALESCE(a.momentum_score, 0) DESC LIMIT ?
    `).all(listName, listName, limit) as Array<any>;

    return rows
      .filter((r) => typeof r.coin_address === "string" && isAddress(r.coin_address))
      .map((r) => ({
        coinAddress: r.coin_address.toLowerCase() as `0x${string}`,
        symbol: r.symbol ?? null,
        name: r.name ?? null,
        momentumScore: Number(r.momentum_score ?? 0),
        swaps24h: Number(r.swap_count_24h ?? 0),
        netFlowUsd24h: Number(r.net_flow_usdc_24h ?? 0),
        volume24h: Number(r.volume_24h ?? 0),
        coinUrl: coinUrl(r.chain_id, r.coin_address),
      }));
  }

  selectSignalCoin(input: { mode: ZoraSignalMode; listName?: string; minMomentum?: number }): ZoraSignalCoin {
    if (input.mode === "watchlist_top") {
      const list = this.watchlistSignals({ ...(input.listName ? { listName: input.listName } : {}), limit: 1 });
      if (!list.length) throw new Error("No watchlist signal candidates found");
      return list[0]!;
    }
    const movers = this.topMovers({ limit: 1, minMomentum: input.minMomentum ?? 0 });
    if (!movers.length) throw new Error("No top-momentum signal candidates found");
    return movers[0]!;
  }

  detectPumpSignals(input: {
    coinAddresses: `0x${string}`[];
    accelerationThreshold?: number;
    netFlowMinUsdc?: number;
  }): PumpSignal[] {
    const threshold = input.accelerationThreshold ?? 3.0;
    const netFlowMin = input.netFlowMinUsdc ?? 0;
    if (input.coinAddresses.length === 0) return [];

    const placeholders = input.coinAddresses.map(() => "?").join(",");
    const rows = this.db.prepare(`
      SELECT a.coin_address, c.symbol, c.name, c.chain_id,
             COALESCE(a.momentum_acceleration_1h, 0) AS momentum_acceleration_1h,
             COALESCE(a.net_flow_usdc_1h, 0) AS net_flow_usdc_1h,
             COALESCE(a.momentum_score, 0) AS momentum_score
      FROM coin_analytics a LEFT JOIN coins c ON c.address = a.coin_address
      WHERE lower(a.coin_address) IN (${placeholders})
        AND COALESCE(a.momentum_acceleration_1h, 0) >= ?
        AND COALESCE(a.net_flow_usdc_1h, 0) >= ?
      ORDER BY a.momentum_acceleration_1h DESC
    `).all(...input.coinAddresses.map((a) => a.toLowerCase()), threshold, netFlowMin) as Array<any>;

    return rows
      .filter((r) => typeof r.coin_address === "string" && isAddress(r.coin_address))
      .map((r) => ({
        coinAddress: r.coin_address.toLowerCase() as `0x${string}`,
        symbol: r.symbol ?? null,
        name: r.name ?? null,
        momentumAcceleration1h: Number(r.momentum_acceleration_1h),
        netFlowUsdc1h: Number(r.net_flow_usdc_1h),
        momentumScore: Number(r.momentum_score),
        coinUrl: coinUrl(r.chain_id, r.coin_address),
      }));
  }

  detectDipSignals(input: {
    previouslyTradedAddresses?: `0x${string}`[];
    accelerationThreshold?: number;
    minSwapCount24h?: number;
    listName?: string;
  }): DipSignal[] {
    const threshold = input.accelerationThreshold ?? 0.5;
    const minSwaps = input.minSwapCount24h ?? 10;

    const watchlistRows = this.db.prepare(`
      SELECT a.coin_address, c.symbol, c.name, c.chain_id,
             COALESCE(a.momentum_acceleration_1h, 0) AS momentum_acceleration_1h,
             COALESCE(a.net_flow_usdc_1h, 0) AS net_flow_usdc_1h,
             COALESCE(a.swap_count_24h, 0) AS swap_count_24h,
             COALESCE(a.momentum_score, 0) AS momentum_score
      FROM coin_watchlist w
      JOIN coin_analytics a ON lower(a.coin_address) = lower(w.coin_address)
      LEFT JOIN coins c ON c.address = a.coin_address
      WHERE w.enabled = 1
        AND (? IS NULL OR w.list_name = ?)
        AND COALESCE(a.momentum_acceleration_1h, 0) <= ?
        AND COALESCE(a.swap_count_24h, 0) >= ?
        AND COALESCE(a.net_flow_usdc_1h, 0) < 0
      ORDER BY a.net_flow_usdc_1h ASC
    `).all(input.listName ?? null, input.listName ?? null, threshold, minSwaps) as Array<any>;

    let tradedRows: Array<any> = [];
    if (input.previouslyTradedAddresses && input.previouslyTradedAddresses.length > 0) {
      const placeholders = input.previouslyTradedAddresses.map(() => "?").join(",");
      tradedRows = this.db.prepare(`
        SELECT a.coin_address, c.symbol, c.name, c.chain_id,
               COALESCE(a.momentum_acceleration_1h, 0) AS momentum_acceleration_1h,
               COALESCE(a.net_flow_usdc_1h, 0) AS net_flow_usdc_1h,
               COALESCE(a.swap_count_24h, 0) AS swap_count_24h,
               COALESCE(a.momentum_score, 0) AS momentum_score
        FROM coin_analytics a LEFT JOIN coins c ON c.address = a.coin_address
        WHERE lower(a.coin_address) IN (${placeholders})
          AND COALESCE(a.momentum_acceleration_1h, 0) <= ?
          AND COALESCE(a.swap_count_24h, 0) >= ?
          AND COALESCE(a.net_flow_usdc_1h, 0) < 0
        ORDER BY a.net_flow_usdc_1h ASC
      `).all(...input.previouslyTradedAddresses.map((a) => a.toLowerCase()), threshold, minSwaps) as Array<any>;
    }

    const seen = new Set<string>();
    const results: DipSignal[] = [];
    for (const r of [...watchlistRows, ...tradedRows]) {
      if (typeof r.coin_address !== "string" || !isAddress(r.coin_address)) continue;
      const addr = r.coin_address.toLowerCase();
      if (seen.has(addr)) continue;
      seen.add(addr);
      results.push({
        coinAddress: addr as `0x${string}`,
        symbol: r.symbol ?? null, name: r.name ?? null,
        momentumAcceleration1h: Number(r.momentum_acceleration_1h),
        netFlowUsdc1h: Number(r.net_flow_usdc_1h),
        swapCount24h: Number(r.swap_count_24h),
        momentumScore: Number(r.momentum_score),
        coinUrl: coinUrl(r.chain_id, r.coin_address),
      });
    }
    return results;
  }

  discountOwnActivity(coinAddress: `0x${string}`, clusterWalletAddresses: string[]): number {
    if (clusterWalletAddresses.length === 0) return 1.0;
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const addr = coinAddress.toLowerCase();

    const totalRow = this.db.prepare(
      `SELECT COUNT(*) AS cnt FROM coin_swaps WHERE lower(coin_address) = ? AND block_timestamp >= ?`
    ).get(addr, oneHourAgo) as { cnt: number } | undefined;
    const totalSwaps = totalRow?.cnt ?? 0;
    if (totalSwaps === 0) return 1.0;

    const lowerAddresses = clusterWalletAddresses.map((a) => a.toLowerCase());
    const placeholders = lowerAddresses.map(() => "?").join(",");
    const ownRow = this.db.prepare(
      `SELECT COUNT(*) AS cnt FROM coin_swaps WHERE lower(coin_address) = ? AND block_timestamp >= ? AND lower(sender_address) IN (${placeholders})`
    ).get(addr, oneHourAgo, ...lowerAddresses) as { cnt: number } | undefined;
    const ownSwaps = ownRow?.cnt ?? 0;
    if (ownSwaps === 0) return 1.0;

    return Math.max(0, 1.0 - ownSwaps / totalSwaps);
  }

  isCoinInWatchlist(coinAddress: `0x${string}`, listName?: string): boolean {
    const row = this.db.prepare(`
      SELECT 1 AS ok FROM coin_watchlist
      WHERE enabled = 1 AND lower(coin_address) = lower(?) AND (? IS NULL OR list_name = ?)
      LIMIT 1
    `).get(coinAddress, listName ?? null, listName ?? null) as { ok: number } | undefined;
    return Boolean(row?.ok);
  }

  getFleetWatchlistName(): string {
    return process.env.FLEET_WATCHLIST_NAME?.trim() || "Active Positions";
  }

  addToWatchlist(coinAddress: `0x${string}`, input?: { listName?: string; label?: string; notes?: string }): void {
    const listName = input?.listName ?? this.getFleetWatchlistName();
    const addr = coinAddress.toLowerCase();
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO coin_watchlist (list_name, coin_address, label, notes, enabled, created_at, updated_at)
      VALUES (?, ?, ?, ?, 1, ?, ?)
      ON CONFLICT(list_name, coin_address) DO UPDATE SET
        label = COALESCE(excluded.label, coin_watchlist.label),
        notes = COALESCE(excluded.notes, coin_watchlist.notes),
        enabled = 1, updated_at = excluded.updated_at
    `).run(listName, addr, input?.label ?? null, input?.notes ?? null, now, now);
  }

  removeFromWatchlist(coinAddress: `0x${string}`, listName?: string): boolean {
    const list = listName ?? this.getFleetWatchlistName();
    const addr = coinAddress.toLowerCase();
    const r = this.db.prepare(
      `UPDATE coin_watchlist SET enabled = 0, updated_at = ? WHERE list_name = ? AND lower(coin_address) = ?`
    ).run(new Date().toISOString(), list, addr);
    return r.changes > 0;
  }

  // ============================================================
  // Alert dispatch
  // ============================================================

  getUnsentAlerts(limit = 20): AlertRow[] {
    return this.db.prepare(`
      SELECT id, type, entity_id, severity, message, created_at
      FROM alerts WHERE sent_discord_at IS NULL ORDER BY id ASC LIMIT ?
    `).all(limit) as AlertRow[];
  }

  markAlertsSent(ids: number[]): number {
    if (!ids.length) return 0;
    const q = ids.map(() => "?").join(",");
    const r = this.db.prepare(`UPDATE alerts SET sent_discord_at = ? WHERE id IN (${q})`).run(new Date().toISOString(), ...ids);
    return r.changes;
  }

  private buildDispatchPayload(
    rows: Array<{ id: number; type: string; entity_id: string | null; severity: string; message: string }>,
    suppressedCount = 0,
  ) {
    const coinCtxStmt = this.db.prepare(`
      SELECT c.symbol, c.name, c.chain_id, c.market_cap, a.momentum_acceleration_1h
      FROM coins c LEFT JOIN coin_analytics a ON a.coin_address = c.address
      WHERE c.address = ? LIMIT 1
    `);

    const chartCoinMap = new Map<string, { coinAddress: string; symbol: string | null; name: string | null }>();
    const alertContexts: Array<{ symbol: string; name: string; marketCap: number; trend: string; severity: string; type: string; message: string }> = [];

    const lines = rows.map((r) => {
      const sev = r.severity.toUpperCase();
      const ctx = r.entity_id ? (coinCtxStmt.get(r.entity_id) as any) : null;
      const symbol = String(ctx?.symbol ?? "").trim();
      const name = String(ctx?.name ?? "").trim();
      const coinLabel = symbol || name ? `${symbol || "?"} / ${name || symbol || "?"}` : "unknown / unknown";
      const accel = Number(ctx?.momentum_acceleration_1h ?? 1);
      const trend = accel > 1.05 ? { emoji: "📈", word: "up" } : accel < 0.95 ? { emoji: "📉", word: "down" } : { emoji: "➡️", word: "flat" };
      const marketCapUsd = Number(ctx?.market_cap ?? 0);
      const link = coinLink(r.entity_id, ctx?.chain_id);
      const cleaned = cleanAlertMessage(r.message, r.entity_id, link);
      const finalMessage = `${cleaned}${link ? ` [open coin](${link})` : ""}`;
      const mcap = r.entity_id ? ` • mcap $${formatUsd(marketCapUsd)}` : "";
      const coinMeta = r.entity_id ? ` ${coinLabel}${mcap} • ${trend.emoji} momentum ${trend.word}` : "";

      if (r.entity_id && r.entity_id.startsWith("0x") && !chartCoinMap.has(r.entity_id)) {
        chartCoinMap.set(r.entity_id, { coinAddress: r.entity_id, symbol: symbol || null, name: name || null });
      }
      if (r.entity_id) {
        alertContexts.push({ symbol: symbol || "unknown", name: name || "unknown", marketCap: marketCapUsd, trend: trend.word, severity: sev, type: r.type, message: r.message });
      }

      return `- [${sev}] ${r.type}${coinMeta} — ${finalMessage}`;
    });

    const dedupeNote = suppressedCount > 0 ? `, deduped ${suppressedCount}` : "";
    return {
      message: `🚨 zora-intelligence alerts (${rows.length}${dedupeNote})\n${lines.join("\n")}`,
      chartCoins: [...chartCoinMap.values()],
      alertContexts,
    };
  }

  private applyDispatchDiversity(rows: AlertRow[], limit: number) {
    const dedupedRows = dedupeAlertRows(rows);
    const mode = String(this.cfg.alertDiversityMode ?? "on").toLowerCase();
    const enabled = ["1", "true", "yes", "on"].includes(mode);

    const entityMetaStmt = this.db.prepare(`
      SELECT MAX(sent_discord_at) AS last_sent_at,
             SUM(CASE WHEN datetime(sent_discord_at) >= datetime('now', ?) THEN 1 ELSE 0 END) AS recent_count,
             MAX(c.market_cap) AS market_cap
      FROM alerts a LEFT JOIN coins c ON c.address = a.entity_id
      WHERE a.sent_discord_at IS NOT NULL AND a.entity_id = ?
    `);

    const metaByEntity = new Map<string, { lastSentAt?: string | null; recentCount?: number; marketCap?: number }>();
    for (const row of dedupedRows) {
      const entity = String(row.entity_id ?? "").toLowerCase();
      if (!entity || metaByEntity.has(entity)) continue;
      const r = entityMetaStmt.get(`-${Math.max(1, this.cfg.alertNoveltyWindowHours)} hours`, entity) as any;
      metaByEntity.set(entity, { lastSentAt: r?.last_sent_at ?? null, recentCount: Number(r?.recent_count ?? 0), marketCap: Number(r?.market_cap ?? 0) });
    }

    const options: DiversityOptions = {
      enabled,
      perCoinCooldownMin: Math.max(0, this.cfg.alertPerCoinCooldownMin),
      maxPerCoinPerDispatch: Math.max(1, this.cfg.alertMaxPerCoinPerDispatch),
      noveltyWindowHours: Math.max(1, this.cfg.alertNoveltyWindowHours),
      largeCapPenaltyAboveUsd: Math.max(0, this.cfg.alertLargeCapPenaltyAboveUsd),
    };

    const selected = selectDiverseAlerts(dedupedRows, limit, options, metaByEntity);
    return { selected, suppressedCount: Math.max(0, rows.length - selected.length) };
  }

  private async refreshCoinData(addresses: string[]): Promise<void> {
    const unique = [...new Set(addresses.filter(a => a?.startsWith("0x")))];
    for (const address of unique.slice(0, 10)) {
      try {
        const res = await getCoin({ address, chain: this.cfg.zoraChainId });
        const token = res?.data?.zora20Token;
        if (token) this.upsertCoin(token);
      } catch { /* non-blocking */ }
    }
  }

  async dispatchPendingAlerts(limit = 12): Promise<string | null> {
    const fetchLimit = Math.max(limit, limit * 4);
    const rows = this.getUnsentAlerts(fetchLimit);
    if (!rows.length) return null;

    const { selected, suppressedCount } = this.applyDispatchDiversity(rows, limit);
    await this.refreshCoinData(selected.map(r => r.entity_id).filter(Boolean) as string[]);
    const payload = this.buildDispatchPayload(selected, suppressedCount);

    let commentary = "";
    if (payload.alertContexts.length > 0) {
      try { commentary = await generateBatchCommentary(payload.alertContexts); } catch { /* non-blocking */ }
    }

    this.markAlertsSent(rows.map((r) => r.id));
    const commentLine = commentary ? `\n\n_${commentary}_` : "";
    return payload.message + commentLine;
  }

  async dispatchPendingAlertsRich(limit = 12): Promise<DispatchAlertsRich | null> {
    const fetchLimit = Math.max(limit, limit * 4);
    const rows = this.getUnsentAlerts(fetchLimit);
    if (!rows.length) return null;

    const { selected, suppressedCount } = this.applyDispatchDiversity(rows, limit);
    await this.refreshCoinData(selected.map(r => r.entity_id).filter(Boolean) as string[]);
    const payload = this.buildDispatchPayload(selected, suppressedCount);
    const media: DispatchAlertsRich["media"] = [];

    for (const coin of payload.chartCoins.slice(0, 4)) {
      try {
        const mediaDir = process.env.OPENCLAW_MEDIA_DIR || path.join(process.env.HOME || "/tmp", ".openclaw", "media");
        const filePath = path.join(mediaDir, `alert-price-volume-${normAddress(coin.coinAddress)}.png`);
        const { buildPriceVolumeChart } = await import("./price-volume-lib.js");
        await buildPriceVolumeChart({ coinAddress: coin.coinAddress, hours: 24, bucketMinutes: 15, outFile: filePath });
        media.push({ coinAddress: coin.coinAddress, symbol: coin.symbol, name: coin.name, filePath });
      } catch (err) {
        console.error(`alert chart generation failed for ${coin.coinAddress}:`, err);
      }
    }

    let commentary = "";
    if (payload.alertContexts.length > 0) {
      try { commentary = await generateBatchCommentary(payload.alertContexts); } catch { /* non-blocking */ }
    }

    this.markAlertsSent(rows.map((r) => r.id));
    const commentLine = commentary ? `\n\n_${commentary}_` : "";
    return { message: payload.message + commentLine, media };
  }
}
