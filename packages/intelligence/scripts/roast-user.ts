/**
 * Pull comprehensive roast data for a Zora user by handle or address.
 * 
 * Usage:
 *   npx tsx scripts/roast-user.ts <handle-or-address>
 *   npx tsx scripts/roast-user.ts 8bitbase
 *   npx tsx scripts/roast-user.ts 0x1f332fe7d22e1b2d8ce995a9e9b17444cb0dfb57
 */

import Database from "better-sqlite3";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_DB = resolve(__dirname, "../.data/zora-intelligence.db");

async function main() {
  const input = process.argv[2];
  if (!input) {
    console.error("Usage: roast-user.ts <handle-or-address>");
    process.exit(1);
  }

  const db = new Database(process.env.ZORA_INTEL_DB_PATH || DEFAULT_DB, { readonly: true });

  // Resolve user — by handle or address
  let user: any;
  if (input.startsWith("0x")) {
    user = db.prepare("SELECT * FROM addresses WHERE address = ?").get(input.toLowerCase());
  } else {
    user = db.prepare("SELECT * FROM addresses WHERE last_profile_handle = ? COLLATE NOCASE").get(input);
  }

  if (!user) {
    console.log(`[roast-user] Not in local DB — fetching Zora profile for: ${input}`);
    db.close();
    await fetchZoraProfileFallback(input);
    return;
  }

  console.log("=== USER PROFILE ===");
  console.log(`Handle: @${user.last_profile_handle || "unknown"}`);
  console.log(`Address: ${user.address}`);
  console.log(`First seen: ${user.first_seen_at}`);
  console.log(`Last seen: ${user.last_seen_at}`);
  console.log(`Total swaps: ${user.swap_count} (${user.buy_count} buys, ${user.sell_count} sells)`);
  console.log(`Volume: $${Number(user.volume_usdc).toFixed(2)} USDC`);
  console.log(`Intelligence score: ${Number(user.intelligence_score).toFixed(1)}`);
  
  const buyRatio = user.swap_count > 0 ? (user.buy_count / user.swap_count * 100).toFixed(1) : "0";
  const sellRatio = user.swap_count > 0 ? (user.sell_count / user.swap_count * 100).toFixed(1) : "0";
  const otherCount = user.swap_count - user.buy_count - user.sell_count;
  console.log(`Buy ratio: ${buyRatio}% | Sell ratio: ${sellRatio}% | Other: ${otherCount}`);

  // Top coins traded
  console.log("\n=== TOP COINS TRADED ===");
  const topCoins = db.prepare(`
    SELECT cs.coin_address, c.name, c.symbol,
           count(*) as swaps,
           sum(case when cs.activity_type IN ('BUY','BOUGHT') then 1 else 0 end) as buys,
           sum(case when cs.activity_type IN ('SELL','SOLD') then 1 else 0 end) as sells,
           sum(cs.amount_usdc) as volume_usdc,
           min(cs.block_timestamp) as first_trade,
           max(cs.block_timestamp) as last_trade
    FROM coin_swaps cs
    LEFT JOIN coins c ON c.address = cs.coin_address
    WHERE cs.sender_address = ?
    GROUP BY cs.coin_address
    ORDER BY swaps DESC
    LIMIT 15
  `).all(user.address) as any[];

  for (const coin of topCoins) {
    const ratio = coin.buys > 0 && coin.sells === 0 ? "💎 DIAMOND HANDS" 
      : coin.sells > coin.buys ? "📉 NET SELLER"
      : coin.buys > coin.sells * 3 ? "🤑 HEAVY BUYER"
      : "↔️ MIXED";
    console.log(`  ${coin.symbol || "???"} (${coin.coin_address.slice(0, 10)}...): ${coin.swaps} swaps (${coin.buys}B/${coin.sells}S) vol=$${Number(coin.volume_usdc).toFixed(2)} ${ratio}`);
    console.log(`    Name: ${coin.name || "unknown"} | First: ${coin.first_trade} | Last: ${coin.last_trade}`);
  }

  // Trading patterns
  console.log("\n=== TRADING PATTERNS ===");
  
  // Activity by hour
  const hourly = db.prepare(`
    SELECT cast(strftime('%H', block_timestamp) as integer) as hour, count(*) as swaps
    FROM coin_swaps WHERE sender_address = ?
    GROUP BY hour ORDER BY swaps DESC LIMIT 5
  `).all(user.address) as any[];
  console.log("Peak hours (UTC):", hourly.map((h: any) => `${h.hour}:00 (${h.swaps} swaps)`).join(", "));

  // Recent activity (last 24h)
  const recent = db.prepare(`
    SELECT cs.coin_address, c.symbol, cs.activity_type, cs.amount_usdc, cs.block_timestamp
    FROM coin_swaps cs LEFT JOIN coins c ON c.address = cs.coin_address
    WHERE cs.sender_address = ? AND datetime(cs.block_timestamp) >= datetime('now', '-1 day')
    ORDER BY cs.block_timestamp DESC LIMIT 20
  `).all(user.address) as any[];
  
  console.log(`\n=== LAST 24H ACTIVITY (${recent.length} swaps) ===`);
  for (const r of recent) {
    console.log(`  ${r.block_timestamp} ${r.activity_type} ${r.symbol || r.coin_address.slice(0,10)} $${Number(r.amount_usdc).toFixed(4)}`);
  }

  // Unique coins in last 24h
  const uniqueRecent = new Set(recent.map((r: any) => r.coin_address));
  console.log(`Unique coins last 24h: ${uniqueRecent.size}`);

  // Flip analysis — coins bought and sold
  console.log("\n=== FLIP ANALYSIS ===");
  const flips = db.prepare(`
    SELECT coin_address, c.symbol, c.name,
           sum(case when activity_type IN ('BUY','BOUGHT') then 1 else 0 end) as buys,
           sum(case when activity_type IN ('SELL','SOLD') then 1 else 0 end) as sells,
           min(block_timestamp) as first_buy,
           max(case when activity_type IN ('SELL','SOLD') then block_timestamp end) as last_sell,
           sum(case when activity_type IN ('BUY','BOUGHT') then amount_usdc else 0 end) as buy_vol,
           sum(case when activity_type IN ('SELL','SOLD') then amount_usdc else 0 end) as sell_vol
    FROM coin_swaps cs LEFT JOIN coins c ON c.address = cs.coin_address
    WHERE sender_address = ?
    GROUP BY coin_address
    HAVING sells > 0 AND buys > 0
    ORDER BY sells DESC
    LIMIT 10
  `).all(user.address) as any[];

  let totalFlipBuy = 0, totalFlipSell = 0;
  for (const f of flips) {
    const pnl = Number(f.sell_vol) - Number(f.buy_vol);
    totalFlipBuy += Number(f.buy_vol);
    totalFlipSell += Number(f.sell_vol);
    console.log(`  ${f.symbol || "???"}: ${f.buys}B/${f.sells}S | bought=$${Number(f.buy_vol).toFixed(4)} sold=$${Number(f.sell_vol).toFixed(4)} | PnL=$${pnl.toFixed(4)} ${pnl >= 0 ? "✅" : "❌"}`);
  }
  console.log(`Total flip PnL: $${(totalFlipSell - totalFlipBuy).toFixed(4)} (bought=$${totalFlipBuy.toFixed(4)} sold=$${totalFlipSell.toFixed(4)})`);

  // Diamond hands — bought but never sold
  const diamonds = db.prepare(`
    SELECT coin_address, c.symbol, c.name,
           count(*) as buys,
           sum(amount_usdc) as total_cost
    FROM coin_swaps cs LEFT JOIN coins c ON c.address = cs.coin_address
    WHERE sender_address = ? AND activity_type IN ('BUY','BOUGHT')
      AND coin_address NOT IN (
        SELECT DISTINCT coin_address FROM coin_swaps 
        WHERE sender_address = ? AND activity_type IN ('SELL','SOLD')
      )
    GROUP BY coin_address
    ORDER BY buys DESC
    LIMIT 10
  `).all(user.address, user.address) as any[];

  console.log(`\n=== DIAMOND HANDS (bought, never sold) — ${diamonds.length} coins ===`);
  for (const d of diamonds) {
    console.log(`  ${d.symbol || "???"}: ${d.buys} buys, $${Number(d.total_cost).toFixed(4)} invested`);
  }

  // Cluster membership
  const clusterInfo = db.prepare(`
    SELECT acm.cluster_id, ac.label, count(*) as members
    FROM address_cluster_members acm
    JOIN address_clusters ac ON ac.id = acm.cluster_id
    WHERE acm.address = ?
    GROUP BY acm.cluster_id
  `).all(user.address) as any[];
  
  if (clusterInfo.length > 0) {
    console.log("\n=== CLUSTER MEMBERSHIP ===");
    for (const cl of clusterInfo) {
      console.log(`  Cluster ${cl.cluster_id} (${cl.label || "unnamed"}): ${cl.members} members`);
    }
  }

  // Summary stats for roast material
  console.log("\n=== ROAST SUMMARY ===");
  console.log(JSON.stringify({
    handle: user.last_profile_handle,
    address: user.address,
    totalSwaps: user.swap_count,
    buys: user.buy_count,
    sells: user.sell_count,
    buyRatio: `${buyRatio}%`,
    volumeUsdc: Number(user.volume_usdc).toFixed(2),
    distinctCoins: topCoins.length,
    diamondHandCoins: diamonds.length,
    flipCount: flips.length,
    flipPnl: (totalFlipSell - totalFlipBuy).toFixed(4),
    peakHour: hourly[0]?.hour,
    recentSwaps24h: recent.length,
    activeSince: user.first_seen_at,
  }, null, 2));

  db.close();
}

