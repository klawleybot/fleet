/**
 * scout-live.ts — Live trading pipeline
 *
 * scout → executor → auto-execute approved trades → record positions → announce
 */

import { createPublicClient, http, formatEther, parseEther, type Address } from "viem";
import { base } from "viem/chains";
import { runScout, formatScoutReport } from "./scout.js";
import { evaluateScoutReport, formatExecutorReport, DEFAULT_POLICY, type TradeDecision } from "./scout-executor.js";
import { IntelligenceEngine } from "./engine.js";
import {
  recordBuy,
  getOpenPositions,
  getPositionCount,
  closeDb,
  type Position,
} from "./positions.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const KLAWLEY_SA: Address = "0x097677d3e2cde65af10be80ae5e67b8b68eb613d";
const WETH: Address = "0x4200000000000000000000000000000000000006";
const USDC: Address = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

// Fallback ETH price if on-chain oracle fails
const ETH_PRICE_FALLBACK = 2000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface LiveTradeResult {
  decision: TradeDecision;
  executed: boolean;
  txHash: string | null;
  ethSpent: string;
  tokensReceived: string;
  error?: string;
}

export interface LiveReport {
  scoutText: string;
  executorText: string;
  trades: LiveTradeResult[];
  announcements: string[];
  positions: Position[];
  ethBalance: string;
  capitalUsd: number;
}

// ---------------------------------------------------------------------------
// ETH price — reads sqrtPriceX96 from USDC/WETH V3 pool on Base
// ---------------------------------------------------------------------------

/** Uniswap V3 USDC/WETH 0.05% pool on Base */
const USDC_WETH_POOL: Address = "0xd0b53D9277642d899DF5C87A3966A349A798F224";

const slot0Abi = [{
  name: "slot0",
  type: "function",
  stateMutability: "view",
  inputs: [],
  outputs: [
    { name: "sqrtPriceX96", type: "uint160" },
    { name: "tick", type: "int24" },
    { name: "observationIndex", type: "uint16" },
    { name: "observationCardinality", type: "uint16" },
    { name: "observationCardinalityNext", type: "uint16" },
    { name: "feeProtocol", type: "uint8" },
    { name: "unlocked", type: "bool" },
  ],
}] as const;

let _cachedEthPrice: { price: number; fetchedAt: number } | null = null;
const ETH_PRICE_CACHE_MS = 5 * 60 * 1000; // 5 min cache

export async function fetchEthPrice(): Promise<number> {
  // Return cached price if fresh
  if (_cachedEthPrice && Date.now() - _cachedEthPrice.fetchedAt < ETH_PRICE_CACHE_MS) {
    return _cachedEthPrice.price;
  }

  try {
    const client = createPublicClient({ chain: base, transport: http(process.env.BASE_RPC_URL) });

    const result = await client.readContract({
      address: USDC_WETH_POOL,
      abi: slot0Abi,
      functionName: "slot0",
    });

    const sqrtPriceX96 = result[0] as bigint;

    // Pool is WETH (token0) / USDC (token1) — WETH has 18 decimals, USDC has 6
    // sqrtPriceX96 = sqrt(USDC_raw / WETH_raw) * 2^96
    // ETH price in USD = (sqrtPriceX96 / 2^96)^2 * 10^(18-6) = sqrtPrice^2 * 10^12 / 2^192
    // Using bigint math to avoid precision loss:
    const Q96 = 1n << 96n;
    const priceX192 = sqrtPriceX96 * sqrtPriceX96; // sqrtPrice^2 in Q192
    // priceX192 / 2^192 = USDC_raw / WETH_raw
    // ETH_USD = (priceX192 / 2^192) * 10^12
    // = priceX192 * 10^12 / 2^192
    // For numerical stability, divide in steps:
    const numerator = priceX192 * 10n ** 12n;
    const denominator = Q96 * Q96; // 2^192
    const ethPriceScaled = numerator / denominator; // integer USD (truncated)

    const ethPrice = Number(ethPriceScaled);

    // Sanity check — ETH should be between $100 and $100,000
    if (ethPrice < 100 || ethPrice > 100_000) {
      console.warn(`[eth-oracle] Price ${ethPrice} out of range, using fallback`);
      return ETH_PRICE_FALLBACK;
    }

    _cachedEthPrice = { price: ethPrice, fetchedAt: Date.now() };
    console.log(`[eth-oracle] ETH price: $${ethPrice} (from USDC/WETH pool)`);
    return ethPrice;
  } catch (err) {
    console.warn(`[eth-oracle] Failed to fetch price: ${(err as Error).message?.slice(0, 60)}`);
    return _cachedEthPrice?.price ?? ETH_PRICE_FALLBACK;
  }
}

