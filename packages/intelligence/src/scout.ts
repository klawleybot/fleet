/**
 * scout.ts — Klawley's Entry Engine
 *
 * Hourly cron that generates trade candidates by:
 * 1. Checking what $openklaw holders are buying (holder intelligence)
 * 2. Pulling broad market activity (momentum, gainers)
 * 3. Scanning comments on Klawley's coins for alpha (with credibility discount)
 * 4. Scoring everything with code-driven signals
 * 5. Final LLM step to rank and produce actionable shortlist
 *
 * This module does NOT execute trades — it produces a report.
 */

import * as zoraSdk from "@zoralabs/coins-sdk";
import { IntelligenceEngine } from "./engine.js";
import { checkTradeabilityBatch, closeTradeabilityDb } from "./tradeability.js";

// SDK function references
const getCoinHolders = (zoraSdk as any).getCoinHolders as (args: any) => Promise<any>;
const getCoinComments = (zoraSdk as any).getCoinComments as (args: any) => Promise<any>;
const getProfileBalances = (zoraSdk as any).getProfileBalances as (args: any) => Promise<any>;
const getCoinsTopGainers = (zoraSdk as any).getCoinsTopGainers as (args: any) => Promise<any>;
const getCoinsLastTradedUnique = (zoraSdk as any).getCoinsLastTradedUnique as (args: any) => Promise<any>;
const getCoin = (zoraSdk as any).getCoin as (args: any) => Promise<any>;
const getCoinSwaps = (zoraSdk as any).getCoinSwaps as (args: any) => Promise<any>;
const setApiKey = (zoraSdk as any).setApiKey as ((apiKey: string) => void) | undefined;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** $openklaw creator coin */
const OPENKLAW_COIN = "0x2e6e49e3f1c76d9b8c7ca0bee2005ed6de0e2046";
/** Klawley smart wallet (creator) */
const KLAWLEY_WALLET = "0x097677d3e2cde65af10be80ae5e67b8b68eb613d";
/** Base chain */
const CHAIN_ID = 8453;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface HolderInfo {
  address: string;
  handle: string | null;
  balance: string;
}

export interface HolderPortfolioCoin {
  coinAddress: string;
  symbol: string | null;
  name: string | null;
  /** How many of our holders also hold this coin */
  holderOverlap: number;
  /** Total balance (in token units) across our holders */
  aggregateBalance: number;
}

export interface CommentSignal {
  coinAddress: string;
  commenterAddress: string;
  commenterHandle: string | null;
  comment: string;
  timestamp: number;
  /** Is the commenter a significant holder? */
  isHolder: boolean;
  /** Commenter's $openklaw balance (0 if not a holder) */
  holderBalance: number;
}

export interface ScoutCandidate {
  coinAddress: string;
  symbol: string | null;
  name: string | null;
  marketCap: number;
  volume24h: number;
  coinUrl: string;

  // Signal scores (0-1 each, then weighted)
  holderOverlapScore: number;    // How many of our holders hold this
  momentumScore: number;         // From analytics engine
  netFlowScore: number;          // Buy pressure vs sell pressure
  commentSignalScore: number;    // Credible comment mentions
  gainerScore: number;           // Is it on the top gainers list?
  freshnessScore: number;        // Recently created?

  /** Weighted composite score */
  compositeScore: number;

  /** Raw signal context for LLM */
  context: {
    holderOverlap: number;
    momentum1h: number;
    acceleration1h: number;
    netFlowUsdc1h: number;
    uniqueTraders1h: number;
    commentMentions: CommentSignal[];
  };
}

export interface ScoutReport {
  timestamp: string;
  holderCount: number;
  coinsScanned: number;
  candidates: ScoutCandidate[];
  /** LLM-generated summary (populated by the cron runner) */
  summary?: string;
}

// ---------------------------------------------------------------------------
// Step 1: Holder Intelligence
// ---------------------------------------------------------------------------

/**
 * Get all holders of $openklaw coin.
 */
