/**
 * scout-executor.ts — Klawley's Trade Decision Engine
 *
 * Takes a ScoutReport and produces actionable trade decisions.
 * This is the "brain" that sits between signal generation and execution.
 *
 * Design principles (from Flick):
 * - Capital preservation ALWAYS
 * - Look after holders first, be a trader second
 * - Be picky — don't blindly follow sharks just because they bought us
 * - Starting capital: ~$200-500
 *
 * The executor does NOT execute trades directly. It produces a TradeDecision[]
 * that can be:
 * 1. Posted to Discord for human review
 * 2. Fed into the fleet's operation system for execution
 * 3. Auto-executed if confidence is high enough
 */

import type { ScoutCandidate, ScoutReport } from "./scout.js";

// ---------------------------------------------------------------------------
// Policy Configuration
// ---------------------------------------------------------------------------

export interface TradingPolicy {
  /** Maximum % of total capital for any single position */
  maxPositionPct: number;
  /** Absolute max per trade in USD */
  maxTradeUsd: number;
  /** Minimum composite score to even consider (0-1) */
  minScoreThreshold: number;
  /** Minimum composite score for a tiny speculative nibble (0-1) */
  dabbleScoreThreshold: number;
  /** Minimum composite score for auto-approval (0-1). Below this = human review. */
  autoApproveThreshold: number;
  /** Maximum number of concurrent positions */
  maxConcurrentPositions: number;
  /** Minimum market cap to consider (filters dust/dead coins) */
  minMarketCapUsd: number;
  /** Minimum 24h volume to consider (need liquidity to exit) */
  minVolume24hUsd: number;
  /** Minimum unique traders in 1h (filters wash trading) */
  minUniqueTraders1h: number;
  /** Maximum % of 24h volume our trade can be (don't be the liquidity) */
  maxTradeAsVolumePct: number;
  /** Holder overlap minimum — require at least N of our holders to also hold it */
  minHolderOverlap: number;
  /** Shark discount: if a coin's only signal is one whale buying, discount it */
  sharkDiscountFactor: number;
  /** Exit: sell when acceleration exceeds this (pump detection) */
  exitPumpAcceleration: number;
  /** Exit: sell when loss exceeds this % */
  exitStopLossPct: number;
  /** Exit: sell after this many hours regardless (time stop) */
  exitTimeHours: number;
  /** Slippage tolerance in basis points */
  slippageBps: number;
}

/**
 * Conservative defaults for ~$200-500 starting capital.
 * Designed to survive a bear market and not blow up the account.
 */
export const DEFAULT_POLICY: TradingPolicy = {
  // Position sizing — conservative, momentum-focused
  maxPositionPct: 5,              // Max 5% of capital per trade
  maxTradeUsd: 25,                // Hard cap per trade
  minScoreThreshold: 0.35,        // Need 35+ score (was 25 — too loose)
  dabbleScoreThreshold: 0.42,     // 42+ can justify a tiny speculative nibble
  autoApproveThreshold: 0.50,     // 50+ score = auto-approve
  maxConcurrentPositions: 6,      // Max 6 coins (was 12 — too scattered)

  // Liquidity filters — don't buy illiquid garbage
  minMarketCapUsd: 5_000,         // $5K minimum mcap
  minVolume24hUsd: 1_000,         // $1K minimum daily volume
  minUniqueTraders1h: 2,          // At least 2 real traders in last hour
  maxTradeAsVolumePct: 2,         // Our trade can't be >2% of 24h volume

  // Signal quality filters
  minHolderOverlap: 0,            // Don't require holder overlap (nice to have, not gate)
  sharkDiscountFactor: 0.5,       // Discount single-whale signals by 50%

  // Exit strategy — fast exits, protect capital
  exitPumpAcceleration: 3.0,      // Sell when acceleration hits 3x (take profit)
  exitStopLossPct: 20,            // Sell at 20% loss (was 30% — cut losers faster)
  exitTimeHours: 24,              // Close position after 24h (was 48h — don't hold dead weight)

  // Execution
  slippageBps: 300,               // 3% slippage tolerance
};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type TradeAction = "BUY" | "DABBLE" | "SKIP" | "WATCH";
export type ConfidenceLevel = "high" | "medium" | "low";

export interface TradeDecision {
  action: TradeAction;
  confidence: ConfidenceLevel;
  coinAddress: string;
  symbol: string | null;
  name: string | null;
  coinUrl: string;

