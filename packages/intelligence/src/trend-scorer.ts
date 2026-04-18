/**
 * Trend Scorer — evaluates trend coins for content pairing
 *
 * Scores based on: volume velocity, holder growth, mcap momentum, freshness.
 * Filters junk. Enforces cooldowns. Outputs ranked candidates.
 */

import Database from "better-sqlite3";

// ============================================================
// Types
// ============================================================

export interface TrendCandidate {
  address: string;
  symbol: string;
  marketCap: number;
  volume24h: number;
  uniqueHolders: number;
  createdAt: string;
  ageHours: number;
  score: number;
  scoreBreakdown: {
    volumeScore: number;
    holderScore: number;
    mcapScore: number;
    freshnessBonus: number;
    momentumBonus: number;
  };
}

export interface ScorerConfig {
  /** Minimum 24h volume in USD to qualify */
  minVolume24h: number;
  /** Minimum unique holders */
  minHolders: number;
  /** Minimum market cap */
  minMarketCap: number;
  /** Cooldown hours — don't re-target a trend we already posted to */
  cooldownHours: number;
  /** Max candidates to return */
  maxCandidates: number;
  /** Blacklisted symbols (lowercase) */
  blacklist: Set<string>;
}

interface TrendPostUpdateValues {
  id: number;
  content_coin_address?: string;
  status?: string;
  deployed_at?: string;
  image_url?: string;
  commentary?: string;
  name?: string;
  symbol?: string;
  discord_message_id?: string;
}

interface PendingTrendPostRow {
  id: number;
  trend_address: string;
  trend_symbol: string;
  name: string | null;
  symbol: string | null;
  image_url: string | null;
  commentary: string | null;
  score: number | null;
  created_at: string;
}

interface DueForSellRow {
  id: number;
  content_coin_address: string;
  trend_symbol: string;
  deployed_at: string;
}

interface DueForSellSoonRow extends DueForSellRow {
  sell_after: string;
}

const DEFAULT_CONFIG: ScorerConfig = {
  minVolume24h: 500,
  minHolders: 2,
  minMarketCap: 2500,
  cooldownHours: 6,
  maxCandidates: 10,
  blacklist: new Set([
    // Slurs, offensive
    "nigger", "nigga", "faggot", "retard", "kike",
    // Scam-adjacent
    "scam", "scame", "rug", "rugpull",
    // Testing
    "test", "testing", "asdfa", "fjfjfjrirnfncnc", "march11asdfa",
  ]),
};

// ============================================================
// Scorer
// ============================================================

export class TrendScorer {
  private db: Database.Database;
  private cfg: ScorerConfig;

  constructor(db: Database.Database, config?: Partial<ScorerConfig>) {
    this.db = db;
    this.cfg = { ...DEFAULT_CONFIG, ...config };
    if (config?.blacklist) {
      // Merge with defaults
      this.cfg.blacklist = new Set([...DEFAULT_CONFIG.blacklist, ...config.blacklist]);
    }
    this.ensureTable();
  }

  /** Feature launch date — used for tapering daily limits */
  static readonly LAUNCH_DATE = new Date("2026-03-12T00:00:00Z");