export async function getKlawleyHolders(limit = 50): Promise<HolderInfo[]> {
  const holders: HolderInfo[] = [];
  let cursor: string | undefined;
  let pages = 0;
  const maxPages = Math.ceil(limit / 20);

  while (pages < maxPages) {
    const res = await getCoinHolders({
      chainId: CHAIN_ID,
      address: OPENKLAW_COIN,
      count: Math.min(20, limit - holders.length),
      ...(cursor ? { after: cursor } : {}),
    });

    const data = res?.data?.zora20Token?.tokenBalances;
    if (!data?.edges?.length) break;

    for (const edge of data.edges) {
      const node = edge.node;
      holders.push({
        address: node.ownerAddress?.toLowerCase() ?? "",
        handle: node.ownerProfile?.handle ?? null,
        balance: node.balance ?? "0",
      });
    }

    if (!data.pageInfo?.hasNextPage) break;
    cursor = data.pageInfo.endCursor;
    pages++;
  }

  // Filter out zero-address, Klawley's own wallet, and known system addresses
  return holders.filter(h =>
    h.address &&
    h.address !== "0x0000000000000000000000000000000000000000" &&
    h.address !== KLAWLEY_WALLET.toLowerCase()
  );
}

/**
 * Get what coins a holder owns on Zora.
 */
async function getHolderPortfolio(holderAddress: string, limit = 20): Promise<Array<{
  coinAddress: string;
  symbol: string | null;
  name: string | null;
  balance: number;
}>> {
  try {
    const res = await getProfileBalances({
      identifier: holderAddress,
      count: limit,
      sortOption: "USD_VALUE",
      chainIds: [CHAIN_ID],
    });

    const edges = res?.data?.profile?.coinBalances?.edges ?? [];
    return edges.map((e: any) => ({
      coinAddress: (e.node?.coin?.address ?? "").toLowerCase(),
      symbol: e.node?.coin?.symbol ?? null,
      name: e.node?.coin?.name ?? null,
      balance: Number(e.node?.balance ?? 0),
    })).filter((c: any) => c.coinAddress && c.coinAddress !== OPENKLAW_COIN);
  } catch (err) {
    console.error(`Failed to get portfolio for ${holderAddress}:`, err);
    return [];
  }
}

/**
 * Aggregate: what coins are $openklaw holders buying?
 * Returns coins sorted by holder overlap.
 */
export async function aggregateHolderPortfolios(
  holders: HolderInfo[],
  portfolioLimit = 15,
): Promise<HolderPortfolioCoin[]> {
  const coinMap = new Map<string, HolderPortfolioCoin>();

  // Sample top holders (by balance) — don't hammer the API
  const topHolders = holders
    .sort((a, b) => Number(b.balance) - Number(a.balance))
    .slice(0, 20);

  for (const holder of topHolders) {
    // Rate limit: small delay between calls
    await new Promise(r => setTimeout(r, 200));

    const portfolio = await getHolderPortfolio(holder.address, portfolioLimit);
    for (const coin of portfolio) {
      const existing = coinMap.get(coin.coinAddress);
      if (existing) {
        existing.holderOverlap++;
        existing.aggregateBalance += coin.balance;
      } else {
        coinMap.set(coin.coinAddress, {
          coinAddress: coin.coinAddress,
          symbol: coin.symbol,
          name: coin.name,
          holderOverlap: 1,
          aggregateBalance: coin.balance,
        });
      }
    }
  }

  return [...coinMap.values()]
    .sort((a, b) => b.holderOverlap - a.holderOverlap);
}

// ---------------------------------------------------------------------------
// Step 2: Market Activity (uses existing engine data + explore APIs)
// ---------------------------------------------------------------------------

export async function getTopGainers(limit = 20): Promise<Array<{
  address: string;
  symbol: string | null;
  name: string | null;
  marketCap: number;
  volume24h: number;
}>> {
  try {
    const res = await getCoinsTopGainers({ count: limit });
    const edges = res?.data?.exploreList?.edges ?? [];
    return edges.map((e: any) => ({
      address: (e.node?.address ?? "").toLowerCase(),
      symbol: e.node?.symbol ?? null,
      name: e.node?.name ?? null,
      marketCap: Number(e.node?.marketCap ?? 0),
      volume24h: Number(e.node?.volume24h ?? 0),
    }));
  } catch (err) {
    console.error("Failed to get top gainers:", err);
    return [];
  }
}

