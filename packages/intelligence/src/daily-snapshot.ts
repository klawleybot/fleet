/**
 * Daily Snapshot — Historical market context compaction
 *
 * Saves a compacted daily snapshot after each commentary run.
 * Enables multi-day trend analysis: meta rotations, trader consistency,
 * coin lifecycle tracking.
 *
 * Schema: daily_snapshots table with JSON-compacted market state per day.
 * Retention: configurable, default 14 days.
 */

import Database from "better-sqlite3";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_DB = resolve(__dirname, "../.data/zora-intelligence.db");
const DEFAULT_RETENTION_DAYS = 14;
const WEEKLY_RETENTION_DAYS = 90;

export interface WeeklySnapshot {
  weekStart: string; // ISO date of Monday
  weekEnd: string;   // ISO date of Sunday
  daysIncluded: number;
  avgVibe: string;
  vibeDistribution: Record<string, number>; // e.g. {"bullish": 3, "neutral": 2, "bearish": 2}
  totalSwaps: number;
  topCoins: Array<{ symbol: string; appearances: number }>; // top 10
  topThemes: Array<{ theme: string; appearances: number }>; // top 10
  topTraders: Array<{ address: string; appearances: number }>; // top 10
}

export interface DailySnapshot {
  date: string; // YYYY-MM-DD
  overallVibe: string;
  totalSwaps: number;
  totalActiveCoins: number;

  // Top themes/metas (coin name patterns, not raw addresses)
  topThemes: string[]; // e.g. ["oil reserves", "pixel art", "political"]

  // Top 10 coins by activity — compacted
  topCoins: {
    symbol: string;
    name: string;
    address: string;
    swaps: number;
    buyRatio: number; // 0-1
    trend: string; // accelerating/decelerating/steady/dead
    marketCap: number;
  }[];

  // Top 10 traders — compacted
  topTraders: {
    handle: string;
    address: string;
    swaps: number;
    style: string;
    topCoin: string; // symbol of their most-traded coin
  }[];

  // Fresh launches that day
  freshLaunches: {
    symbol: string;
    name: string;
    swaps: number;
    verdict: string;
  }[];
}

/**
 * Ensure the daily_snapshots table exists.
 */
