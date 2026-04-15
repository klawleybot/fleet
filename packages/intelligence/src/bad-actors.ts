import type Database from "better-sqlite3";
import {
  coinHolderEdges,
  coinHolderPageInfo,
  getCoinHolders,
  type ExploreEdge,
  type HolderBalanceNode,
} from "./zora-sdk.js";

export interface BadActor {
  address: string;
  label: string | null;
  reason: string | null;
  severity: string;
  addedAt: string;
}

export interface BadActorHolding {
  actor: BadActor;
  coinAddress: string;
  coinSymbol: string | null;
  coinName: string | null;
  balance: string;
  holdingPct: number;
  estimatedSlippagePct: number;
  estimatedValueUsd: number;
}

type CoinMetadataRow = {
  market_cap: number | null;
  volume_24h: number | null;
  symbol: string | null;
  name: string | null;
};

type FshRow = {
  address: string;
  coin_address: string;
  coin_symbol: string | null;
  sell_amount_usdc: number | null;
  coin_market_cap: number | null;
  liquidity_pct: number | null;
  handle: string | null;
  block_timestamp: string | null;
};

type CachedHoldingRow = {
  actorAddress: string;
  label: string | null;
  severity: string;
  holdingPct: number;
  estimatedSlippagePct: number;
  estimatedValueUsd: number;
};