export async function getRecentlyTraded(limit = 30): Promise<Array<{
  address: string;
  symbol: string | null;
  name: string | null;
  marketCap: number;
  volume24h: number;
}>> {
  try {
    const res = await getCoinsLastTradedUnique({ count: limit });
    const edges = res?.data?.exploreList?.edges ?? [];
    return edges.map((e: any) => ({
      address: (e.node?.address ?? "").toLowerCase(),
      symbol: e.node?.symbol ?? null,
      name: e.node?.name ?? null,
      marketCap: Number(e.node?.marketCap ?? 0),
      volume24h: Number(e.node?.volume24h ?? 0),
    }));
  } catch (err) {
    console.error("Failed to get recently traded:", err);
    return [];
  }
}

// ---------------------------------------------------------------------------
// Step 3: Comment Intelligence
// ---------------------------------------------------------------------------

/**
 * Get comments on a specific coin, with holder credibility cross-reference.
 */
export async function getCoinCommentSignals(
  coinAddress: string,
  holderAddresses: Set<string>,
  holderBalanceMap: Map<string, number>,
  limit = 20,
): Promise<CommentSignal[]> {
  try {
    const res = await getCoinComments({
      address: coinAddress,
      chain: CHAIN_ID,
      count: limit,
    });

    const edges = res?.data?.zora20Token?.zoraComments?.edges ?? [];
    const signals: CommentSignal[] = [];

    for (const edge of edges) {
      const node = edge.node;
      const addr = (node.userAddress ?? "").toLowerCase();
      const isHolder = holderAddresses.has(addr);

      signals.push({
        coinAddress,
        commenterAddress: addr,
        commenterHandle: node.userProfile?.handle ?? null,
        comment: node.comment ?? "",
        timestamp: node.timestamp ?? 0,
        isHolder,
        holderBalance: holderBalanceMap.get(addr) ?? 0,
      });
    }

    return signals;
  } catch (err) {
    console.error(`Failed to get comments for ${coinAddress}:`, err);
    return [];
  }
}

/**
 * Scan comments on all of Klawley's coins for alpha.
 */
export async function scanKlawleyComments(
  klawleyCoins: string[],
  holderAddresses: Set<string>,
  holderBalanceMap: Map<string, number>,
): Promise<CommentSignal[]> {
  const allSignals: CommentSignal[] = [];

  for (const coin of klawleyCoins.slice(0, 5)) {
    await new Promise(r => setTimeout(r, 200));
    const signals = await getCoinCommentSignals(coin, holderAddresses, holderBalanceMap, 20);
    allSignals.push(...signals);
  }

  // Sort: holder comments first, then by recency
  return allSignals.sort((a, b) => {
    if (a.isHolder !== b.isHolder) return a.isHolder ? -1 : 1;
    return b.timestamp - a.timestamp;
  });
}

// ---------------------------------------------------------------------------
// Step 4: Scoring
// ---------------------------------------------------------------------------

interface ScoringInput {
  coinAddress: string;
  symbol: string | null;
  name: string | null;
  marketCap: number;
  volume24h: number;

  // Raw signals
  holderOverlap: number;
  maxHolderOverlap: number;        // For normalization
  momentum1h: number;
  acceleration1h: number;
  netFlowUsdc1h: number;
  uniqueTraders1h: number;
  commentSignals: CommentSignal[];
  isTopGainer: boolean;
  createdAt: string | null;
}

const WEIGHTS = {
  holderOverlap: 0.30,   // What are my holders buying? Strongest signal.
  momentum: 0.20,        // Is it moving?
  netFlow: 0.15,         // Buy vs sell pressure
  commentSignal: 0.15,   // Are credible people talking about it?
  gainer: 0.10,          // Is it on the gainers list?
  freshness: 0.10,       // Newer coins = more upside (and risk)
};