/**
 * Fallback: fetch Zora profile + holdings via SDK when user isn't in our local DB.
 * Gives us their bio, holdings, created coins, account age — enough for a roast.
 */
async function fetchZoraProfileFallback(identifier: string): Promise<void> {
  const sdk = await import("@zoralabs/coins-sdk") as any;
  if (process.env.ZORA_API_KEY && sdk.setApiKey) {
    sdk.setApiKey(process.env.ZORA_API_KEY);
  }

  let profile: any = null;
  let balances: any[] = [];

  // Fetch profile
  try {
    const res = await sdk.getProfile({ identifier });
    profile = res?.data?.profile;
  } catch (err) {
    console.error(`[roast-user] Failed to fetch Zora profile:`, err);
  }

  if (!profile) {
    console.log("=== UNKNOWN USER ===");
    console.log(`Identifier: ${identifier}`);
    console.log("Not in our DB. Not on Zora. Truly invisible.");
    console.log("\n=== ROAST SUMMARY ===");
    console.log(JSON.stringify({
      handle: identifier,
      source: "unknown",
      totalSwaps: 0,
      note: "Ghost — no local data, no Zora profile. Roast their invisibility or the comment itself.",
    }, null, 2));
    return;
  }

  // Fetch holdings
  try {
    const bRes = await sdk.getProfileBalances({
      identifier,
      count: 15,
      chainIds: [8453],
    });
    balances = bRes?.data?.profile?.coinBalances?.edges?.map((e: any) => e.node) ?? [];
  } catch { /* non-blocking */ }

  const walletAddr = profile.publicWallet?.walletAddress ?? "unknown";
  const createdAt = profile.createdAt ? new Date(profile.createdAt) : null;
  const accountAgeDays = createdAt
    ? Math.floor((Date.now() - createdAt.getTime()) / 86400000)
    : null;

  const socials: string[] = [];
  if (profile.socialAccounts?.twitter) socials.push(`twitter: @${profile.socialAccounts.twitter}`);
  if (profile.socialAccounts?.farcaster) socials.push(`farcaster: ${profile.socialAccounts.farcaster}`);

  console.log("=== ZORA PROFILE (not in local DB) ===");
  console.log(`Handle: @${profile.handle || "unknown"}`);
  console.log(`Display: ${profile.displayName || "none"}`);
  console.log(`Bio: ${profile.bio || "(empty)"}`);
  console.log(`Wallet: ${walletAddr}`);
  console.log(`Wallet type: ${profile.publicWallet?.walletType || "unknown"}`);
  console.log(`Account created: ${profile.createdAt || "unknown"}${accountAgeDays !== null ? ` (${accountAgeDays} days ago)` : ""}`);
  if (socials.length) console.log(`Socials: ${socials.join(", ")}`);

  // Holdings
  console.log(`\n=== HOLDINGS (${balances.length} coins) ===`);
  const holdingsSummary: Array<{ symbol: string; name: string; mcap: number }> = [];
  for (const b of balances.slice(0, 10)) {
    const coin = b.coin;
    const sym = coin?.symbol ?? "???";
    const name = coin?.name ?? "unknown";
    const mcap = Number(coin?.marketCap ?? 0);
    const creator = coin?.creatorAddress?.toLowerCase() ?? "";
    const isCreator = creator === walletAddr.toLowerCase();
    const tag = isCreator ? " [CREATED]" : "";
    console.log(`  ${sym} — ${name} | mcap: $${mcap.toFixed(0)}${tag}`);
    holdingsSummary.push({ symbol: sym, name, mcap });
  }

  // Created coins
  const createdCoins = balances.filter(b =>
    (b.coin?.creatorAddress ?? "").toLowerCase() === walletAddr.toLowerCase()
  );

  // Character analysis
  const traits: string[] = [];
  if (balances.length === 0) traits.push("empty bag — holding nothing");
  if (balances.length >= 10) traits.push("diversified degen — spread across many coins");
  if (createdCoins.length > 0) traits.push(`coin creator (${createdCoins.length} coins)`);
  if (accountAgeDays !== null && accountAgeDays < 7) traits.push("newborn account (< 1 week)");
  if (accountAgeDays !== null && accountAgeDays < 30) traits.push("fresh face (< 1 month)");
  if (profile.bio && profile.bio.length > 100) traits.push("essay-length bio");
  if (!profile.bio) traits.push("no bio — mysterious");

  // Look for memecoins (low mcap)
  const memecoins = holdingsSummary.filter(h => h.mcap < 5000 && h.mcap > 0);
  if (memecoins.length > 3) traits.push(`micro-cap enjoyer (${memecoins.length} coins under $5k mcap)`);

  console.log(`\n=== TRAITS ===`);
  for (const t of traits) console.log(`  • ${t}`);

  console.log("\n=== ROAST SUMMARY ===");
  console.log(JSON.stringify({
    handle: profile.handle,
    displayName: profile.displayName,
    address: walletAddr,
    source: "zora_profile",
    bio: profile.bio || null,
    accountAgeDays,
    holdingsCount: balances.length,
    createdCoinsCount: createdCoins.length,
    topHoldings: holdingsSummary.slice(0, 5).map(h => h.symbol),
    traits,
    note: "User not in local swap DB — roast their profile, holdings, bio, or the comment itself. Do NOT mention 'zero swaps in our database'.",
  }, null, 2));
}

main().catch(err => {
  console.error("Fatal:", err);
  process.exit(1);
});
