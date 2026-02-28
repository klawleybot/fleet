import dotenv from "dotenv";
import { z } from "zod";

dotenv.config({ quiet: true });

const envSchema = z.object({
  ZORA_API_KEY: z.string().optional(),
  ZORA_CHAIN_ID: z.coerce.number().default(8453),
  DB_PATH: z.string().default(
    new URL("../.data/zora-intelligence.db", import.meta.url).pathname
  ),
  POLL_INTERVAL_SEC: z.coerce.number().default(60),
  SWAPS_PER_COIN: z.coerce.number().default(30),
  TRACKED_COIN_COUNT: z.coerce.number().default(75),
  CLUSTER_MIN_INTERACTIONS: z.coerce.number().default(2),
  ALERT_WHALE_SWAP_USD: z.coerce.number().default(5000),
  ALERT_COIN_SWAPS_24H: z.coerce.number().default(50),
  ALERT_COIN_SWAPS_1H: z.coerce.number().default(60),
  ALERT_MIN_MOMENTUM_1H: z.coerce.number().default(250),
  ALERT_MIN_ACCELERATION_1H: z.coerce.number().default(1.4),
  ALERT_MAX_COIN_ALERTS_PER_RUN: z.coerce.number().default(5),
  ALERT_DIVERSITY_MODE: z.string().default("on"),
  ALERT_PER_COIN_COOLDOWN_MIN: z.coerce.number().default(30),
  ALERT_MAX_PER_COIN_PER_DISPATCH: z.coerce.number().default(1),
  ALERT_NOVELTY_WINDOW_HOURS: z.coerce.number().default(12),
  ALERT_LARGE_CAP_PENALTY_ABOVE_USD: z.coerce.number().default(1000000),
  WATCHLIST_MIN_SWAP_USD: z.coerce.number().default(250),
  WATCHLIST_MIN_SWAPS_1H: z.coerce.number().default(18),
  WATCHLIST_MIN_NET_FLOW_USD_1H: z.coerce.number().default(900),
  WATCHLIST_MIN_SWAPS_24H: z.coerce.number().default(20),
  WATCHLIST_MIN_NET_FLOW_USD_24H: z.coerce.number().default(1500),
  PID_PATH: z.string().default("./runtime/zora-intelligence.pid"),
  DAEMON_LOG_PATH: z.string().default("./logs/daemon.out"),
});

export const env = envSchema.parse(process.env);