function scoreCandidate(input: ScoringInput): ScoutCandidate {
  // Holder overlap: normalized to 0-1 relative to max overlap in batch
  const holderOverlapScore = input.maxHolderOverlap > 0
    ? Math.min(1, input.holderOverlap / input.maxHolderOverlap)
    : 0;

  // Momentum: log-scale, capped at 1
  const momentumScore = Math.min(1, Math.log1p(Math.max(0, input.momentum1h)) / Math.log1p(500));

  // Net flow: positive = buy pressure. Sigmoid-ish normalization.
  const netFlowScore = input.netFlowUsdc1h > 0
    ? Math.min(1, input.netFlowUsdc1h / 1000)
    : Math.max(0, 0.2 + input.netFlowUsdc1h / 5000); // Small penalty for sell pressure

  // Comment signal: weighted by holder credibility
  let commentRawScore = 0;
  for (const cs of input.commentSignals) {
    if (cs.isHolder && cs.holderBalance > 0) {
      // Large holder comment = strong signal
      commentRawScore += 0.5;
    } else if (cs.isHolder) {
      commentRawScore += 0.2;
    } else {
      // Random commenter = heavily discounted (as Flick requested)
      commentRawScore += 0.02;
    }
  }
  const commentSignalScore = Math.min(1, commentRawScore);

  // Gainer: binary
  const gainerScore = input.isTopGainer ? 1 : 0;

  // Freshness: coins created in last 24h get a boost
  let freshnessScore = 0;
  if (input.createdAt) {
    const ageHours = (Date.now() - new Date(input.createdAt).getTime()) / (1000 * 60 * 60);
    if (ageHours <= 6) freshnessScore = 1;
    else if (ageHours <= 24) freshnessScore = 0.7;
    else if (ageHours <= 72) freshnessScore = 0.3;
  }

  const compositeScore =
    holderOverlapScore * WEIGHTS.holderOverlap +
    momentumScore * WEIGHTS.momentum +
    netFlowScore * WEIGHTS.netFlow +
    commentSignalScore * WEIGHTS.commentSignal +
    gainerScore * WEIGHTS.gainer +
    freshnessScore * WEIGHTS.freshness;

  return {
    coinAddress: input.coinAddress,
    symbol: input.symbol,
    name: input.name,
    marketCap: input.marketCap,
    volume24h: input.volume24h,
    coinUrl: `https://zora.co/coin/base:${input.coinAddress}`,
    holderOverlapScore,
    momentumScore,
    netFlowScore,
    commentSignalScore,
    gainerScore,
    freshnessScore,
    compositeScore,
    context: {
      holderOverlap: input.holderOverlap,
      momentum1h: input.momentum1h,
      acceleration1h: input.acceleration1h,
      netFlowUsdc1h: input.netFlowUsdc1h,
      uniqueTraders1h: input.uniqueTraders1h,
      commentMentions: input.commentSignals,
    },
  };
}

// ---------------------------------------------------------------------------
// Step 5: Full Scout Run
// ---------------------------------------------------------------------------

