/**
 * Sync Zora followers based on coin holders.
 * 
 * Uses our intelligence DB to infer holders (net buyers) across all openklaw coins,
 * resolves Zora handles, and outputs a follow/unfollow plan.
 * 
 * The browser-based cron job reads this output and executes follows/unfollows.
 * 
 * Usage:
 *   bun x tsx scripts/sync-followers.ts [--coin <address>]
 * 
 * Outputs JSON plan to stdout. State tracked in .data/zora-follow-state.json
 */

import Database from "better-sqlite3";
import { readFileSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const STATE_PATH = resolve(__dirname, "../.data/zora-follow-state.json");
const DB_PATH = process.env.ZORA_INTEL_DB_PATH || resolve(__dirname, "../.data/zora-intelligence.db");

// Our own addresses to exclude
const OUR_ADDRESSES = new Set([
  "0x097677d3e2cde65af10be80ae5e67b8b68eb613d",
  "0x5149dfcd59489a9b1489278bf79e538026c23a17",
  "0x351d0427376889f09d171ddfba3bf9c50705798d",
  "0x0000000000000000000000000000000000000000",
].map(a => a.toLowerCase()));

interface FollowState {
  lastSyncAt: string;
  following: Record<string, { handle: string; address: string; followedAt: string }>;
}

interface ContentCoinRow {
  address: string;
  name: string;
  symbol: string;
}

interface WatchlistCoinRow {
  coin_address: string;
}

interface TraderRow {
  sender_address: string;
  buys: number;
  sells: number;
}

interface AddressHandleRow {
  last_profile_handle: string | null;
}

function loadState(): FollowState {
  if (existsSync(STATE_PATH)) {
    return JSON.parse(readFileSync(STATE_PATH, "utf-8"));
  }
  return { lastSyncAt: "", following: {} };
}

function main() {
  if (!existsSync(DB_PATH)) {
    console.error("Intelligence DB not found at", DB_PATH);
    process.exit(1);
  }

  const db = new Database(DB_PATH, { readonly: true });
  const state = loadState();

  console.error("=== Zora Follower Sync ===");
  console.error(`Last sync: ${state.lastSyncAt || "never"}`);
  console.error(`Currently following: ${Object.keys(state.following).length} users`);

  // Find all openklaw coins from watchlist + creator coins + OpeClaw
  const openklaw_creator = "0x097677d3e2cde65af10be80ae5e67b8b68eb613d";
  const contentCoins = db.prepare(
    "SELECT address, name, symbol FROM coins WHERE creator_address = ? OR creator_address = ?"
  ).all(openklaw_creator, openklaw_creator.toLowerCase()) as ContentCoinRow[];

  const watchlistCoins = db.prepare(
    "SELECT coin_address FROM coin_watchlist WHERE list_name = 'openklaw-coins' AND enabled = 1"
  ).all() as WatchlistCoinRow[];

  // OpeClaw is our main traded coin
  const opeClaw = "0xb23c6e17fe82f958ade869d31055c445f76c5c43";
  const creatorCoinAddr = "0x2e6e49e3f1c76d9b8c7ca0bee2005ed6de0e2046";
  
  const allCoinAddrs = [
    creatorCoinAddr,
    opeClaw,
    ...contentCoins.map((c) => c.address),
    ...watchlistCoins.map((c) => c.coin_address),
  ];
  const uniqueCoins = [...new Set(allCoinAddrs.map(a => a.toLowerCase()))];

  console.error(`Tracking ${uniqueCoins.length} coins (1 creator + ${contentCoins.length} content)`);
  for (const c of contentCoins) {
    console.error(`  ${c.symbol}: ${c.address}`);
  }

  // For each coin, find net holders (buys > sells) from swap data
  const holderMap = new Map<string, { coins: string[]; buys: number; sells: number }>();

  for (const coinAddr of uniqueCoins) {
    const traders = db.prepare(`
      SELECT sender_address,
             sum(case when activity_type = 'BUY' then 1 else 0 end) as buys,
             sum(case when activity_type = 'SELL' then 1 else 0 end) as sells
      FROM coin_swaps 
      WHERE coin_address = ?
      GROUP BY sender_address
      HAVING buys > sells
    `).all(coinAddr) as TraderRow[];

    for (const t of traders) {
      const addr = t.sender_address.toLowerCase();
      if (OUR_ADDRESSES.has(addr)) continue;

      const existing = holderMap.get(addr);
      if (existing) {
        existing.coins.push(coinAddr);
        existing.buys += t.buys;
        existing.sells += t.sells;
      } else {
        holderMap.set(addr, { coins: [coinAddr], buys: t.buys, sells: t.sells });
      }
    }
  }

  console.error(`Net holders across all coins: ${holderMap.size}`);

  // Resolve handles from addresses table
  const holders: Array<{ address: string; handle: string; buys: number; sells: number; coins: number }> = [];

  for (const [addr, data] of holderMap) {
    const row = db.prepare(
      "SELECT last_profile_handle FROM addresses WHERE address = ?"
    ).get(addr) as AddressHandleRow | undefined;

    // Skip truncated address handles (e.g. "0xfe73...e10d") — not real profiles
    if (row?.last_profile_handle && !row.last_profile_handle.match(/^0x[a-f0-9]{4}\.\.\.[a-f0-9]{4}$/i)) {
      holders.push({
        address: addr,
        handle: row.last_profile_handle,
        buys: data.buys,
        sells: data.sells,
        coins: data.coins.length,
      });
    }
  }

  holders.sort((a, b) => b.buys - a.buys);

  console.error(`Holders with resolved handles: ${holders.length}`);

  // Determine follow/unfollow actions
  const currentHolderAddrs = new Set(holders.map(h => h.address));
  const currentFollowing = new Set(Object.keys(state.following));

  const toFollow = holders.filter(h => !currentFollowing.has(h.address));
  const toUnfollow = [...currentFollowing]
    .filter(addr => !currentHolderAddrs.has(addr))
    .map(addr => ({
      address: addr,
      handle: state.following[addr]?.handle || "unknown",
    }));

  console.error(`\nActions needed:`);
  console.error(`  Follow: ${toFollow.length} new holders`);
  console.error(`  Unfollow: ${toUnfollow.length} former holders`);
  console.error(`  Already following: ${currentFollowing.size - toUnfollow.length}`);

  if (holders.length > 0) {
    console.error(`\nTop holders:`);
    for (const h of holders.slice(0, 10)) {
      console.error(`  @${h.handle}: ${h.buys}B/${h.sells}S across ${h.coins} coin(s)`);
    }
  }

  // Output the plan
  const plan = {
    holders: holders.map(h => ({ address: h.address, handle: h.handle })),
    toFollow: toFollow.map(h => ({ address: h.address, handle: h.handle })),
    toUnfollow,
    stats: {
      totalHolders: holderMap.size,
      withHandles: holders.length,
      alreadyFollowing: currentFollowing.size - toUnfollow.length,
    },
    timestamp: new Date().toISOString(),
  };

  console.log(JSON.stringify(plan, null, 2));
  db.close();
}

main();
