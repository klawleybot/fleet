import { refreshCoinAnalytics } from "../src/zora.js";
import { db } from "../src/db.js";

interface CoinAnalyticsRow {
  momentum_score_1h?: number;
  momentum_acceleration_1h?: number;
  swap_count_1h?: number;
  swap_count_24h?: number;
}

const count = refreshCoinAnalytics();
console.log("Refreshed", count, "coins");

const a = db.prepare("SELECT * FROM coin_analytics WHERE coin_address = ?").get("0xb23c6e17fe82f958ade869d31055c445f76c5c43") as CoinAnalyticsRow | undefined;
console.log(`0xb23c: mom1h=${a?.momentum_score_1h} accel=${a?.momentum_acceleration_1h} swaps1h=${a?.swap_count_1h} swaps24h=${a?.swap_count_24h}`);