  /** Proposed trade size in USD (0 for SKIP/WATCH) */
  proposedSizeUsd: number;
  /** Composite score from scout */
  compositeScore: number;
  /** Whether this qualifies for auto-execution */
  autoApproved: boolean;

  /** Human-readable reasoning */
  reasons: string[];
  /** Human-readable warnings/risks */
  warnings: string[];

  /** Raw candidate data */
  candidate: ScoutCandidate;
}

export interface ExecutorReport {
  timestamp: string;
  capitalUsd: number;
  currentPositions: number;
  policy: TradingPolicy;
  decisions: TradeDecision[];
  summary: string;
}

// ---------------------------------------------------------------------------
// Decision Logic
// ---------------------------------------------------------------------------

function assessCandidate(
  candidate: ScoutCandidate,
  policy: TradingPolicy,
  capitalUsd: number,
  currentPositions: number,
): TradeDecision {
  const reasons: string[] = [];
  const warnings: string[] = [];
  let confidence: ConfidenceLevel = "medium";

  const { compositeScore, context } = candidate;

  // --- Hard filters (any = SKIP) ---

  if (compositeScore < policy.minScoreThreshold) {
    return skip(candidate, [`Score ${(compositeScore * 100).toFixed(0)} below threshold ${(policy.minScoreThreshold * 100).toFixed(0)}`]);
  }

  if (currentPositions >= policy.maxConcurrentPositions) {
    return skip(candidate, [`Already at max positions (${currentPositions}/${policy.maxConcurrentPositions})`]);
  }

  if (candidate.marketCap > 0 && candidate.marketCap < policy.minMarketCapUsd) {
    return skip(candidate, [`Market cap $${candidate.marketCap.toFixed(0)} below min $${policy.minMarketCapUsd}`]);
  }

  if (candidate.volume24h > 0 && candidate.volume24h < policy.minVolume24hUsd) {
    return skip(candidate, [`24h volume $${candidate.volume24h.toFixed(0)} below min $${policy.minVolume24hUsd}`]);
  }

  // No market data at all = can't trade safely
  if (candidate.marketCap === 0 && candidate.volume24h === 0) {
    // Exception: if holder overlap is very strong, WATCH it
    if (candidate.holderOverlapScore > 0.5) {
      return watch(candidate, ["Strong holder overlap but no market data — watching"]);
    }
    return skip(candidate, ["No market data available"]);
  }

  // --- Momentum gate: don't buy dead coins ---
  if (context.momentum1h < 50) {
    return skip(candidate, [`Momentum ${context.momentum1h.toFixed(0)} below minimum 50 — no active trading`]);
  }

  // --- Net flow gate: don't buy coins people are selling ---
  if (context.netFlowUsdc1h < 0) {
    return skip(candidate, [`Net flow -$${Math.abs(context.netFlowUsdc1h).toFixed(0)}/1h — money leaving, not entering`]);
  }

  // --- Soft signals (adjust confidence) ---

  // Holder overlap — strongest community signal
  if (context.holderOverlap >= 3) {
    reasons.push(`${context.holderOverlap} of our holders also hold this`);
    confidence = "high";
  } else if (context.holderOverlap >= 1) {
    reasons.push(`${context.holderOverlap} holder overlap`);
  }

  // Momentum
  if (context.momentum1h > 100) {
    reasons.push(`Strong momentum (${context.momentum1h.toFixed(0)})`);
  } else if (context.momentum1h > 0) {
    reasons.push(`Some momentum (${context.momentum1h.toFixed(0)})`);
  }

  // Net flow
  if (context.netFlowUsdc1h > 50) {
    reasons.push(`Positive net flow +$${context.netFlowUsdc1h.toFixed(0)}/1h`);
  } else if (context.netFlowUsdc1h < -50) {
    warnings.push(`Negative net flow -$${Math.abs(context.netFlowUsdc1h).toFixed(0)}/1h`);
    if (confidence === "high") confidence = "medium";
  }

  // Unique traders check
  if (context.uniqueTraders1h < policy.minUniqueTraders1h && context.uniqueTraders1h > 0) {
    warnings.push(`Only ${context.uniqueTraders1h} unique trader(s) — possible wash`);
    if (confidence === "high") confidence = "medium";
  }

  // Shark detection: if the ONLY strong signal is one big holder buying
  // and there's no organic community signal, discount it
  if (
    context.holderOverlap <= 1 &&
    context.uniqueTraders1h <= 2 &&
    candidate.commentSignalScore === 0 &&
    candidate.gainerScore === 0
  ) {
    warnings.push("Thin signal — possibly single-actor driven");
    confidence = "low";
  }

  // Comment quality — holder comments are gold, random comments are noise
  const holderComments = context.commentMentions.filter(c => c.isHolder);
  if (holderComments.length > 0) {
    reasons.push(`${holderComments.length} comment(s) from holders`);
  }

  const sharkHandles = new Set(["princeofcoins"]);
  const sharkComments = context.commentMentions.filter(c => {
    const handle = c.commenterHandle?.toLowerCase();
    return !!handle && sharkHandles.has(handle);
  });
  if (sharkComments.length > 0) {
    warnings.push("Shark wallet/commenter present — only dabble if we are clearly early");
    if (context.acceleration1h > 1.5 || context.uniqueTraders1h < 3) {
      confidence = "low";
    }
    if (context.holderOverlap === 0) {
      warnings.push("No community overlap — do not tail shark flow blindly");
    }
  }

  // Liquidity check: can we exit?
  if (candidate.volume24h > 0) {
    const maxTradeUsd = Math.min(policy.maxTradeUsd, capitalUsd * (policy.maxPositionPct / 100));
    const tradeAsVolumePct = (maxTradeUsd / candidate.volume24h) * 100;
    if (tradeAsVolumePct > policy.maxTradeAsVolumePct) {
      warnings.push(`Trade would be ${tradeAsVolumePct.toFixed(1)}% of 24h volume — thin exit`);
      if (confidence === "high") confidence = "medium";
    }
  }

  // Acceleration check — if it's already pumping hard, we're late
  if (context.acceleration1h > 2.5) {
    warnings.push(`Acceleration ${context.acceleration1h.toFixed(1)}x — may be late to the party`);
    if (confidence === "high") confidence = "medium";
    else confidence = "low";
  }

  // If no positive reasons found, WATCH instead of buying blind
  if (reasons.length === 0) {
    return watch(candidate, ["Score meets threshold but no strong individual signals"]);
  }

  // --- Position sizing (conviction-weighted) ---
  const maxFromPct = capitalUsd * (policy.maxPositionPct / 100);
  let proposedSizeUsd = Math.min(policy.maxTradeUsd, maxFromPct);
  let action: TradeAction = "BUY";

  // Low confidence can still qualify for a tiny dabble if score is decent enough.
  if (confidence === "low") {
    if (compositeScore < policy.dabbleScoreThreshold) {
      return watch(candidate, [...reasons, "Low confidence — watching, not buying yet"]);
    }
    action = "DABBLE";
    proposedSizeUsd = Math.min(proposedSizeUsd, 1.0);
    reasons.push("Qualifies for tiny speculative dabble");
  } else if (confidence === "medium") {
    proposedSizeUsd = Math.min(proposedSizeUsd, 1.5);
  }
  // High confidence = up to max size (still capped by policy)

  // Scale with score (higher score = closer to max size)
  const scoreScale = Math.min(1, compositeScore / 0.6);
  proposedSizeUsd *= scoreScale;

  // Floor at $1 (don't bother with dust trades)
  if (proposedSizeUsd < 1) {
    return skip(candidate, ["Proposed size below $1 — not worth gas"]);
  }

  // Round to 2 decimals
  proposedSizeUsd = Math.round(proposedSizeUsd * 100) / 100;

  const autoApproved =
    compositeScore >= policy.autoApproveThreshold &&
    (action === "BUY" || action === "DABBLE");

  return {
    action,
    confidence,
    coinAddress: candidate.coinAddress,
    symbol: candidate.symbol,
    name: candidate.name,
    coinUrl: candidate.coinUrl,
    proposedSizeUsd,
    compositeScore,
    autoApproved,
    reasons,
    warnings,
    candidate,
  };
}