export async function runScout(engine: IntelligenceEngine): Promise<ScoutReport> {
  console.log("[scout] Starting scout run...");
  const startTime = Date.now();

  // --- Gather data in parallel where possible ---

  // 1. Get holders
  console.log("[scout] Fetching $openklaw holders...");
  const holders = await getKlawleyHolders(50);
  console.log(`[scout] Found ${holders.length} holders`);

  const holderAddressSet = new Set(holders.map(h => h.address));
  const holderBalanceMap = new Map(holders.map(h => [h.address, Number(h.balance)]));

  // 2. Aggregate holder portfolios
  console.log("[scout] Analyzing holder portfolios...");
  const holderCoins = await aggregateHolderPortfolios(holders);
  console.log(`[scout] Holder overlap on ${holderCoins.length} unique coins`);

  // 3. Fetch market data
  console.log("[scout] Fetching market data...");
  const [topGainers, recentlyTraded] = await Promise.all([
    getTopGainers(30),
    getRecentlyTraded(30),
  ]);
  const gainerSet = new Set(topGainers.map(g => g.address));

  // 4. Scan comments on Klawley's coins
  console.log("[scout] Scanning comments...");
  const klawleyCoins = [OPENKLAW_COIN]; // Add more Klawley coins here as they're created
  const commentSignals = await scanKlawleyComments(klawleyCoins, holderAddressSet, holderBalanceMap);
  console.log(`[scout] Found ${commentSignals.length} comment signals`);

  // --- Build candidate universe ---
  // Merge all coin addresses we've seen
  const candidateMap = new Map<string, {
    address: string;
    symbol: string | null;
    name: string | null;
    marketCap: number;
    volume24h: number;
    holderOverlap: number;
    createdAt: string | null;
  }>();

  // Add holder portfolio coins
  for (const hc of holderCoins) {
    candidateMap.set(hc.coinAddress, {
      address: hc.coinAddress,
      symbol: hc.symbol,
      name: hc.name,
      marketCap: 0,
      volume24h: 0,
      holderOverlap: hc.holderOverlap,
      createdAt: null,
    });
  }

  // Add market movers
  for (const coin of [...topGainers, ...recentlyTraded]) {
    if (coin.address === OPENKLAW_COIN) continue;
    const existing = candidateMap.get(coin.address);
    if (existing) {
      existing.marketCap = existing.marketCap || coin.marketCap;
      existing.volume24h = existing.volume24h || coin.volume24h;
      if (!existing.symbol) existing.symbol = coin.symbol;
      if (!existing.name) existing.name = coin.name;
    } else {
      candidateMap.set(coin.address, {
        address: coin.address,
        symbol: coin.symbol,
        name: coin.name,
        marketCap: coin.marketCap,
        volume24h: coin.volume24h,
        holderOverlap: 0,
        createdAt: null,
      });
    }
  }

  // --- Fetch market data for holder-overlap coins missing local analytics ---
  // These coins are in holder portfolios but not in our analytics DB
  // (never appeared in tracked swaps). Fetch from Zora SDK directly.
  const missingDataCoins: string[] = [];
  for (const [addr, coin] of candidateMap) {
    if (coin.holderOverlap >= 2 && coin.marketCap === 0) {
      const detail = engine.getCoinDetail(addr);
      if (!detail?.analytics) {
        missingDataCoins.push(addr);
      }
    }
  }

  type SdkMomentum = { swapCount: number; buys: number; sells: number; volumeUsdc: number };
  let sdkMomentumMap = new Map<string, SdkMomentum>();

  if (missingDataCoins.length > 0) {
    console.log(`[scout] Fetching market data for ${missingDataCoins.length} holder-overlap coins without local analytics...`);
    const BATCH_SIZE = 5;
    for (let i = 0; i < missingDataCoins.length; i += BATCH_SIZE) {
      const batch = missingDataCoins.slice(i, i + BATCH_SIZE);
      const results = await Promise.allSettled(
        batch.map(async (addr) => {
          try {
            const [coinResp, swapsResp] = await Promise.all([
              getCoin({ address: addr, chainId: CHAIN_ID }),
              getCoinSwaps({ address: addr, chainId: CHAIN_ID, count: 20 }).catch(() => null),
            ]);
            const coinData = coinResp?.data?.coin;
            if (coinData) {
              const entry = candidateMap.get(addr);
              if (entry) {
                entry.marketCap = Number(coinData.marketCap ?? 0);
                entry.volume24h = Number(coinData.volume24h ?? 0);
                if (!entry.symbol) entry.symbol = coinData.symbol ?? null;
                if (!entry.name) entry.name = coinData.name ?? null;
                if (!entry.createdAt) entry.createdAt = coinData.createdAt ?? null;
              }
            }
            // Derive basic momentum from recent swaps
            if (swapsResp?.data?.coinSwaps?.edges?.length) {
              const swaps = swapsResp.data.coinSwaps.edges.map((e: any) => e.node);
              const oneHourAgo = Date.now() - 60 * 60 * 1000;
              const recentSwaps = swaps.filter((s: any) =>
                new Date(s.timestamp || s.createdAt || 0).getTime() > oneHourAgo
              );
              // Store estimated momentum for this coin (swap count as proxy)
              const buys = recentSwaps.filter((s: any) => s.type === "BUY" || s.isBuy).length;
              const sells = recentSwaps.filter((s: any) => s.type === "SELL" || !s.isBuy).length;
              const totalVol = recentSwaps.reduce((sum: number, s: any) =>
                sum + Number(s.amountUsdc ?? s.amount_usdc ?? 0), 0);
              sdkMomentumMap.set(addr, {
                swapCount: recentSwaps.length,
                buys,
                sells,
                volumeUsdc: totalVol,
              });
            }
          } catch (err) {
            // Non-fatal — just means we won't have market data for this coin
          }
        })
      );
      // Small delay between batches to be polite to the API
      if (i + BATCH_SIZE < missingDataCoins.length) {
        await new Promise(r => setTimeout(r, 500));
      }
    }
    console.log(`[scout] Enriched ${missingDataCoins.length} coins with SDK data`);
  }

  // --- Filter out untradeable coins (V3-only, etc.) ---
  const allAddrs = Array.from(candidateMap.keys());
  console.log(`[scout] Checking tradeability for ${allAddrs.length} candidates...`);
  const tradeabilityMap = await checkTradeabilityBatch(allAddrs);
  let filteredCount = 0;
  for (const [addr, result] of tradeabilityMap) {
    if (!result.tradeable) {
      candidateMap.delete(addr);
      filteredCount++;
    }
  }
  if (filteredCount > 0) {
    console.log(`[scout] Filtered ${filteredCount} untradeable coins (V3-only or no currency)`);
  }

  // Enrich from local DB (analytics + coin data)
  const maxHolderOverlap = Math.max(1, ...Array.from(candidateMap.values()).map(c => c.holderOverlap));

  // Build comment signals map by coin
  const commentsByCoin = new Map<string, CommentSignal[]>();
  for (const cs of commentSignals) {
    // Comments on Klawley coins might mention other coins — for now just track direct
    const existing = commentsByCoin.get(cs.coinAddress) ?? [];
    existing.push(cs);
    commentsByCoin.set(cs.coinAddress, existing);
  }

  // Score all candidates
  const candidates: ScoutCandidate[] = [];

  for (const [addr, coin] of candidateMap) {
    // Try to get analytics from local DB
    const detail = engine.getCoinDetail(addr);
    const analytics = detail?.analytics;
    const dbCoin = detail?.coin;

    // Use SDK-derived momentum if no local analytics exist
    const sdkMom = sdkMomentumMap.get(addr);
    let momentum1h = Number(analytics?.momentum_score_1h ?? 0);
    let uniqueTraders1h = Number(analytics?.unique_traders_1h ?? 0);
    let netFlowUsdc1h = Number(analytics?.net_flow_usdc_1h ?? 0);

    if (!analytics && sdkMom) {
      // Estimate momentum from swap count (each swap ≈ some momentum units)
      momentum1h = sdkMom.swapCount * 5; // rough proxy
      uniqueTraders1h = sdkMom.swapCount; // upper bound (may overcount)
      // Net flow: buys minus sells volume
      netFlowUsdc1h = sdkMom.volumeUsdc * (sdkMom.buys - sdkMom.sells) / Math.max(1, sdkMom.swapCount);
    }

    const scoringInput: ScoringInput = {
      coinAddress: addr,
      symbol: coin.symbol ?? dbCoin?.symbol ?? null,
      name: coin.name ?? dbCoin?.name ?? null,
      marketCap: coin.marketCap || Number(dbCoin?.market_cap ?? 0),
      volume24h: coin.volume24h || Number(dbCoin?.volume_24h ?? 0),
      holderOverlap: coin.holderOverlap,
      maxHolderOverlap,
      momentum1h,
      acceleration1h: Number(analytics?.momentum_acceleration_1h ?? 0),
      netFlowUsdc1h,
      uniqueTraders1h,
      commentSignals: commentsByCoin.get(addr) ?? [],
      isTopGainer: gainerSet.has(addr),
      createdAt: coin.createdAt ?? dbCoin?.created_at ?? null,
    };

    candidates.push(scoreCandidate(scoringInput));
  }

  // Sort by composite score, take top 15
  candidates.sort((a, b) => b.compositeScore - a.compositeScore);
  const topCandidates = candidates.slice(0, 15);

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`[scout] Done in ${elapsed}s — ${candidates.length} scored, top ${topCandidates.length} reported`);

  return {
    timestamp: new Date().toISOString(),
    holderCount: holders.length,
    coinsScanned: candidateMap.size,
    candidates: topCandidates,
  };
}