function messageFromError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function addBadActor(db: Database.Database, address: string, label?: string, reason?: string, severity?: string): void {
  const addr = address.toLowerCase();
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO bad_actors (address, label, reason, severity, added_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(address) DO UPDATE SET
      label = COALESCE(excluded.label, bad_actors.label),
      reason = COALESCE(excluded.reason, bad_actors.reason),
      severity = COALESCE(excluded.severity, bad_actors.severity),
      updated_at = excluded.updated_at
  `).run(addr, label ?? null, reason ?? null, severity ?? 'warning', now, now);
}

export function removeBadActor(db: Database.Database, address: string): boolean {
  const r = db.prepare(`DELETE FROM bad_actors WHERE address = ?`).run(address.toLowerCase());
  return r.changes > 0;
}

export function listBadActors(db: Database.Database): BadActor[] {
  return db.prepare(`SELECT address, label, reason, severity, added_at as addedAt FROM bad_actors ORDER BY added_at DESC`).all() as BadActor[];
}

export function isBadActor(db: Database.Database, address: string): BadActor | null {
  return db.prepare(`SELECT address, label, reason, severity, added_at as addedAt FROM bad_actors WHERE address = ?`).get(address.toLowerCase()) as BadActor | null;
}

export async function getBadActorHoldings(
  db: Database.Database,
  coinAddress: string,
  chainId: number = 8453,
): Promise<BadActorHolding[]> {
  const actors = db.prepare(`SELECT address, label, reason, severity, added_at as addedAt FROM bad_actors`).all() as BadActor[];
  if (!actors.length) return [];

  const actorSet = new Map<string, BadActor>();
  for (const a of actors) actorSet.set(a.address.toLowerCase(), a);

  const holdings: BadActorHolding[] = [];
  let after: string | undefined;
  let totalSupply = 0n;
  const allEdges: Array<ExploreEdge<HolderBalanceNode>> = [];

  for (let page = 0; page < 4; page++) {
    try {
      const res = await getCoinHolders({
        address: coinAddress.toLowerCase(),
        chainId,
        count: 50,
        ...(after ? { after } : {}),
      });
      const edges = coinHolderEdges(res);
      if (!edges.length) break;
      allEdges.push(...edges);
      const pageInfo = coinHolderPageInfo(res);
      after = pageInfo?.endCursor ?? undefined;
      if (!pageInfo?.hasNextPage) break;
    } catch (err) {
      console.warn(`[bad-actors] getCoinHolders failed for ${coinAddress}:`, messageFromError(err));
      break;
    }
  }

  for (const edge of allEdges) {
    const bal = BigInt(edge.node?.balance ?? "0");
    totalSupply += bal;
  }

  const coinRow = db.prepare(`SELECT market_cap, volume_24h, symbol, name FROM coins WHERE address = ?`).get(coinAddress.toLowerCase()) as CoinMetadataRow | undefined;
  const marketCapUsd = Number(coinRow?.market_cap ?? 0);

  for (const edge of allEdges) {
    const ownerAddr = (edge.node?.ownerAddress ?? "").toLowerCase();
    const actor = actorSet.get(ownerAddr);
    if (!actor) continue;

    const balance = BigInt(edge.node?.balance ?? "0");
    const holdingPct = totalSupply > 0n ? Number(balance * 10000n / totalSupply) / 100 : 0;
    const estimatedSlippagePct = Math.min(95, holdingPct * 2);
    const estimatedValueUsd = marketCapUsd * (holdingPct / 100);

    holdings.push({
      actor,
      coinAddress: coinAddress.toLowerCase(),
      coinSymbol: coinRow?.symbol ?? null,
      coinName: coinRow?.name ?? null,
      balance: balance.toString(),
      holdingPct,
      estimatedSlippagePct,
      estimatedValueUsd,
    });
  }

  return holdings.sort((a, b) => b.holdingPct - a.holdingPct);
}

/**
 * Detect "chart murder" — someone selling ≥33% of a coin's LIQUIDITY (market cap) in a single shot.
 * On Doppler/Zora AMM curves, market cap ≈ liquidity depth.
 * Filters out micro-caps (<$10k MC) to avoid noise.
 */
export function detectFSH(db: Database.Database, lookbackHours: number = 24, minLiquidityPct: number = 33, minMarketCapUsd: number = 10_000): Array<{
  address: string;
  coinAddress: string;
  coinSymbol: string | null;
  sellAmountUsdc: number;
  coinMarketCapUsd: number;
  liquidityPct: number;  // what % of the coin's liquidity (MC) this sell represented
  handle: string | null;
  txTimestamp: string | null;
}> {
  // Find individual sells where sell_amount / market_cap >= threshold
  // Only coins with MC >= minMarketCapUsd (filter out dust)
  const rows = db.prepare(`
    SELECT s.sender_address AS address, s.coin_address, c.symbol AS coin_symbol,
           s.amount_usdc AS sell_amount_usdc,
           c.market_cap AS coin_market_cap,
           (s.amount_usdc / c.market_cap * 100.0) AS liquidity_pct,
           s.block_timestamp,
           a.last_profile_handle AS handle
    FROM coin_swaps s
    JOIN coins c ON c.address = s.coin_address
    LEFT JOIN addresses a ON a.address = s.sender_address
    WHERE s.activity_type = 'SELL'
      AND datetime(s.block_timestamp) >= datetime('now', ?)
      AND s.amount_usdc > 0
      AND c.market_cap >= ?
      AND (s.amount_usdc / c.market_cap * 100.0) >= ?
    ORDER BY liquidity_pct DESC
    LIMIT 20
  `).all(`-${lookbackHours} hours`, minMarketCapUsd, minLiquidityPct) as FshRow[];

  return rows.map((row) => ({
    address: row.address,
    coinAddress: row.coin_address,
    coinSymbol: row.coin_symbol,
    sellAmountUsdc: Number(row.sell_amount_usdc ?? 0),
    coinMarketCapUsd: Number(row.coin_market_cap ?? 0),
    liquidityPct: Number(row.liquidity_pct ?? 0),
    handle: row.handle ?? null,
    txTimestamp: row.block_timestamp ?? null,
  }));
}

// Cache holdings for synchronous access during alert dispatch
export function cacheBadActorHoldings(db: Database.Database, holdings: BadActorHolding[]): void {
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO bad_actor_holdings_cache 
    (actor_address, coin_address, holding_pct, estimated_slippage_pct, estimated_value_usd, checked_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  const now = new Date().toISOString();
  for (const h of holdings) {
    stmt.run(h.actor.address, h.coinAddress, h.holdingPct, h.estimatedSlippagePct, h.estimatedValueUsd, now);
  }
}

// Get cached bad actor holdings for a coin (synchronous, for use in alert dispatch)
export function getCachedBadActorHoldings(db: Database.Database, coinAddress: string): Array<{
  actorAddress: string;
  label: string | null;
  severity: string;
  holdingPct: number;
  estimatedSlippagePct: number;
  estimatedValueUsd: number;
}> {
  return db.prepare(`
    SELECT c.actor_address, b.label, b.severity, c.holding_pct as holdingPct, 
           c.estimated_slippage_pct as estimatedSlippagePct, c.estimated_value_usd as estimatedValueUsd
    FROM bad_actor_holdings_cache c
    JOIN bad_actors b ON b.address = c.actor_address
    WHERE c.coin_address = ? AND c.holding_pct > 0.1
      AND datetime(c.checked_at) >= datetime('now', '-2 hours')
    ORDER BY c.holding_pct DESC
  `).all(coinAddress.toLowerCase()) as CachedHoldingRow[];
}

export function formatBadActorWarning(holdings: Array<{ label: string | null; actorAddress?: string; severity: string; holdingPct: number; estimatedSlippagePct: number; estimatedValueUsd: number }>): string {
  if (!holdings.length) return "";
  const lines = holdings.map(h => {
    const label = h.label || (h.actorAddress ? h.actorAddress.slice(0, 10) + "..." : "unknown");
    const sev = h.severity === "danger" ? "🚨" : "⚠️";
    return `${sev} **${label}** holds ${h.holdingPct.toFixed(1)}% — dump would cause ~${h.estimatedSlippagePct.toFixed(0)}% price impact (~$${h.estimatedValueUsd.toFixed(0)} bag)`;
  });
  return `\n🕵️ **Known bad actors on this coin:**\n${lines.join("\n")}`;
}