function skip(candidate: ScoutCandidate, reasons: string[]): TradeDecision {
  return {
    action: "SKIP",
    confidence: "low",
    coinAddress: candidate.coinAddress,
    symbol: candidate.symbol,
    name: candidate.name,
    coinUrl: candidate.coinUrl,
    proposedSizeUsd: 0,
    compositeScore: candidate.compositeScore,
    autoApproved: false,
    reasons,
    warnings: [],
    candidate,
  };
}

function watch(candidate: ScoutCandidate, reasons: string[]): TradeDecision {
  return {
    action: "WATCH",
    confidence: "low",
    coinAddress: candidate.coinAddress,
    symbol: candidate.symbol,
    name: candidate.name,
    coinUrl: candidate.coinUrl,
    proposedSizeUsd: 0,
    compositeScore: candidate.compositeScore,
    autoApproved: false,
    reasons,
    warnings: [],
    candidate,
  };
}

// ---------------------------------------------------------------------------
// Executor
// ---------------------------------------------------------------------------

export function evaluateScoutReport(
  report: ScoutReport,
  policy: TradingPolicy = DEFAULT_POLICY,
  capitalUsd: number,
  currentPositions: number = 0,
): ExecutorReport {
  const decisions: TradeDecision[] = [];

  for (const candidate of report.candidates) {
    const decision = assessCandidate(candidate, policy, capitalUsd, currentPositions);
    decisions.push(decision);
  }

  // Sort: BUY first, then DABBLE, then WATCH, then SKIP
  const actionOrder: Record<TradeAction, number> = { BUY: 0, DABBLE: 1, WATCH: 2, SKIP: 3 };
  decisions.sort((a, b) => {
    const orderDiff = actionOrder[a.action] - actionOrder[b.action];
    if (orderDiff !== 0) return orderDiff;
    return b.compositeScore - a.compositeScore;
  });

  // Cap: don't exceed max positions
  const slotsAvailable = Math.max(0, policy.maxConcurrentPositions - currentPositions);
  let activeCount = 0;
  for (const d of decisions) {
    if (d.action === "BUY" || d.action === "DABBLE") {
      activeCount++;
      if (activeCount > slotsAvailable) {
        d.action = "WATCH";
        d.reasons.unshift("Position slots full — demoted to WATCH");
        d.autoApproved = false;
        d.proposedSizeUsd = 0;
      }
    }
  }

  // Cap total deployment: don't put more than 50% of capital at risk
  const totalProposed = decisions
    .filter(d => d.action === "BUY" || d.action === "DABBLE")
    .reduce((sum, d) => sum + d.proposedSizeUsd, 0);
  const maxDeployment = capitalUsd * 0.5;
  if (totalProposed > maxDeployment) {
    // Scale down all active trades proportionally
    const scale = maxDeployment / totalProposed;
    for (const d of decisions) {
      if (d.action === "BUY" || d.action === "DABBLE") {
        d.proposedSizeUsd = Math.round(d.proposedSizeUsd * scale * 100) / 100;
        if (d.proposedSizeUsd < 1) {
          d.action = "SKIP";
          d.reasons.unshift("Scaled below $1 after capital cap");
        }
      }
    }
  }

  const buys = decisions.filter(d => d.action === "BUY");
  const dabbles = decisions.filter(d => d.action === "DABBLE");
  const watches = decisions.filter(d => d.action === "WATCH");
  const totalActiveUsd = [...buys, ...dabbles].reduce((sum, d) => sum + d.proposedSizeUsd, 0);
  const autoCount = [...buys, ...dabbles].filter(d => d.autoApproved).length;

  const summary = [
    `Capital: $${capitalUsd.toFixed(0)} | Positions: ${currentPositions}/${policy.maxConcurrentPositions}`,
    `Candidates: ${report.candidates.length} → Buy: ${buys.length} | Dabble: ${dabbles.length} ($${totalActiveUsd.toFixed(2)} total) | Watch: ${watches.length} | Skip: ${decisions.length - buys.length - dabbles.length - watches.length}`,
    autoCount > 0 ? `Auto-approved: ${autoCount} (score ≥ ${(policy.autoApproveThreshold * 100).toFixed(0)})` : "No auto-approvals this round",
  ].join("\n");

  return {
    timestamp: new Date().toISOString(),
    capitalUsd,
    currentPositions,
    policy,
    decisions,
    summary,
  };
}

