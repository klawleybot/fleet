/**
 * Market Commentary Context Generator
 *
 * Analyzes trending Zora coins over time and generates structured context
 * for Klawley's daily content coin roasts.
 *
 * Outputs a rich narrative prompt with:
 * - Coins that dumped (rugged / mass sells)
 * - Coins that pumped (FOMO inflows)
 * - Degen trader profiles (serial buyers/sellers)
 * - Fresh launches and their fate
 * - Overall market vibe
 */

import Database from "better-sqlite3";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_DB = resolve(__dirname, "../.data/zora-intelligence.db");

interface CoinMovement {
  symbol: string;
  name: string;
  address: string;
  marketCap: number;
  volume24h: number;
  swaps24h: number;
  buys24h: number;
  sells24h: number;
  netFlowUsdc: number;
  momentum: number;
  acceleration: number;
  sellRatio: number; // sells / total swaps
  buyPressure: number; // buy_vol / sell_vol
}

interface DegenProfile {
  address: string;
  swaps: number;
  coins: number;
  buys: number;
  sells: number;
  style: "ape" | "flipper" | "hodler" | "exit-only";
}

interface FreshLaunch {
  symbol: string;
  name: string;
  createdAt: string;
  hoursOld: number;
  swaps: number;
  buySellRatio: number;
  netFlow: number;
  verdict: "pumping" | "dumping" | "flatline" | "too-early";
}

interface HourlySlice {
  hour: string;
  swaps: number;
  buys: number;
  sells: number;
}

interface CoinTimeline {
  symbol: string;
  name: string;
  hourly: HourlySlice[];
  trend: "accelerating" | "decelerating" | "dead" | "volatile" | "steady";
  peakHour: string;
  peakSwaps: number;
}

interface MarketContext {
  generatedAt: string;
  dataRange: { oldest: string; newest: string };
  totalActiveCoins: number;
  totalSwaps24h: number;

  // The stories
  biggestDumps: CoinMovement[];
  biggestPumps: CoinMovement[];
  freshLaunches: FreshLaunch[];
  degenProfiles: DegenProfile[];
  timelines: CoinTimeline[];
  overallVibe: "bullish" | "bearish" | "crab" | "chaos";
  vibeReason: string;
}