function ensureTable(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS daily_snapshots (
      date TEXT PRIMARY KEY,
      snapshot_json TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    )
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS weekly_snapshots (
      week_start TEXT PRIMARY KEY,
      snapshot_json TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    )
  `);
}

/**
 * Get the Monday of the week containing the given date.
 */
function getMonday(dateStr: string): string {
  const d = new Date(dateStr + "T00:00:00Z");
  const day = d.getUTCDay(); // 0=Sun, 1=Mon, ...
  const diff = day === 0 ? 6 : day - 1; // days since Monday
  d.setUTCDate(d.getUTCDate() - diff);
  return d.toISOString().slice(0, 10);
}

/**
 * Get the Sunday of the week starting at the given Monday.
 */
function getSunday(mondayStr: string): string {
  const d = new Date(mondayStr + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + 6);
  return d.toISOString().slice(0, 10);
}

/**
 * Compact daily snapshots into weekly rollups.
 * Idempotent: only creates rollups for complete weeks (Mon-Sun)
 * where all 7 dailies exist and no weekly rollup exists yet.
 */
export function compactWeeklySnapshots(dbPath?: string): number {
  const db = new Database(dbPath || DEFAULT_DB);
  ensureTable(db);

  // Find all daily snapshot dates
  const dailyRows = db.prepare(`
    SELECT date, snapshot_json FROM daily_snapshots ORDER BY date ASC
  `).all() as Array<{ date: string; snapshot_json: string }>;

  if (dailyRows.length === 0) {
    db.close();
    return 0;
  }

  // Group dailies by their week (Monday)
  const weekMap = new Map<string, DailySnapshot[]>();
  for (const row of dailyRows) {
    const monday = getMonday(row.date);
    if (!weekMap.has(monday)) weekMap.set(monday, []);
    weekMap.get(monday)!.push(JSON.parse(row.snapshot_json));
  }

  // Check which weekly rollups already exist
  const existingWeeks = new Set(
    (db.prepare(`SELECT week_start FROM weekly_snapshots`).all() as Array<{ week_start: string }>)
      .map(r => r.week_start)
  );

  const insertStmt = db.prepare(`
    INSERT OR IGNORE INTO weekly_snapshots (week_start, snapshot_json, created_at)
    VALUES (?, ?, datetime('now'))
  `);

  let created = 0;

  for (const [monday, dailies] of weekMap) {
    // Only compact complete weeks (7 days) that don't already have a rollup
    if (dailies.length < 7 || existingWeeks.has(monday)) continue;

    const sunday = getSunday(monday);

    // Vibe distribution and average
    const vibeDist: Record<string, number> = {};
    for (const d of dailies) {
      vibeDist[d.overallVibe] = (vibeDist[d.overallVibe] || 0) + 1;
    }
    // Average vibe = the most common one
    const sortedVibes = Object.entries(vibeDist).sort((a, b) => b[1] - a[1]);
    const avgVibe = sortedVibes[0]?.[0] ?? "neutral";

    // Total swaps
    const totalSwaps = dailies.reduce((sum, d) => sum + d.totalSwaps, 0);

    // Top coins by frequency of appearance across days
    const coinCounts = new Map<string, number>();
    for (const d of dailies) {
      for (const c of d.topCoins) {
        coinCounts.set(c.symbol, (coinCounts.get(c.symbol) || 0) + 1);
      }
    }
    const topCoins = [...coinCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([symbol, appearances]) => ({ symbol, appearances }));

    // Top themes by frequency
    const themeCounts = new Map<string, number>();
    for (const d of dailies) {
      for (const t of d.topThemes) {
        themeCounts.set(t, (themeCounts.get(t) || 0) + 1);
      }
    }
    const topThemes = [...themeCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([theme, appearances]) => ({ theme, appearances }));

    // Top traders by frequency
    const traderCounts = new Map<string, number>();
    for (const d of dailies) {
      for (const t of d.topTraders) {
        traderCounts.set(t.address, (traderCounts.get(t.address) || 0) + 1);
      }
    }
    const topTraders = [...traderCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([address, appearances]) => ({ address, appearances }));

    const weekly: WeeklySnapshot = {
      weekStart: monday,
      weekEnd: sunday,
      daysIncluded: dailies.length,
      avgVibe,
      vibeDistribution: vibeDist,
      totalSwaps,
      topCoins,
      topThemes,
      topTraders,
    };

    insertStmt.run(monday, JSON.stringify(weekly));
    created++;
  }

  // Prune old weekly snapshots (keep last 90 days)
  const weeklyCutoff = new Date(Date.now() - WEEKLY_RETENTION_DAYS * 86400_000).toISOString().slice(0, 10);
  db.prepare(`DELETE FROM weekly_snapshots WHERE week_start < ?`).run(weeklyCutoff);

  db.close();
  return created;
}

/**
 * Load recent weekly snapshots (most recent first).
 */
export function loadWeeklySnapshots(weeks: number = 12, dbPath?: string): WeeklySnapshot[] {
  const db = new Database(dbPath || DEFAULT_DB, { readonly: true });
  ensureTable(db);

  const rows = db.prepare(`
    SELECT snapshot_json FROM weekly_snapshots
    ORDER BY week_start DESC
    LIMIT ?
  `).all(weeks) as Array<{ snapshot_json: string }>;

  db.close();
  return rows.map(r => JSON.parse(r.snapshot_json));
}

/**
 * Save today's snapshot. Overwrites if already exists for today.
 */
export function saveDailySnapshot(dbPath?: string): DailySnapshot {
  const db = new Database(dbPath || DEFAULT_DB);
  ensureTable(db);

  const today = new Date().toISOString().slice(0, 10);
  const todayStart = `${today} 00:00:00`;
  const todayEnd = `${today} 23:59:59`;

  // Total activity — use range query instead of date() for performance on large DBs
  const activity = db.prepare(`
    SELECT count(*) as swaps, count(distinct coin_address) as coins
    FROM coin_swaps
    WHERE block_timestamp >= ? AND block_timestamp <= ?
  `).get(todayStart, todayEnd) as any;

  // Overall vibe (buy ratio for the day)
  const vibeData = db.prepare(`
    SELECT
      sum(case when activity_type='BUY' then 1 else 0 end) as buys,
      sum(case when activity_type='SELL' then 1 else 0 end) as sells
    FROM coin_swaps
    WHERE block_timestamp >= ? AND block_timestamp <= ?
  `).get(todayStart, todayEnd) as any;

  const buyRatio = vibeData.buys / Math.max(vibeData.buys + vibeData.sells, 1);
  let vibe = "crab";
  if (buyRatio > 0.6) vibe = "bullish";
  else if (buyRatio < 0.4) vibe = "bearish";
  else if (activity.swaps > 500) vibe = "chaos";

  // Top coins — use pre-aggregated coin_analytics (fast, no full scan)
  const topCoinsRows = db.prepare(`
    SELECT c.symbol, c.name, c.address, c.market_cap,
           ca.swap_count_24h as swaps,
           ca.buy_count_24h as buys,
           ca.sell_count_24h as sells,
           ca.momentum_acceleration_1h as acceleration
    FROM coin_analytics ca
    JOIN coins c ON c.address = ca.coin_address
    WHERE ca.swap_count_24h >= 5
    ORDER BY ca.swap_count_24h DESC
    LIMIT 10
  `).all() as any[];

  const topCoins = topCoinsRows.map(r => {
    const total = r.buys + r.sells;
    const br = r.buys / Math.max(total, 1);
    let trend = "steady";
    if ((r.acceleration ?? 0) >= 2 || br > 0.7) trend = "accelerating";
    else if ((r.acceleration ?? 0) <= -1 || br < 0.35) trend = "decelerating";
    return {
      symbol: r.symbol,
      name: r.name,
      address: r.address,
      swaps: r.swaps,
      buyRatio: Math.round(br * 100) / 100,
      trend,
      marketCap: r.market_cap || 0,
    };
  });

  // Top traders today
  const topTradersRows = db.prepare(`
    SELECT cs.sender_address,
           a.last_profile_handle as handle,
           count(*) as swaps,
           sum(case when cs.activity_type='BUY' then 1 else 0 end) as buys,
           sum(case when cs.activity_type='SELL' then 1 else 0 end) as sells
    FROM coin_swaps cs
    LEFT JOIN addresses a ON cs.sender_address = a.address
    WHERE cs.block_timestamp >= ? AND cs.block_timestamp <= ?
    GROUP BY cs.sender_address
    HAVING swaps >= 5
    ORDER BY swaps DESC
    LIMIT 10
  `).all(todayStart, todayEnd) as any[];

  // Get top coin per trader
  const topCoinStmt = db.prepare(`
    SELECT c.symbol, count(*) as cnt
    FROM coin_swaps cs
    JOIN coins c ON c.address = cs.coin_address
    WHERE cs.sender_address = ? AND cs.block_timestamp >= ? AND cs.block_timestamp <= ?
    GROUP BY cs.coin_address
    ORDER BY cnt DESC
    LIMIT 1
  `);

  const topTraders = topTradersRows.map(r => {
    let style = "flipper";
    if (r.sells === 0) style = "ape";
    else if (r.buys === 0) style = "exit-only";
    else if (r.buys > r.sells * 3) style = "hodler";

    const topCoinRow = topCoinStmt.get(r.sender_address, todayStart, todayEnd) as any;
    const handle = r.handle && !r.handle.startsWith("0x")
      ? r.handle
      : r.sender_address.slice(0, 6) + "..." + r.sender_address.slice(-4);

    return {
      handle,
      address: r.sender_address,
      swaps: r.swaps,
      style,
      topCoin: topCoinRow?.symbol || "???",
    };
  });

  // Fresh launches today — INNER JOIN so the timestamp index on coin_swaps is used
  const freshRows = db.prepare(`
    SELECT c.symbol, c.name,
           count(cs.id) as swaps,
           sum(case when cs.activity_type='BUY' then 1 else 0 end) as buys,
           sum(case when cs.activity_type='SELL' then 1 else 0 end) as sells
    FROM coins c
    JOIN coin_swaps cs ON c.address = cs.coin_address
    WHERE cs.block_timestamp >= ? AND cs.block_timestamp <= ?
      AND c.created_at >= ? AND c.created_at <= ?
    GROUP BY c.address
    HAVING swaps > 3
    ORDER BY swaps DESC
    LIMIT 10
  `).all(todayStart, todayEnd, todayStart, todayEnd) as any[];

  const freshLaunches = freshRows.map(f => {
    const ratio = f.buys / Math.max(f.sells, 1);
    let verdict = "too-early";
    if (ratio > 2) verdict = "pumping";
    else if (ratio < 0.5) verdict = "dumping";
    else verdict = "flatline";
    return { symbol: f.symbol, name: f.name, swaps: f.swaps, verdict };
  });

  // Detect themes from coin names
  const allNames = topCoinsRows.map(r => `${r.symbol} ${r.name}`.toLowerCase());
  const themes: string[] = [];
  const themePatterns: [RegExp, string][] = [
    [/oil|petro|crude|opec|reserve/i, "oil/reserves"],
    [/trump|maga|politi|president|elect/i, "political"],
    [/8bit|pixel|retro|pengu/i, "pixel art/retro"],
    [/ai|gpt|neural|bot/i, "AI/tech"],
    [/meme|pepe|doge|shib|frog/i, "meme animals"],
    [/eagle|flag|patriot|usa|usd/i, "patriotic/USD"],
    [/dome|shield|defense/i, "defense/military"],
  ];
  for (const [pattern, label] of themePatterns) {
    if (allNames.some(n => pattern.test(n))) themes.push(label);
  }

  const snapshot: DailySnapshot = {
    date: today,
    overallVibe: vibe,
    totalSwaps: activity.swaps,
    totalActiveCoins: activity.coins,
    topThemes: themes,
    topCoins,
    topTraders,
    freshLaunches,
  };

  // Upsert
  db.prepare(`
    INSERT OR REPLACE INTO daily_snapshots (date, snapshot_json, created_at)
    VALUES (?, ?, datetime('now'))
  `).run(today, JSON.stringify(snapshot));

  // Prune old snapshots (keep last N days)
  const cutoff = new Date(Date.now() - DEFAULT_RETENTION_DAYS * 86400_000).toISOString().slice(0, 10);
  db.prepare(`DELETE FROM daily_snapshots WHERE date < ?`).run(cutoff);

  db.close();

  // Compact completed weeks into weekly rollups (idempotent)
  compactWeeklySnapshots(dbPath);

  return snapshot;
}

/**
 * Load recent daily snapshots (most recent first).
 */
export function loadRecentSnapshots(days: number = 7, dbPath?: string): DailySnapshot[] {
  const db = new Database(dbPath || DEFAULT_DB, { readonly: true });
  ensureTable(db);

  const cutoff = new Date(Date.now() - days * 86400_000).toISOString().slice(0, 10);
  const rows = db.prepare(`
    SELECT snapshot_json FROM daily_snapshots
    WHERE date >= ?
    ORDER BY date DESC
  `).all(cutoff) as any[];

  db.close();
  return rows.map(r => JSON.parse(r.snapshot_json));
}

/**
 * Format a date as "Mon DD" (e.g. "Mar 13").
 */
function formatShortDate(dateStr: string): string {
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const d = new Date(dateStr + "T00:00:00Z");
  return `${months[d.getUTCMonth()]} ${d.getUTCDate()}`;
}

/**
 * Classify a coin's persistence relative to the snapshot window.
 */
function classifyCoinPersistence(appearances: number, totalDays: number): string {
  const ratio = appearances / totalDays;
  if (ratio >= 0.7) return "persistent";
  if (ratio >= 0.4) return "recurring";
  return "new this week";
}

function classifyWeeklyPersistence(appearances: number, totalWeeks: number): string {
  const ratio = appearances / totalWeeks;
  if (ratio >= 0.8) return "every week";
  if (ratio >= 0.5) return "most weeks";
  return "occasional";
}

/**
 * Generate a multi-day trend summary for use in commentary.
 * Returns human-readable lines about what's changed.
 * Includes both daily detail (last 7 days) and weekly rollups (up to 12 weeks).
 */
export function generateTrendContext(days: number = 7, dbPath?: string): string {
  const snapshots = loadRecentSnapshots(days, dbPath);
  if (snapshots.length < 2) return ""; // Need at least 2 days for trends

  const lines: string[] = [];

  // Date range header instead of "last N days"
  const newestDate = snapshots[0]?.date;
  const oldestDate = snapshots.at(-1)?.date;
  if (!newestDate || !oldestDate) return "";
  lines.push(`## 📊 MULTI-DAY TRENDS (${formatShortDate(oldestDate)} – ${formatShortDate(newestDate)})`);
  lines.push("");

  // Vibe trajectory — collapse consecutive same-vibes into descriptive spans
  const vibes = [...snapshots.map(s => s.overallVibe)].reverse(); // oldest-first
  const vibeSpans: string[] = [];
  let runStart = 0;
  for (let i = 1; i <= vibes.length; i++) {
    if (i === vibes.length || vibes[i] !== vibes[runStart]) {
      const runLen = i - runStart;
      if (runLen === 1) {
        vibeSpans.push(vibes[runStart]!);
      } else if (runLen === vibes.length) {
        vibeSpans.push(`${vibes[runStart]} the entire window`);
      } else if (runLen >= 5) {
        vibeSpans.push(`${vibes[runStart]} (persistent streak)`);
      } else if (runLen >= 3) {
        vibeSpans.push(`${vibes[runStart]} (multi-day run)`);
      } else {
        vibeSpans.push(`${vibes[runStart]} (couple days)`);
      }
      runStart = i;
    }
  }
  lines.push(`**Vibe trajectory:** ${vibeSpans.join(" → ")}`);

  // Theme persistence — which themes appear across multiple days
  const themeCounts = new Map<string, number>();
  for (const s of snapshots) {
    for (const t of s.topThemes) {
      themeCounts.set(t, (themeCounts.get(t) || 0) + 1);
    }
  }
  const persistentThemes = [...themeCounts.entries()]
    .filter(([, count]) => count >= 2)
    .sort((a, b) => b[1] - a[1]);
  if (persistentThemes.length > 0) {
    lines.push(`**Persistent metas:** ${persistentThemes.map(([t]) => t).join(", ")}`);
  }

  // New themes today vs yesterday
  const today = snapshots[0]; // most recent (snapshots is newest-first)
  const yesterday = snapshots[1];
  if (today && yesterday) {
    const newThemes = today.topThemes.filter(t => !yesterday.topThemes.includes(t));
    const goneThemes = yesterday.topThemes.filter(t => !today.topThemes.includes(t));
    if (newThemes.length > 0) lines.push(`**New today:** ${newThemes.join(", ")}`);
    if (goneThemes.length > 0) lines.push(`**Rotated out:** ${goneThemes.join(", ")}`);
  }

  // Coin persistence — coins in top 10 for multiple days (descriptive labels)
  const coinDays = new Map<string, number>();
  for (const s of snapshots) {
    for (const c of s.topCoins) {
      coinDays.set(c.symbol, (coinDays.get(c.symbol) || 0) + 1);
    }
  }
  const longRunners = [...coinDays.entries()]
    .filter(([, d]) => d >= 3)
    .sort((a, b) => b[1] - a[1]);
  if (longRunners.length > 0) {
    lines.push(`**Multi-day runners:** ${longRunners.map(([s, d]) => `$${s} (${classifyCoinPersistence(d, snapshots.length)})`).join(", ")}`);
  }

  // Trader consistency — traders in top 10 for multiple days
  const traderDays = new Map<string, number>();
  for (const s of snapshots) {
    for (const t of s.topTraders) {
      traderDays.set(t.handle, (traderDays.get(t.handle) || 0) + 1);
    }
  }
  const regulars = [...traderDays.entries()]
    .filter(([h, d]) => d >= 2 && !h.startsWith("0x"))
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5);
  if (regulars.length > 0) {
    lines.push(`**Regulars:** ${regulars.map(([h]) => `@${h}`).join(", ")}`);
  }

  // Activity trend
  const swapTrend = snapshots.map(s => s.totalSwaps);
  if (swapTrend.length >= 3) {
    const recent = swapTrend.slice(0, 2).reduce((a, b) => a + b, 0) / 2;
    const older = swapTrend.slice(-2).reduce((a, b) => a + b, 0) / 2;
    if (recent > older * 1.3) lines.push("**Activity:** trending UP over recent days");
    else if (recent < older * 0.7) lines.push("**Activity:** cooling off");
    else lines.push("**Activity:** steady");
  }

  lines.push("");

  // --- LONGER-RANGE TRAJECTORY from weekly rollups ---
  const weeklies = loadWeeklySnapshots(12, dbPath);
  if (weeklies.length >= 2) {
    lines.push(`## 📈 LONGER-RANGE TRAJECTORY`);
    lines.push("");

    // Vibe arc — week-over-week, collapse consecutive same-vibes
    const weeklyVibes = [...weeklies].reverse();
    const weekSpans: string[] = [];
    let wStart = 0;
    for (let wi = 1; wi <= weeklyVibes.length; wi++) {
      if (wi === weeklyVibes.length || weeklyVibes[wi]!.avgVibe !== weeklyVibes[wStart]!.avgVibe) {
        const span = wi - wStart;
        const durLabel = span >= weeklyVibes.length ? "entire range" : span >= 4 ? "extended run" : "multi-week";
        const label = span > 1
          ? `${weeklyVibes[wStart]!.avgVibe} (${durLabel}, ${formatShortDate(weeklyVibes[wStart]!.weekStart)}–${formatShortDate(weeklyVibes[wi - 1]!.weekStart)})`
          : `${formatShortDate(weeklyVibes[wStart]!.weekStart)}: ${weeklyVibes[wStart]!.avgVibe}`;
        weekSpans.push(label);
        wStart = wi;
      }
    }
    lines.push(`**Vibe arc:** ${weekSpans.join(" → ")}`);

    // Activity trend across weeks
    const weeklySwaps = [...weeklies].reverse().map(w => w.totalSwaps);
    const recentWeeks = weeklySwaps.slice(-2).reduce((a, b) => a + b, 0) / 2;
    const olderWeeks = weeklySwaps.slice(0, 2).reduce((a, b) => a + b, 0) / 2;
    if (olderWeeks > 0) {
      const change = ((recentWeeks - olderWeeks) / olderWeeks * 100).toFixed(0);
      const direction = recentWeeks > olderWeeks * 1.2 ? "📈 up" : recentWeeks < olderWeeks * 0.8 ? "📉 down" : "➡️ flat";
      lines.push(`**Weekly activity:** ${direction} (${change}% from earliest to latest weeks)`);
    }

    // Persistent themes across weeks (appear in 3+ weeks)
    const weeklyThemeCounts = new Map<string, number>();
    for (const w of weeklies) {
      for (const t of w.topThemes) {
        weeklyThemeCounts.set(t.theme, (weeklyThemeCounts.get(t.theme) || 0) + 1);
      }
    }
    const longThemes = [...weeklyThemeCounts.entries()]
      .filter(([, count]) => count >= 3)
      .sort((a, b) => b[1] - a[1]);
    if (longThemes.length > 0) {
      lines.push(`**Long-running themes:** ${longThemes.map(([t, c]) => `${t} (${classifyWeeklyPersistence(c, weeklies.length)})`).join(", ")}`);
    }

    // Long-running coins across weeks (appear in 3+ weeks)
    const weeklyCoinCounts = new Map<string, number>();
    for (const w of weeklies) {
      for (const c of w.topCoins) {
        weeklyCoinCounts.set(c.symbol, (weeklyCoinCounts.get(c.symbol) || 0) + 1);
      }
    }
    const longCoins = [...weeklyCoinCounts.entries()]
      .filter(([, count]) => count >= 3)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10);
    if (longCoins.length > 0) {
      lines.push(`**Long-running coins:** ${longCoins.map(([s, c]) => `$${s} (${classifyWeeklyPersistence(c, weeklies.length)})`).join(", ")}`);
    }

    lines.push("");
  }

  return lines.join("\n");
}