// ---------------------------------------------------------------------------
// Discord formatting
// ---------------------------------------------------------------------------

export function formatExecutorReport(report: ExecutorReport): string {
  const lines: string[] = [
    `📊 **Klawley Trade Decisions** — ${new Date(report.timestamp).toUTCString()}`,
    report.summary,
    "",
  ];

  const buys = report.decisions.filter(d => d.action === "BUY");
  const dabbles = report.decisions.filter(d => d.action === "DABBLE");
  const watches = report.decisions.filter(d => d.action === "WATCH");

  if (buys.length > 0) {
    lines.push("**📈 BUY Candidates:**");
    for (const d of buys) {
      const sym = d.symbol || "???";
      const badge = d.autoApproved ? "✅ AUTO" : "⏳ REVIEW";
      const conf = d.confidence.toUpperCase();
      const c = d.candidate;
      const rawScores = [
        `hldr:${(c.holderOverlapScore * 100).toFixed(0)}`,
        `mom:${(c.momentumScore * 100).toFixed(0)}`,
        `flow:${(c.netFlowScore * 100).toFixed(0)}`,
        `cmnt:${(c.commentSignalScore * 100).toFixed(0)}`,
        `gain:${(c.gainerScore * 100).toFixed(0)}`,
        `fresh:${(c.freshnessScore * 100).toFixed(0)}`,
      ].join(" | ");
      lines.push(`- **${sym}** — $${d.proposedSizeUsd.toFixed(2)} [${badge}] [${conf}] score: ${(d.compositeScore * 100).toFixed(0)}`);
      lines.push(`  \`${rawScores}\``);
      if (d.reasons.length) lines.push(`  ✓ ${d.reasons.join(" • ")}`);
      if (d.warnings.length) lines.push(`  ⚠️ ${d.warnings.join(" • ")}`);
      lines.push(`  <${d.coinUrl}>`);
    }
    lines.push("");
  }

  if (dabbles.length > 0) {
    lines.push("**🎯 DABBLE Candidates:**");
    for (const d of dabbles) {
      const sym = d.symbol || "???";
      const badge = d.autoApproved ? "✅ AUTO" : "⏳ REVIEW";
      const conf = d.confidence.toUpperCase();
      const c = d.candidate;
      const rawScores = [
        `hldr:${(c.holderOverlapScore * 100).toFixed(0)}`,
        `mom:${(c.momentumScore * 100).toFixed(0)}`,
        `flow:${(c.netFlowScore * 100).toFixed(0)}`,
        `cmnt:${(c.commentSignalScore * 100).toFixed(0)}`,
        `gain:${(c.gainerScore * 100).toFixed(0)}`,
        `fresh:${(c.freshnessScore * 100).toFixed(0)}`,
      ].join(" | ");
      lines.push(`- **${sym}** — $${d.proposedSizeUsd.toFixed(2)} [${badge}] [${conf}] score: ${(d.compositeScore * 100).toFixed(0)}`);
      lines.push(`  \`${rawScores}\``);
      if (d.reasons.length) lines.push(`  ✓ ${d.reasons.join(" • ")}`);
      if (d.warnings.length) lines.push(`  ⚠️ ${d.warnings.join(" • ")}`);
      lines.push(`  <${d.coinUrl}>`);
    }
    lines.push("");
  }

  if (watches.length > 0) {
    lines.push("**👀 Watching:**");
    for (const d of watches.slice(0, 5)) {
      const sym = d.symbol || "???";
      const c = d.candidate;
      const rawScores = [
        `hldr:${(c.holderOverlapScore * 100).toFixed(0)}`,
        `mom:${(c.momentumScore * 100).toFixed(0)}`,
        `flow:${(c.netFlowScore * 100).toFixed(0)}`,
        `cmnt:${(c.commentSignalScore * 100).toFixed(0)}`,
        `gain:${(c.gainerScore * 100).toFixed(0)}`,
        `fresh:${(c.freshnessScore * 100).toFixed(0)}`,
      ].join(" | ");
      lines.push(`- ${sym} — score: ${(d.compositeScore * 100).toFixed(0)} \`${rawScores}\``);
      lines.push(`  ${d.reasons[0] || "monitoring"} <${d.coinUrl}>`);
    }
    lines.push("");
  }

  if (buys.length === 0 && dabbles.length === 0 && watches.length === 0) {
    lines.push("Nothing actionable this round. Capital stays dry. 🏜️");
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

async function main() {
  const { runScout } = await import("./scout.js");
  const { IntelligenceEngine } = await import("./engine.js");

  const apiKey = process.env.ZORA_API_KEY;
  const engine = new IntelligenceEngine({ zoraApiKey: apiKey, zoraChainId: 8453 });

  try {
    console.log("Running scout...");
    await engine.pollOnce();
    const report = await runScout(engine);

    // Default test capital
    const capitalUsd = Number(process.argv[3] || "200");
    const positions = Number(process.argv[4] || "0");

    console.log("\nEvaluating trade decisions...");
    const execReport = evaluateScoutReport(report, DEFAULT_POLICY, capitalUsd, positions);

    console.log("\n" + formatExecutorReport(execReport));

    if (process.argv.includes("--json")) {
      console.log("\n--- JSON ---");
      console.log(JSON.stringify(execReport, null, 2));
    }
  } finally {
    engine.close();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error("Executor fatal:", err);
    process.exit(1);
  });
}