  private ensureTable(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS trend_posts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        trend_address TEXT NOT NULL,
        trend_symbol TEXT NOT NULL,
        content_coin_address TEXT,
        name TEXT,
        symbol TEXT,
        image_url TEXT,
        commentary TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        score REAL,
        created_at TEXT NOT NULL,
        deployed_at TEXT,
        sell_after TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_trend_posts_trend ON trend_posts(trend_address);
      CREATE INDEX IF NOT EXISTS idx_trend_posts_status ON trend_posts(status);
    `);
    // Add discord_message_id column if missing (for approval tracking)
    try {
      this.db.exec(`ALTER TABLE trend_posts ADD COLUMN discord_message_id TEXT`);
    } catch {
      // Column already exists
    }
  }

  /**
   * Get the daily post limit based on tapering schedule.
   * Day 1: 12, Day 2: 8, Day 3: 5, Day 4-7: 3, Week 2+: 2
   */
  getDailyLimit(): number {
    const daysSinceLaunch = Math.floor(
      (Date.now() - TrendScorer.LAUNCH_DATE.getTime()) / 86400000
    );
    if (daysSinceLaunch <= 0) return 12;
    if (daysSinceLaunch === 1) return 8;
    if (daysSinceLaunch === 2) return 5;
    if (daysSinceLaunch <= 6) return 3;
    return 2;
  }

  /**
   * Check if we can still post today (respects tapering).
   */
  canPostToday(): boolean {
    return this.todayPostCount() < this.getDailyLimit();
  }

  /**
   * Score and rank trend coins, returning top candidates.
   */
  getCandidates(): TrendCandidate[] {
    const now = Date.now();

    // Get all trend coins meeting minimum thresholds
    const rows = this.db.prepare(`
      SELECT address, symbol, market_cap, volume_24h, unique_holders, created_at
      FROM trend_coins
      WHERE volume_24h >= ?
        AND unique_holders >= ?
        AND market_cap >= ?
    `).all(
      this.cfg.minVolume24h,
      this.cfg.minHolders,
      this.cfg.minMarketCap,
    ) as Array<{
      address: string;
      symbol: string;
      market_cap: number;
      volume_24h: number;
      unique_holders: number;
      created_at: string;
    }>;

    const candidates: TrendCandidate[] = [];

    for (const row of rows) {
      // Blacklist check
      if (this.cfg.blacklist.has(row.symbol.toLowerCase())) continue;

      // Cooldown check — have we already posted to this trend recently?
      const recent = this.db.prepare(`
        SELECT 1 FROM trend_posts
        WHERE trend_address = ?
        AND datetime(created_at) > datetime('now', ?)
      `).get(row.address, `-${this.cfg.cooldownHours} hours`);
      if (recent) continue;

      // Calculate age in hours
      const createdMs = new Date(row.created_at).getTime();
      const ageHours = Math.max(0.1, (now - createdMs) / 3600000);

      // Score components
      const volumeScore = Math.min(40, Math.log10(Math.max(1, row.volume_24h)) * 10);
      const holderScore = Math.min(25, Math.sqrt(row.unique_holders) * 5);
      const mcapScore = Math.min(20, Math.log10(Math.max(1, row.market_cap)) * 5);

      // Freshness bonus — newer coins score higher (decays over 24h)
      const freshnessBonus = Math.max(0, 10 * (1 - ageHours / 24));

      // Momentum bonus — volume relative to mcap (high vol/mcap = active trading)
      const volMcapRatio = row.market_cap > 0 ? row.volume_24h / row.market_cap : 0;
      const momentumBonus = Math.min(5, volMcapRatio * 10);

      const score = volumeScore + holderScore + mcapScore + freshnessBonus + momentumBonus;

      candidates.push({
        address: row.address,
        symbol: row.symbol,
        marketCap: row.market_cap,
        volume24h: row.volume_24h,
        uniqueHolders: row.unique_holders,
        createdAt: row.created_at,
        ageHours,
        score,
        scoreBreakdown: {
          volumeScore,
          holderScore,
          mcapScore,
          freshnessBonus,
          momentumBonus,
        },
      });
    }

    // Sort by score descending
    candidates.sort((a, b) => b.score - a.score);

    return candidates.slice(0, this.cfg.maxCandidates);
  }

  /**
   * Record that we've created (or are planning) a content coin for a trend.
   */
  recordPost(params: {
    trendAddress: string;
    trendSymbol: string;
    name?: string;
    symbol?: string;
    imageUrl?: string;
    commentary?: string;
    score?: number;
    status?: string;
  }): number {
    const now = new Date().toISOString();
    const sellAfter = new Date(Date.now() + 24 * 3600 * 1000).toISOString();

    const result = this.db.prepare(`
      INSERT INTO trend_posts (trend_address, trend_symbol, name, symbol, image_url, commentary, score, status, created_at, sell_after)
      VALUES (@trend_address, @trend_symbol, @name, @symbol, @image_url, @commentary, @score, @status, @created_at, @sell_after)
    `).run({
      trend_address: params.trendAddress,
      trend_symbol: params.trendSymbol,
      name: params.name ?? null,
      symbol: params.symbol ?? null,
      image_url: params.imageUrl ?? null,
      commentary: params.commentary ?? null,
      score: params.score ?? null,
      status: params.status ?? "pending",
      created_at: now,
      sell_after: sellAfter,
    });

    return result.lastInsertRowid as number;
  }

  /**
   * Update a post record (e.g., after deployment).
   */
  updatePost(id: number, updates: {
    contentCoinAddress?: string;
    status?: string;
    deployedAt?: string;
    imageUrl?: string;
    commentary?: string;
    name?: string;
    symbol?: string;
    discordMessageId?: string;
  }): void {
    const sets: string[] = [];
    const values: TrendPostUpdateValues = { id };

    if (updates.contentCoinAddress !== undefined) {
      sets.push("content_coin_address = @content_coin_address");
      values.content_coin_address = updates.contentCoinAddress;
    }
    if (updates.status !== undefined) {
      sets.push("status = @status");
      values.status = updates.status;
    }
    if (updates.deployedAt !== undefined) {
      sets.push("deployed_at = @deployed_at");
      values.deployed_at = updates.deployedAt;
    }
    if (updates.imageUrl !== undefined) {
      sets.push("image_url = @image_url");
      values.image_url = updates.imageUrl;
    }
    if (updates.commentary !== undefined) {
      sets.push("commentary = @commentary");
      values.commentary = updates.commentary;
    }
    if (updates.name !== undefined) {
      sets.push("name = @name");
      values.name = updates.name;
    }
    if (updates.symbol !== undefined) {
      sets.push("symbol = @symbol");
      values.symbol = updates.symbol;
    }

    if (updates.discordMessageId !== undefined) {
      sets.push("discord_message_id = @discord_message_id");
      values.discord_message_id = updates.discordMessageId;
    }

    if (sets.length === 0) return;

    this.db.prepare(`UPDATE trend_posts SET ${sets.join(", ")} WHERE id = @id`).run(values);
  }

  /**
   * Find a pending post by ID or trend symbol.
   */
  findPendingPost(query: string): {
    id: number;
    trend_address: string;
    trend_symbol: string;
    name: string | null;
    symbol: string | null;
    image_url: string | null;
    commentary: string | null;
    score: number | null;
    created_at: string;
  } | null {
    // Try by ID first
    const byId = this.db.prepare(`
      SELECT * FROM trend_posts WHERE id = ? AND status = 'pending'
    `).get(Number.parseInt(query, 10) || -1) as PendingTrendPostRow | undefined;
    if (byId) return byId;

    // Try by trend symbol (case-insensitive)
    const bySym = this.db.prepare(`
      SELECT * FROM trend_posts WHERE status = 'pending'
      AND (LOWER(trend_symbol) = LOWER(?) OR LOWER(symbol) = LOWER(?))
      ORDER BY id DESC LIMIT 1
    `).get(query, query) as PendingTrendPostRow | undefined;
    return bySym ?? null;
  }

  /**
   * Get posts that need selling (24hr+ old, deployed, not yet sold).
   */
  getPostsDueForSell(): Array<{ id: number; content_coin_address: string; trend_symbol: string; deployed_at: string }> {
    return this.db.prepare(`
      SELECT id, content_coin_address, trend_symbol, deployed_at FROM trend_posts
      WHERE content_coin_address IS NOT NULL
      AND (status = 'deployed' OR status = 'partial_sold')
      AND datetime(sell_after) <= datetime('now')
    `).all() as DueForSellRow[];
  }

  /**
   * Preview posts that will become due for sell within the next N minutes.
   * Returns posts where sell_after is between now and now + windowMinutes,
   * excluding posts already due (those are handled by getPostsDueForSell).
   */
  getPostsDueForSellSoon(windowMinutes: number = 30): Array<{
    id: number;
    content_coin_address: string;
    trend_symbol: string;
    deployed_at: string;
    sell_after: string;
  }> {
    return this.db.prepare(`
      SELECT id, content_coin_address, trend_symbol, deployed_at, sell_after FROM trend_posts
      WHERE content_coin_address IS NOT NULL
      AND (status = 'deployed' OR status = 'partial_sold')
      AND datetime(sell_after) > datetime('now')
      AND datetime(sell_after) <= datetime('now', '+${windowMinutes} minutes')
    `).all() as DueForSellSoonRow[];
  }

  /**
   * Get today's post count.
   */
  todayPostCount(): number {
    const row = this.db.prepare(`
      SELECT COUNT(*) as c FROM trend_posts
      WHERE date(created_at) = date('now')
    `).get() as { c: number };
    return row.c;
  }

  /**
   * Get pending posts awaiting review.
   */
  getPendingPosts(): Array<{
    id: number;
    trend_address: string;
    trend_symbol: string;
    name: string | null;
    symbol: string | null;
    image_url: string | null;
    commentary: string | null;
    score: number | null;
    created_at: string;
  }> {
    return this.db.prepare(`
      SELECT id, trend_address, trend_symbol, name, symbol, image_url, commentary, score, created_at
      FROM trend_posts WHERE status = 'pending'
      ORDER BY id DESC
    `).all() as PendingTrendPostRow[];
  }
}