export function generateMarketContext(dbPath?: string): MarketContext {
  const db = new Database(dbPath || DEFAULT_DB, { readonly: true });

  const now = new Date().toISOString();

  // Data range
  const range = db.prepare(
    "SELECT min(block_timestamp) as oldest, max(block_timestamp) as newest FROM coin_swaps"
  ).get() as any;

  // Total activity
  const activity = db.prepare(`
    SELECT count(*) as swaps, count(distinct coin_address) as coins
    FROM coin_swaps
    WHERE block_timestamp > datetime('now', '-24 hours')
  `).get() as any;

  // === BIGGEST DUMPS (high sell ratio + volume) ===
  const dumps = db.prepare(`
    SELECT c.symbol, c.name, c.address, c.market_cap, c.volume_24h,
           ca.swap_count_24h, ca.buy_count_24h, ca.sell_count_24h,
           ca.net_flow_usdc_24h, ca.momentum_score, ca.momentum_acceleration_1h,
           ca.buy_volume_usdc_24h, ca.sell_volume_usdc_24h
    FROM coin_analytics ca
    JOIN coins c ON c.address = ca.coin_address
    WHERE ca.swap_count_24h >= 10
      AND ca.sell_count_24h > ca.buy_count_24h
    ORDER BY (ca.sell_count_24h * 1.0 / ca.swap_count_24h) DESC, ca.swap_count_24h DESC
    LIMIT 8
  `).all() as any[];

  const biggestDumps: CoinMovement[] = dumps.map(d => ({
    symbol: d.symbol,
    name: d.name,
    address: d.address,
    marketCap: d.market_cap || 0,
    volume24h: d.volume_24h || 0,
    swaps24h: d.swap_count_24h,
    buys24h: d.buy_count_24h,
    sells24h: d.sell_count_24h,
    netFlowUsdc: d.net_flow_usdc_24h,
    momentum: d.momentum_score,
    acceleration: d.momentum_acceleration_1h,
    sellRatio: d.sell_count_24h / d.swap_count_24h,
    buyPressure: d.buy_volume_usdc_24h / Math.max(d.sell_volume_usdc_24h, 0.01),
  }));

  // === BIGGEST PUMPS (high buy ratio + volume) ===
  const pumps = db.prepare(`
    SELECT c.symbol, c.name, c.address, c.market_cap, c.volume_24h,
           ca.swap_count_24h, ca.buy_count_24h, ca.sell_count_24h,
           ca.net_flow_usdc_24h, ca.momentum_score, ca.momentum_acceleration_1h,
           ca.buy_volume_usdc_24h, ca.sell_volume_usdc_24h
    FROM coin_analytics ca
    JOIN coins c ON c.address = ca.coin_address
    WHERE ca.swap_count_24h >= 10
      AND ca.buy_count_24h > ca.sell_count_24h
    ORDER BY (ca.buy_count_24h * 1.0 / ca.swap_count_24h) DESC, ca.swap_count_24h DESC
    LIMIT 8
  `).all() as any[];

  const biggestPumps: CoinMovement[] = pumps.map(p => ({
    symbol: p.symbol,
    name: p.name,
    address: p.address,
    marketCap: p.market_cap || 0,
    volume24h: p.volume_24h || 0,
    swaps24h: p.swap_count_24h,
    buys24h: p.buy_count_24h,
    sells24h: p.sell_count_24h,
    netFlowUsdc: p.net_flow_usdc_24h,
    momentum: p.momentum_score,
    acceleration: p.momentum_acceleration_1h,
    sellRatio: p.sell_count_24h / p.swap_count_24h,
    buyPressure: p.buy_volume_usdc_24h / Math.max(p.sell_volume_usdc_24h, 0.01),
  }));

  // === FRESH LAUNCHES (created in last 24h) ===
  const freshRows = db.prepare(`
    SELECT c.symbol, c.name, c.created_at,
           ca.swap_count_24h, ca.buy_count_24h, ca.sell_count_24h,
           ca.net_flow_usdc_24h
    FROM coins c
    LEFT JOIN coin_analytics ca ON c.address = ca.coin_address
    WHERE c.created_at > datetime('now', '-24 hours')
      AND ca.swap_count_24h > 3
    ORDER BY ca.swap_count_24h DESC
    LIMIT 10
  `).all() as any[];

  const freshLaunches: FreshLaunch[] = freshRows.map(f => {
    const hoursOld = (Date.now() - new Date(f.created_at).getTime()) / 3600000;
    const ratio = f.buy_count_24h / Math.max(f.sell_count_24h, 1);
    let verdict: FreshLaunch["verdict"] = "too-early";
    if (hoursOld < 2) verdict = "too-early";
    else if (ratio > 2) verdict = "pumping";
    else if (ratio < 0.5) verdict = "dumping";
    else verdict = "flatline";
    return {
      symbol: f.symbol,
      name: f.name,
      createdAt: f.created_at,
      hoursOld: Math.round(hoursOld),
      swaps: f.swap_count_24h,
      buySellRatio: ratio,
      netFlow: f.net_flow_usdc_24h || 0,
      verdict,
    };
  });

  // === DEGEN PROFILES ===
  const degenRows = db.prepare(`
    SELECT sender_address,
           count(*) as swaps,
           count(distinct coin_address) as coins,
           sum(case when activity_type='BUY' then 1 else 0 end) as buys,
           sum(case when activity_type='SELL' then 1 else 0 end) as sells
    FROM coin_swaps
    WHERE block_timestamp > datetime('now', '-24 hours')
    GROUP BY sender_address
    HAVING swaps >= 10
    ORDER BY swaps DESC
    LIMIT 15
  `).all() as any[];

  const degenProfiles: DegenProfile[] = degenRows.map(d => {
    let style: DegenProfile["style"] = "flipper";
    if (d.sells === 0) style = "ape";
    else if (d.buys === 0) style = "exit-only";
    else if (d.buys > d.sells * 3) style = "hodler";
    else style = "flipper";
    return {
      address: d.sender_address,
      swaps: d.swaps,
      coins: d.coins,
      buys: d.buys,
      sells: d.sells,
      style,
    };
  });

  // === TIMELINES (hourly activity for top 5 coins) ===
  const topCoinAddrs = db.prepare(`
    SELECT coin_address FROM coin_analytics
    WHERE swap_count_24h >= 20
    ORDER BY swap_count_24h DESC
    LIMIT 5
  `).all() as any[];

  const timelines: CoinTimeline[] = [];
  for (const { coin_address } of topCoinAddrs) {
    const coinInfo = db.prepare(
      "SELECT symbol, name FROM coins WHERE address = ?"
    ).get(coin_address) as any;

    const hourlyRows = db.prepare(`
      SELECT strftime('%Y-%m-%d %H:00', block_timestamp) as hour,
             count(*) as swaps,
             sum(case when activity_type='BUY' then 1 else 0 end) as buys,
             sum(case when activity_type='SELL' then 1 else 0 end) as sells
      FROM coin_swaps
      WHERE coin_address = ?
        AND block_timestamp > datetime('now', '-24 hours')
      GROUP BY hour
      ORDER BY hour ASC
    `).all(coin_address) as any[];

    if (hourlyRows.length < 2) continue;

    const hourly: HourlySlice[] = hourlyRows.map(h => ({
      hour: h.hour,
      swaps: h.swaps,
      buys: h.buys,
      sells: h.sells,
    }));

    // Determine trend
    const firstHalf = hourly.slice(0, Math.floor(hourly.length / 2));
    const secondHalf = hourly.slice(Math.floor(hourly.length / 2));
    const firstAvg = firstHalf.reduce((s, h) => s + h.swaps, 0) / Math.max(firstHalf.length, 1);
    const secondAvg = secondHalf.reduce((s, h) => s + h.swaps, 0) / Math.max(secondHalf.length, 1);

    let trend: CoinTimeline["trend"] = "steady";
    if (secondAvg > firstAvg * 1.5) trend = "accelerating";
    else if (secondAvg < firstAvg * 0.5) trend = "decelerating";
    else if (secondAvg === 0) trend = "dead";

    const peakHourObj = hourly.reduce((max, h) => h.swaps > max.swaps ? h : max, hourly[0]);

    timelines.push({
      symbol: coinInfo?.symbol || "???",
      name: coinInfo?.name || "Unknown",
      hourly,
      trend,
      peakHour: peakHourObj.hour,
      peakSwaps: peakHourObj.swaps,
    });
  }

  // === OVERALL VIBE ===
  const totalBuys = db.prepare(`
    SELECT sum(case when activity_type='BUY' then 1 else 0 end) as buys,
           sum(case when activity_type='SELL' then 1 else 0 end) as sells
    FROM coin_swaps
    WHERE block_timestamp > datetime('now', '-6 hours')
  `).get() as any;

  let overallVibe: MarketContext["overallVibe"] = "crab";
  let vibeReason = "";

  const buyRatio = totalBuys.buys / Math.max(totalBuys.buys + totalBuys.sells, 1);
  if (buyRatio > 0.65) {
    overallVibe = "bullish";
    vibeReason = `${(buyRatio * 100).toFixed(0)}% of last 6h swaps are buys — degens are aping in`;
  } else if (buyRatio < 0.4) {
    overallVibe = "bearish";
    vibeReason = `${((1 - buyRatio) * 100).toFixed(0)}% of last 6h swaps are sells — exit doors are crowded`;
  } else if (activity.swaps < 100) {
    overallVibe = "crab";
    vibeReason = `Only ${activity.swaps} swaps in 24h — the trenches are ghost town quiet`;
  } else {
    overallVibe = "chaos";
    vibeReason = `Buy/sell ratio is ${(buyRatio * 100).toFixed(0)}/${((1 - buyRatio) * 100).toFixed(0)} with ${activity.swaps} swaps — pure noise`;
  }

  db.close();

  return {
    generatedAt: now,
    dataRange: { oldest: range.oldest, newest: range.newest },
    totalActiveCoins: activity.coins,
    totalSwaps24h: activity.swaps,
    biggestDumps,
    biggestPumps,
    freshLaunches,
    degenProfiles,
    timelines,
    overallVibe,
    vibeReason,
  };
}

