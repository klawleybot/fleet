import { getIntelligenceEngine } from "../src/services/intelligence.js";
import type Database from "better-sqlite3";

/** Seed a coin into the engine's DB with sensible defaults. */
export function seedCoin(
  address: string,
  overrides: { symbol?: string; name?: string; chainId?: number; volume24h?: number } = {},
) {
  const db = getIntelligenceEngine().db;
  const { symbol = "TEST", name = "TestCoin", chainId = 8453, volume24h = 1000 } = overrides;
  db.prepare(
    `INSERT OR REPLACE INTO coins(address, symbol, name, chain_id, volume_24h, raw_json, indexed_at)
     VALUES (?, ?, ?, ?, ?, '{}', datetime('now'))`,
  ).run(address, symbol, name, chainId, volume24h);
}

/** Seed coin_analytics with all required columns. */
export function seedAnalytics(
  coinAddress: string,
  data: {
    momentumScore?: number;
    momentumScore1h?: number;
    momentumAcceleration1h?: number;
    swapCount1h?: number;
    swapCount24h?: number;
    netFlowUsdc1h?: number;
    netFlowUsdc24h?: number;
    buyCount1h?: number;
    sellCount1h?: number;
    uniqueTraders1h?: number;
    uniqueTraders24h?: number;
    buyVolumeUsdc1h?: number;
    sellVolumeUsdc1h?: number;
    buyVolumeUsdc24h?: number;
    sellVolumeUsdc24h?: number;
    swapCountPrev1h?: number;
  } = {},
) {
  const db = getIntelligenceEngine().db;
  const d = {
    momentumScore: 50,
    momentumScore1h: 30,
    momentumAcceleration1h: 1.0,
    swapCount1h: 50,
    swapCount24h: 200,
    netFlowUsdc1h: 100,
    netFlowUsdc24h: 500,
    buyCount1h: 30,
    sellCount1h: 20,
    uniqueTraders1h: 10,
    uniqueTraders24h: 40,
    buyVolumeUsdc1h: 500,
    sellVolumeUsdc1h: 400,
    buyCount24h: 120,
    sellCount24h: 80,
    buyVolumeUsdc24h: 2000,
    sellVolumeUsdc24h: 1500,
    swapCountPrev1h: 30,
    ...data,
  };
  db.prepare(
    `INSERT OR REPLACE INTO coin_analytics(
       coin_address, momentum_score, momentum_score_1h, momentum_acceleration_1h,
       swap_count_1h, swap_count_24h, net_flow_usdc_1h, net_flow_usdc_24h,
       buy_count_1h, sell_count_1h, unique_traders_1h, unique_traders_24h,
       buy_count_24h, sell_count_24h,
       buy_volume_usdc_1h, sell_volume_usdc_1h, buy_volume_usdc_24h, sell_volume_usdc_24h,
       swap_count_prev_1h, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
  ).run(
    coinAddress, d.momentumScore, d.momentumScore1h, d.momentumAcceleration1h,
    d.swapCount1h, d.swapCount24h, d.netFlowUsdc1h, d.netFlowUsdc24h,
    d.buyCount1h, d.sellCount1h, d.uniqueTraders1h, d.uniqueTraders24h,
    d.buyCount24h, d.sellCount24h,
    d.buyVolumeUsdc1h, d.sellVolumeUsdc1h, d.buyVolumeUsdc24h, d.sellVolumeUsdc24h,
    d.swapCountPrev1h,
  );
}

export function seedWatchlist(coinAddress: string, listName = "default") {
  const db = getIntelligenceEngine().db;
  db.prepare(
    "INSERT OR REPLACE INTO coin_watchlist(list_name, coin_address, enabled, created_at, updated_at) VALUES (?, ?, 1, datetime('now'), datetime('now'))",
  ).run(listName, coinAddress);
}

export function seedSwap(
  id: string,
  coinAddress: string,
  senderAddress: string,
  opts: { txHash?: string; blockTimestamp?: string } = {},
) {
  const db = getIntelligenceEngine().db;
  const now = opts.blockTimestamp ?? new Date().toISOString();
  db.prepare(
    `INSERT INTO coin_swaps(id, coin_address, chain_id, tx_hash, block_timestamp, activity_type,
     sender_address, recipient_address, amount_decimal, amount_usdc, coin_amount, raw_json, indexed_at)
     VALUES (?, ?, 8453, ?, ?, 'buy', ?, ?, 1.0, 10, 100, '{}', ?)`,
  ).run(id, coinAddress, opts.txHash ?? `0x${id}`, now, senderAddress, coinAddress, now);
}

export function cleanIntelDb() {
  const db = getIntelligenceEngine().db;
  db.exec("DELETE FROM coins; DELETE FROM coin_analytics; DELETE FROM coin_watchlist; DELETE FROM coin_swaps;");
}
