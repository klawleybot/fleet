import pLimit from "p-limit";
import { db } from "../db/index.js";
import { swapFromSmartAccount } from "./cdp.js";
import { recordTradePosition } from "./monitor.js";
import type { StrategyMode, TradeRecord } from "../types.js";

const NATIVE_ETH = "0x0000000000000000000000000000000000000000" as const;
const WETH = "0x4200000000000000000000000000000000000006" as const;

function isEthLike(addr: string): boolean {
  const lower = addr.toLowerCase();
  return lower === NATIVE_ETH || lower === WETH;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Jiggle — randomize per-wallet amounts while preserving total
// ---------------------------------------------------------------------------

/**
 * Distribute `total` across `count` wallets with ±factor random variance.
 * The sum of returned amounts always equals `total`.
 *
 * @param total - Total amount to distribute
 * @param count - Number of wallets
 * @param factor - Variance factor (0.15 = ±15%). Default 0.15.
 */
export function jiggleAmounts(total: bigint, count: number, factor = 0.15): bigint[] {
  if (count <= 0) throw new Error("count must be > 0");
  if (count === 1) return [total];

  const base = Number(total) / count;
  // Generate random multipliers in [1-factor, 1+factor]
  const multipliers = Array.from({ length: count }, () =>
    1 - factor + Math.random() * 2 * factor,
  );

  // Normalize so multipliers sum to `count` (preserves total)
  const mulSum = multipliers.reduce((a, b) => a + b, 0);
  const normalized = multipliers.map((m) => (m / mulSum) * count);

  // Convert to bigints
  const amounts = normalized.map((m) => BigInt(Math.floor(base * m)));

  // Fix rounding: add remainder to the last wallet
  const allocated = amounts.reduce((a, b) => a + b, 0n);
  amounts[amounts.length - 1]! += total - allocated;

  return amounts;
}

function shuffle<T>(items: T[]): T[] {
  const next = [...items];
  for (let i = next.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    const a = next[i]!;
    const b = next[j]!;
    next[i] = b;
    next[j] = a;
  }
  return next;
}

async function executeSingleSwap(input: {
  walletId: number;
  fromToken: `0x${string}`;
  toToken: `0x${string}`;
  amountInWei: bigint;
  slippageBps: number;
  operationId?: number | null;
}): Promise<TradeRecord> {
  const wallet = db.getWalletById(input.walletId);
  if (!wallet) {
    throw new Error(`Wallet ${input.walletId} was not found.`);
  }

  try {
    const result = await swapFromSmartAccount({
      smartAccountName: wallet.cdpAccountName,
      fromToken: input.fromToken,
      toToken: input.toToken,
      fromAmount: input.amountInWei,
      slippageBps: input.slippageBps,
    });

    const isComplete = result.status === "complete";
    const trade = db.createTrade({
      walletId: wallet.id,
      fromToken: input.fromToken,
      toToken: input.toToken,
      amountIn: input.amountInWei.toString(),
      amountOut: result.amountOut ?? null,
      operationId: input.operationId ?? null,
      userOpHash: result.userOpHash,
      txHash: result.txHash,
      status: isComplete ? "complete" : "failed",
      errorMessage: isComplete ? null : `Status ${result.status}`,
    });

    // Record position impact on successful trades
    if (isComplete) {
      const isBuy = isEthLike(input.fromToken);
      const coinAddress = isBuy ? input.toToken : input.fromToken;
      const ethAmount = input.amountInWei.toString();
      const tokenAmount = result.amountOut ?? "0";

      recordTradePosition({
        walletId: wallet.id,
        coinAddress,
        isBuy,
        ethAmountWei: isBuy ? ethAmount : tokenAmount,
        tokenAmount: isBuy ? tokenAmount : ethAmount,
      });
    }

    return trade;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown swap error";
    return db.createTrade({
      walletId: wallet.id,
      fromToken: input.fromToken,
      toToken: input.toToken,
      amountIn: input.amountInWei.toString(),
      operationId: input.operationId ?? null,
      userOpHash: null,
      txHash: null,
      status: "failed",
      errorMessage: message,
    });
  }
}

export async function coordinatedSwap(input: {
  walletIds: number[];
  fromToken: `0x${string}`;
  toToken: `0x${string}`;
  /** Single amount applied to all wallets (ignored if amountsPerWallet provided) */
  amountInWei: bigint;
  /** Per-wallet amounts (overrides amountInWei). Must match walletIds length. */
  amountsPerWallet?: bigint[];
  slippageBps: number;
  concurrency?: number;
  operationId?: number | null;
}): Promise<TradeRecord[]> {
  if (input.walletIds.length === 0) {
    throw new Error("At least one wallet id is required.");
  }
  if (input.slippageBps < 1 || input.slippageBps > 2_000) {
    throw new Error("slippageBps must be between 1 and 2000.");
  }

  const amounts = input.amountsPerWallet ?? input.walletIds.map(() => input.amountInWei);
  if (amounts.length !== input.walletIds.length) {
    throw new Error("amountsPerWallet length must match walletIds length");
  }

  const limiter = pLimit(input.concurrency ?? 3);
  const tasks = input.walletIds.map((walletId, idx) =>
    limiter(() =>
      executeSingleSwap({
        walletId,
        fromToken: input.fromToken,
        toToken: input.toToken,
        amountInWei: amounts[idx]!,
        slippageBps: input.slippageBps,
        operationId: input.operationId,
      }),
    ),
  );

  return Promise.all(tasks);
}

export async function strategySwap(input: {
  walletIds: number[];
  fromToken: `0x${string}`;
  toToken: `0x${string}`;
  totalAmountInWei: bigint;
  slippageBps: number;
  mode: StrategyMode;
  waveSize?: number;
  maxDelayMs?: number;
  operationId?: number | null;
  /** Enable amount jiggle (default true). Set false for exact equal splits. */
  jiggle?: boolean;
  /** Jiggle variance factor (default 0.15 = ±15%). */
  jiggleFactor?: number;
}): Promise<TradeRecord[]> {
  if (!input.walletIds.length) throw new Error("At least one wallet id is required");
  if (input.totalAmountInWei <= 0n) throw new Error("totalAmountInWei must be > 0");
  if (input.slippageBps < 1 || input.slippageBps > 2_000) {
    throw new Error("slippageBps must be between 1 and 2000.");
  }

  const walletCount = input.walletIds.length;
  const useJiggle = input.jiggle !== false; // default on
  const amounts = useJiggle
    ? jiggleAmounts(input.totalAmountInWei, walletCount, input.jiggleFactor ?? 0.15)
    : Array.from({ length: walletCount }, () => input.totalAmountInWei / BigInt(walletCount));

  // Verify no zero amounts
  if (amounts.some((a) => a <= 0n)) {
    throw new Error("totalAmountInWei is too small for the selected wallet count");
  }

  if (input.mode === "sync") {
    return coordinatedSwap({
      walletIds: input.walletIds,
      fromToken: input.fromToken,
      toToken: input.toToken,
      amountInWei: 0n, // ignored when amountsPerWallet provided
      amountsPerWallet: amounts,
      slippageBps: input.slippageBps,
      concurrency: Math.min(6, walletCount),
      operationId: input.operationId,
    });
  }

  const ordered = shuffle(input.walletIds);
  // Re-shuffle amounts to match shuffled wallet order
  const shuffledAmounts = ordered.map((_, idx) => amounts[idx]!);
  const waveSize = Math.max(1, Math.min(10, input.waveSize ?? 3));
  const maxDelayMs = Math.max(100, input.maxDelayMs ?? 4000);

  const results: TradeRecord[] = [];
  for (let i = 0; i < ordered.length; i += waveSize) {
    const wave = ordered.slice(i, i + waveSize);
    const waveAmounts = shuffledAmounts.slice(i, i + waveSize);
    const waveResults = await Promise.all(
      wave.map(async (walletId, idx) => {
        const jitter = Math.floor(Math.random() * maxDelayMs);
        await sleep(jitter);
        return executeSingleSwap({
          walletId,
          fromToken: input.fromToken,
          toToken: input.toToken,
          amountInWei: waveAmounts[idx]!,
          slippageBps: input.slippageBps,
          operationId: input.operationId,
        });
      }),
    );
    results.push(...waveResults);
  }

  return results;
}

export function listTradeHistory(): TradeRecord[] {
  return db.listTrades();
}