/**
 * Format MarketContext into a prompt-ready text block for Klawley.
 */
export async function formatCommentaryPrompt(ctx: MarketContext): Promise<string> {
  // Resolve degen profile addresses to Zora handles
  const degenAddresses = ctx.degenProfiles.map(d => d.address);
  const handleMap = degenAddresses.length > 0 ? await resolveHandles(degenAddresses) : new Map<string, string>();

  const lines: string[] = [];

  lines.push(`# 🦞 ZORA TRENCHES REPORT — ${new Date(ctx.generatedAt).toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric", year: "numeric" })}`);
  lines.push("");
  lines.push(`**Market Vibe:** ${ctx.overallVibe.toUpperCase()} — ${ctx.vibeReason}`);
  lines.push(`**Active Coins:** ${ctx.totalActiveCoins} | **Total Swaps (24h):** ${ctx.totalSwaps24h}`);
  lines.push("");

  // Dumps
  if (ctx.biggestDumps.length > 0) {
    lines.push("## 📉 THE DUMPS (RIP to these bags)");
    for (const d of ctx.biggestDumps.slice(0, 5)) {
      const sellPct = (d.sellRatio * 100).toFixed(0);
      lines.push(`- **$${d.symbol}** (${d.name}): ${sellPct}% sells, ${d.swaps24h} swaps, ${d.sells24h} sells vs ${d.buys24h} buys. Net flow: $${d.netFlowUsdc.toFixed(0)}. MC: $${(d.marketCap / 1000).toFixed(1)}k`);
    }
    lines.push("");
  }

  // Pumps
  if (ctx.biggestPumps.length > 0) {
    lines.push("## 📈 THE PUMPS (degens eating good tonight)");
    for (const p of ctx.biggestPumps.slice(0, 5)) {
      const buyPct = ((1 - p.sellRatio) * 100).toFixed(0);
      lines.push(`- **$${p.symbol}** (${p.name}): ${buyPct}% buys, ${p.swaps24h} swaps, ${p.buys24h} buys vs ${p.sells24h} sells. Net flow: +$${p.netFlowUsdc.toFixed(0)}. MC: $${(p.marketCap / 1000).toFixed(1)}k. Accel: ${p.acceleration.toFixed(2)}`);
    }
    lines.push("");
  }

  // Fresh launches
  if (ctx.freshLaunches.length > 0) {
    lines.push("## 🆕 FRESH LAUNCHES (born today, prognosis unclear)");
    for (const f of ctx.freshLaunches.slice(0, 5)) {
      const emoji = f.verdict === "pumping" ? "🚀" : f.verdict === "dumping" ? "💀" : f.verdict === "flatline" ? "📊" : "👶";
      lines.push(`- ${emoji} **$${f.symbol}** (${f.name}): ${f.hoursOld}h old, ${f.swaps} swaps, buy/sell ratio ${f.buySellRatio.toFixed(1)}x → ${f.verdict}`);
    }
    lines.push("");
  }

  // Timelines
  if (ctx.timelines.length > 0) {
    lines.push("## ⏱️ HOURLY ACTIVITY (top coins, last 24h)");
    for (const t of ctx.timelines) {
      const sparkline = t.hourly.map(h => {
        if (h.swaps === 0) return "·";
        if (h.swaps <= 3) return "▁";
        if (h.swaps <= 6) return "▃";
        if (h.swaps <= 10) return "▅";
        return "█";
      }).join("");
      lines.push(`- **$${t.symbol}**: ${sparkline} | trend: ${t.trend} | peak: ${t.peakSwaps} swaps at ${t.peakHour}`);
    }
    lines.push("");
  }

  // Degen profiles
  if (ctx.degenProfiles.length > 0) {
    lines.push("## 🎰 TOP DEGENS (the usual suspects)");
    for (const d of ctx.degenProfiles.slice(0, 5)) {
      const handle = handleMap.get(d.address.toLowerCase());
      const label = handle ? `@${handle} (${d.address.slice(0, 6)}…)` : `${d.address.slice(0, 8)}...${d.address.slice(-4)}`;
      lines.push(`- **${label}**: ${d.swaps} swaps across ${d.coins} coins (${d.buys}B/${d.sells}S) — style: ${d.style}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

/**
 * Resolve wallet addresses to Zora profile handles.
 * Returns a Map<address, handle>. Silently skips failures.
 */
async function resolveHandles(addresses: string[]): Promise<Map<string, string>> {
  const { getProfile } = await import("@zoralabs/coins-sdk") as any;
  const handles = new Map<string, string>();
  
  // Limit to 10 lookups to avoid rate limits
  const unique = [...new Set(addresses)].slice(0, 10);
  
  await Promise.allSettled(
    unique.map(async (addr) => {
      try {
        const res = await getProfile({ identifier: addr });
        const profile = res?.data?.profile;
        const handle = profile?.handle || profile?.username || profile?.displayName;
        if (handle) handles.set(addr.toLowerCase(), handle);
      } catch { /* skip */ }
    })
  );
  
  return handles;
}

/**
 * Extract unique trader addresses from alert contexts.
 * Looks at the underlying swap data in the DB for the alerted coins.
 */
function getTopTraderAddresses(alertContexts: AlertContext[], dbPath?: string): string[] {
  try {
    const db = new Database(dbPath || DEFAULT_DB, { readonly: true });
    const coinAddresses = alertContexts
      .map(a => (a as any).coinAddress || "")
      .filter(Boolean);
    
    if (coinAddresses.length === 0) return [];
    
    const placeholders = coinAddresses.map(() => "?").join(",");
    const rows = db.prepare(`
      SELECT sender_address, COUNT(*) as txns
      FROM coin_swaps
      WHERE coin_address IN (${placeholders})
        AND block_timestamp > datetime('now', '-24 hours')
      GROUP BY sender_address
      HAVING txns >= 3
      ORDER BY txns DESC
      LIMIT 10
    `).all(...coinAddresses) as any[];
    
    db.close();
    return rows.map(r => r.sender_address);
  } catch {
    return [];
  }
}

interface AlertContext {
  symbol: string;
  name: string;
  marketCap: number;
  trend: string;
  severity: string;
  type: string;
  message: string;
  coinAddress?: string;
}

/**
 * Generate a short LLM commentary for a batch of alert contexts.
 * Uses OpenAI gpt-4o-mini. Non-blocking — returns empty string on failure.
 */
export async function generateBatchCommentary(alertContexts: unknown[]): Promise<string> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey || alertContexts.length === 0) return "";

  const contexts = alertContexts as AlertContext[];

  // Resolve trader handles in parallel with prompt building
  let handleMap = new Map<string, string>();
  try {
    // Get coin addresses from contexts
    const coinAddrs = contexts.map(c => c.coinAddress).filter(Boolean) as string[];
    
    // Also try to resolve coin creator addresses
    const traderAddrs = getTopTraderAddresses(contexts);
    const allAddrs = [...new Set([...traderAddrs, ...coinAddrs])];
    
    if (allAddrs.length > 0) {
      handleMap = await resolveHandles(allAddrs);
    }
  } catch { /* non-blocking */ }

  // Build handle context for the LLM
  const handleContext = handleMap.size > 0
    ? `\n\nKnown Zora handles (use @handle when mentioning these traders):\n${
        [...handleMap.entries()].map(([addr, handle]) => `- ${addr.slice(0, 10)}... → @${handle}`).join("\n")
      }`
    : "";

  const alertSummary = contexts.map(c => {
    return `${c.symbol} (${c.name}): ${c.type}, ${c.severity}, mcap $${c.marketCap.toFixed(0)}, trend ${c.trend}. ${c.message}`;
  }).join("\n");

  const systemPrompt = `You are Klawley, a sarcastic crypto-trading lobster bot. Generate ONE short, witty commentary line (max 200 chars) about this batch of Zora coin alerts. Be dry, funny, market-aware. No emoji. No hashtags. If you recognize any trader handles from the context below, call them out with @handle format.${handleContext}`;

  try {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: "gpt-5.2",
        max_completion_tokens: 100,
        temperature: 0.9,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: alertSummary },
        ],
      }),
    });

    if (!res.ok) return "";
    const json = await res.json() as any;
    return (json.choices?.[0]?.message?.content || "").trim();
  } catch {
    return "";
  }
}

// CLI entry point
if (import.meta.url === `file://${process.argv[1]}`) {
  (async () => {
    const ctx = generateMarketContext();
    const prompt = await formatCommentaryPrompt(ctx);
    console.log(prompt);
    console.log("\n---\n");
    console.log(JSON.stringify(ctx, null, 2));
  })();
}