// ---------------------------------------------------------------------------
// Report formatting (for Discord / cron output)
// ---------------------------------------------------------------------------

export function formatScoutReport(report: ScoutReport): string {
  const lines: string[] = [
    `🔭 **Klawley Scout Report** — ${new Date(report.timestamp).toUTCString()}`,
    `Holders: ${report.holderCount} | Coins scanned: ${report.coinsScanned}`,
    "",
  ];

  if (report.candidates.length === 0) {
    lines.push("No trade candidates found this hour. The trenches are quiet.");
    return lines.join("\n");
  }

  for (let i = 0; i < Math.min(10, report.candidates.length); i++) {
    const c = report.candidates[i];
    const rank = i + 1;
    const symbol = c.symbol || "???";
    const name = c.name || "unknown";
    const mcap = c.marketCap > 0 ? `$${formatNum(c.marketCap)}` : "n/a";
    const vol = c.volume24h > 0 ? `$${formatNum(c.volume24h)}` : "n/a";

    const signals: string[] = [];
    if (c.holderOverlapScore > 0.3) signals.push(`👥 ${c.context.holderOverlap} holders overlap`);
    if (c.momentumScore > 0.3) signals.push(`🔥 momentum ${c.context.momentum1h.toFixed(0)}`);
    if (c.netFlowScore > 0.5) signals.push(`💰 net flow +$${formatNum(c.context.netFlowUsdc1h)}`);
    if (c.commentSignalScore > 0) signals.push(`💬 ${c.context.commentMentions.length} comments`);
    if (c.gainerScore > 0) signals.push("📈 top gainer");
    if (c.freshnessScore > 0.5) signals.push("🆕 fresh");

    // Raw component scores breakdown
    const rawScores = [
      `hldr:${(c.holderOverlapScore * 100).toFixed(0)}`,
      `mom:${(c.momentumScore * 100).toFixed(0)}`,
      `flow:${(c.netFlowScore * 100).toFixed(0)}`,
      `cmnt:${(c.commentSignalScore * 100).toFixed(0)}`,
      `gain:${(c.gainerScore * 100).toFixed(0)}`,
      `fresh:${(c.freshnessScore * 100).toFixed(0)}`,
    ].join(" | ");

    lines.push(
      `**${rank}. ${symbol}** / ${name} — composite: ${(c.compositeScore * 100).toFixed(0)}`,
    );
    lines.push(`   mcap: ${mcap} • vol24h: ${vol}`);
    lines.push(`   \`${rawScores}\``);
    if (signals.length) lines.push(`   ${signals.join(" • ")}`);
    lines.push(`   <${c.coinUrl}>`);
    lines.push("");
  }

  if (report.summary) {
    lines.push("---");
    lines.push(report.summary);
  }

  return lines.join("\n");
}

function formatNum(v: number): string {
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000) return `${(v / 1_000).toFixed(1)}K`;
  return v.toFixed(0);
}

// ---------------------------------------------------------------------------
// CLI entrypoint
// ---------------------------------------------------------------------------

async function main() {
  const apiKey = process.env.ZORA_API_KEY;
  if (apiKey && setApiKey) setApiKey(apiKey);

  const engine = new IntelligenceEngine({
    zoraApiKey: apiKey,
    zoraChainId: CHAIN_ID,
  });

  try {
    // Run a poll first to get fresh analytics data
    console.log("[scout] Running data sync first...");
    await engine.pollOnce();

    const report = await runScout(engine);
    console.log("\n" + formatScoutReport(report));

    // Also output JSON for programmatic consumption
    console.log("\n--- JSON ---");
    console.log(JSON.stringify(report, null, 2));
  } finally {
    engine.close();
    closeTradeabilityDb();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error("Scout fatal:", err);
    process.exit(1);
  });
}