// CLI entry point
if (import.meta.url === `file://${process.argv[1]}`) {
  const cmd = process.argv[2];

  if (cmd === "save") {
    const snapshot = saveDailySnapshot();
    console.log(`✅ Saved snapshot for ${snapshot.date}`);
    console.log(`   Vibe: ${snapshot.overallVibe}`);
    console.log(`   Swaps: ${snapshot.totalSwaps}`);
    console.log(`   Themes: ${snapshot.topThemes.join(", ") || "none detected"}`);
    console.log(`   Top coins: ${snapshot.topCoins.map(c => c.symbol).join(", ")}`);
  } else if (cmd === "trends") {
    const days = parseInt(process.argv[3] || "7");
    const ctx = generateTrendContext(days);
    console.log(ctx || "Not enough data for trends (need at least 2 days of snapshots).");
  } else if (cmd === "list") {
    const snapshots = loadRecentSnapshots(14);
    for (const s of snapshots) {
      console.log(`${s.date}: ${s.overallVibe} | ${s.totalSwaps} swaps | ${s.totalActiveCoins} coins | themes: ${s.topThemes.join(", ")}`);
    }
  } else if (cmd === "compact") {
    const created = compactWeeklySnapshots();
    console.log(`✅ Weekly compaction: ${created} new rollup(s) created`);
  } else if (cmd === "weekly") {
    const weeks = parseInt(process.argv[3] || "12");
    const weeklies = loadWeeklySnapshots(weeks);
    for (const w of weeklies) {
      console.log(`${w.weekStart} – ${w.weekEnd}: ${w.avgVibe} | ${w.totalSwaps} swaps | ${w.daysIncluded}d | themes: ${w.topThemes.map(t => t.theme).join(", ")}`);
    }
  } else {
    console.log("Usage: daily-snapshot.ts <save|trends|list|compact|weekly> [days|weeks]");
    console.log("  save    — Save today's snapshot");
    console.log("  trends  — Show multi-day trend context");
    console.log("  list    — List all stored snapshots");
    console.log("  compact — Run weekly compaction manually");
    console.log("  weekly  — List weekly rollups");
  }
}