function estimateEthPrice(): number {
  // Sync fallback — use cached price or fallback
  return _cachedEthPrice?.price ?? ETH_PRICE_FALLBACK;
}

function ethToUsd(weiStr: string): number {
  return Number(formatEther(BigInt(weiStr))) * estimateEthPrice();
}

function usdToWei(usd: number): bigint {
  const eth = usd / estimateEthPrice();
  return parseEther(eth.toFixed(18));
}

// ---------------------------------------------------------------------------
// Swap function (lazy import from server package)
// ---------------------------------------------------------------------------

let _swapFn: ((input: {
  smartAccountName: string;
  fromToken: `0x${string}`;
  toToken: `0x${string}`;
  fromAmount: bigint;
  slippageBps: number;
}) => Promise<{ userOpHash: `0x${string}`; txHash: `0x${string}` | null; status: string; amountOut?: string }>) | null = null;

async function getSwapFn() {
  if (_swapFn) return _swapFn;
  const serverPath = new URL("../../server/src/services/cdp.js", import.meta.url).pathname;
  const mod = await import(serverPath);
  _swapFn = mod.swapFromSmartAccount;
  return _swapFn!;
}

// ---------------------------------------------------------------------------
// Live pipeline
// ---------------------------------------------------------------------------

export async function runLive(opts: { dryRun?: boolean } = {}): Promise<LiveReport> {
  const dryRun = opts.dryRun ?? false;
  const apiKey = process.env.ZORA_API_KEY;

  // 1. Get current state
  const client = createPublicClient({ chain: base, transport: http(process.env.BASE_RPC_URL) });
  const ethBalance = await client.getBalance({ address: KLAWLEY_SA });
  const ethPriceUsd = await fetchEthPrice();
  const capitalUsd = Number(formatEther(ethBalance)) * ethPriceUsd;
  const currentPositions = getPositionCount();
  const openPositions = getOpenPositions();

  console.log(`[scout-live] Capital: ${formatEther(ethBalance)} ETH (~$${capitalUsd.toFixed(0)}) | Positions: ${currentPositions}`);

  // 2. Run scout
  const engine = new IntelligenceEngine({ zoraApiKey: apiKey, zoraChainId: 8453 });
  try {
    console.log("[scout-live] Syncing data...");
    await engine.pollOnce();
    const scoutReport = await runScout(engine);
    const scoutText = formatScoutReport(scoutReport);

    // 3. Run executor
    const execReport = evaluateScoutReport(scoutReport, DEFAULT_POLICY, capitalUsd, currentPositions);
    const executorText = formatExecutorReport(execReport);

    // 4. Execute auto-approved trades
    const trades: LiveTradeResult[] = [];
    const announcements: string[] = [];
    const buyDecisions = execReport.decisions.filter(
      d => (d.action === "BUY" || d.action === "DABBLE") && d.autoApproved,
    );

    if (buyDecisions.length > 0 && !dryRun) {
      console.log(`[scout-live] Executing ${buyDecisions.length} auto-approved trade(s)...`);
      const swap = await getSwapFn();

      for (const decision of buyDecisions) {
        const ethAmountWei = usdToWei(decision.proposedSizeUsd);
        console.log(`[scout-live] ${decision.action} ${decision.symbol} (${decision.coinAddress}) for ${formatEther(ethAmountWei)} ETH (~$${decision.proposedSizeUsd.toFixed(2)})`);

        try {
          const result = await swap({
            smartAccountName: "klawley",
            fromToken: WETH,
            toToken: decision.coinAddress as `0x${string}`,
            fromAmount: ethAmountWei,
            slippageBps: DEFAULT_POLICY.slippageBps,
          });

          if (result.status === "complete") {
            // Record position
            recordBuy({
              coinAddress: decision.coinAddress,
              symbol: decision.symbol,
              name: decision.name,
              ethAmountWei: ethAmountWei.toString(),
              tokenAmount: result.amountOut ?? "0",
              txHash: result.txHash,
            });

            const tradeResult: LiveTradeResult = {
              decision,
              executed: true,
              txHash: result.txHash,
              ethSpent: ethAmountWei.toString(),
              tokensReceived: result.amountOut ?? "0",
            };
            trades.push(tradeResult);

            // Format announcement
            const ann = formatBuyAnnouncement(decision, ethAmountWei.toString(), result.txHash);
            announcements.push(ann);

            console.log(`[scout-live] ✅ Bought ${decision.symbol} | tx: ${result.txHash}`);
          } else {
            trades.push({
              decision,
              executed: false,
              txHash: result.txHash,
              ethSpent: "0",
              tokensReceived: "0",
              error: `Swap status: ${result.status}`,
            });
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.error(`[scout-live] ❌ Failed to buy ${decision.symbol}: ${msg}`);
          trades.push({
            decision,
            executed: false,
            txHash: null,
            ethSpent: "0",
            tokensReceived: "0",
            error: msg,
          });
        }

        // Small delay between trades
        await new Promise(r => setTimeout(r, 2000));
      }
    } else if (buyDecisions.length > 0 && dryRun) {
      console.log(`[scout-live] DRY RUN — would execute ${buyDecisions.length} trade(s)`);
      for (const d of buyDecisions) {
        const ethWei = usdToWei(d.proposedSizeUsd);
        trades.push({
          decision: d,
          executed: false,
          txHash: null,
          ethSpent: ethWei.toString(),
          tokensReceived: "0",
          error: "DRY RUN",
        });
        announcements.push(`[DRY RUN] Would buy $${d.proposedSizeUsd.toFixed(2)} of ${d.symbol}`);
      }
    }

    return {
      scoutText,
      executorText,
      trades,
      announcements,
      positions: getOpenPositions(),
      ethBalance: ethBalance.toString(),
      capitalUsd,
    };
  } finally {
    engine.close();
  }
}

// ---------------------------------------------------------------------------
// Announcements
// ---------------------------------------------------------------------------

function formatBuyAnnouncement(decision: TradeDecision, ethWei: string, txHash: string | null): string {
  const ethStr = Number(formatEther(BigInt(ethWei))).toFixed(6);
  const usdStr = decision.proposedSizeUsd.toFixed(2);
  const sym = decision.symbol || "???";
  const name = decision.name || "";
  const conf = decision.confidence.toUpperCase();
  const reasons = decision.reasons.slice(0, 3).join(" • ");
  const txLink = txHash ? `https://basescan.org/tx/${txHash}` : "pending";

  const verb = decision.action === "DABBLE" ? "Dabbled" : "Bought";

  return [
    `🦞 **${verb}** $${usdStr} of **${sym}** ${name ? `(${name})` : ""}`,
    `Score: ${(decision.compositeScore * 100).toFixed(0)} | Confidence: ${conf}`,
    reasons ? `✓ ${reasons}` : "",
    `<${decision.coinUrl}>`,
    `tx: <${txLink}>`,
  ].filter(Boolean).join("\n");
}

export function formatSellAnnouncement(
  symbol: string,
  entryEth: string,
  exitEth: string,
  pnlPct: number,
  coinUrl: string,
  txHash: string | null,
): string {
  const entryUsd = ethToUsd(entryEth).toFixed(2);
  const exitUsd = ethToUsd(exitEth).toFixed(2);
  const pnlSign = pnlPct >= 0 ? "+" : "";
  const txLink = txHash ? `https://basescan.org/tx/${txHash}` : "pending";

  return [
    `🦞 **Sold** **${symbol}** — P&L: ${pnlSign}${pnlPct.toFixed(1)}%`,
    `Entry: $${entryUsd} | Exit: $${exitUsd}`,
    `<${coinUrl}>`,
    `tx: <${txLink}>`,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Full report for Discord
// ---------------------------------------------------------------------------

export function formatLiveReport(report: LiveReport): string {
  const lines: string[] = [];

  // Executor summary
  lines.push(report.executorText);

  // Executed trades
  if (report.trades.length > 0) {
    lines.push("");
    lines.push("**🔄 Executed Trades:**");
    for (const t of report.trades) {
      if (t.executed) {
        lines.push(`✅ ${t.decision.symbol} — ${formatEther(BigInt(t.ethSpent))} ETH`);
      } else if (t.error === "DRY RUN") {
        lines.push(`🏜️ ${t.decision.symbol} — $${t.decision.proposedSizeUsd.toFixed(2)} (dry run)`);
      } else {
        lines.push(`❌ ${t.decision.symbol} — failed: ${t.error?.slice(0, 80)}`);
      }
    }
  }

  // Open positions
  if (report.positions.length > 0) {
    lines.push("");
    lines.push("**📦 Open Positions:**");
    for (const p of report.positions) {
      const entryUsd = ethToUsd(p.entry_eth_total).toFixed(2);
      lines.push(`- ${p.symbol || p.coin_address.slice(0, 10)} — $${entryUsd} entry`);
    }
  }

  lines.push("");
  lines.push(`💰 Balance: ${Number(formatEther(BigInt(report.ethBalance))).toFixed(6)} ETH (~$${report.capitalUsd.toFixed(0)})`);

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  if (dryRun) console.log("🏜️ DRY RUN MODE — no trades will execute\n");

  const report = await runLive({ dryRun });

  console.log("\n" + formatLiveReport(report));

  if (report.announcements.length > 0) {
    console.log("\n--- ANNOUNCEMENTS ---");
    for (const a of report.announcements) console.log(a + "\n");
  }

  closeDb();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error("Fatal:", err);
    process.exit(1);
  });
}
