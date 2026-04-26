import pLimit from "p-limit";
import { db } from "../db/index.js";
import { swapFromSmartAccount } from "./cdp.js";
import { classifyBundlerError } from "./bundler/errors.js";
import { recordTradePosition } from "./monitor.js";
import { getWalletBudgets } from "./balance.js";
import { isSlippageFailureMessage } from "./swapFailure.js";
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

function parseIntEnv(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function hasHeaderGetter(value: unknown): value is { get(name: string): unknown } {
  return isRecord(value) && typeof value.get === "function";
}

function parseRetryAfterHeader(value: string): number | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const seconds = Number(trimmed);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.round(seconds * 1000);
  }
  const absolute = Date.parse(trimmed);
  if (Number.isNaN(absolute)) return null;
  return Math.max(0, absolute - Date.now());
}

function getHeaderValue(headers: unknown, name: string): string | null {
  if (!headers) return null;
  if (hasHeaderGetter(headers)) {
    const value = headers.get(name) ?? headers.get(name.toLowerCase());
    return typeof value === "string" ? value : null;
  }
  if (!isRecord(headers)) return null;
  const match = Object.entries(headers).find(([key]) => key.toLowerCase() === name.toLowerCase());
  return typeof match?.[1] === "string" ? match[1] : null;
}

function getRetryAfterMs(error: unknown, depth = 0): number | null {
  if (depth > 4 || !isRecord(error)) return null;

  if (typeof error.retryAfterMs === "number" && Number.isFinite(error.retryAfterMs) && error.retryAfterMs >= 0) {
    return Math.round(error.retryAfterMs);
  }
  if (typeof error.retryAfter === "number" && Number.isFinite(error.retryAfter) && error.retryAfter >= 0) {
    return Math.round(error.retryAfter * 1000);
  }
  if (typeof error.retryAfter === "string") {
    return parseRetryAfterHeader(error.retryAfter);
  }

  const responseHeaders =
    (isRecord(error.response) ? getHeaderValue(error.response.headers, "retry-after") : null) ??
    getHeaderValue(error.response, "retry-after");
  if (responseHeaders) {
    return parseRetryAfterHeader(responseHeaders);
  }

  const headersValue = getHeaderValue(error.headers, "retry-after");
  if (headersValue) {
    return parseRetryAfterHeader(headersValue);
  }

  return getRetryAfterMs(error.cause, depth + 1);
}

function shouldRetryTradeMessage(message: string | null | undefined): boolean {
  if (!message) return false;
  if (isSlippageFailureMessage(message)) return true;
  const { category } = classifyBundlerError(new Error(message));
  return category === "retryable" || category === "rate_limit" || category === "underpriced";
}

function shouldRetryTradeError(error: unknown): boolean {
  if (error instanceof Error && isSlippageFailureMessage(error.message)) return true;
  const { category } = classifyBundlerError(error);
  return category === "retryable" || category === "rate_limit" || category === "underpriced";
}

function getTradeRetryDelayMs(error: unknown, attempt: number): number {
  const baseMs = parseIntEnv("TRADE_RETRY_BASE_MS", 750);
  const rateLimitBaseMs = parseIntEnv("TRADE_RATE_LIMIT_BASE_MS", 2_500);
  const maxMs = parseIntEnv("TRADE_RETRY_MAX_MS", 10_000);
  const retryAfterMs = getRetryAfterMs(error);
  if (retryAfterMs !== null) {
    return Math.min(maxMs, Math.max(0, retryAfterMs));
  }

  const { category } = classifyBundlerError(error);
  const base = category === "rate_limit" ? rateLimitBaseMs : baseMs;
  return Math.min(maxMs, base * 2 ** Math.max(0, attempt - 1));
}

function compareSwapEntries(
  a: { walletId: number; amountInWei: bigint },
  b: { walletId: number; amountInWei: bigint },
): number {
  if (a.amountInWei < b.amountInWei) return -1;
  if (a.amountInWei > b.amountInWei) return 1;
  return a.walletId - b.walletId;
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

  const maxAttempts = Math.max(1, parseIntEnv("TRADE_MAX_ATTEMPTS", 2));

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const result = await swapFromSmartAccount({
        smartAccountName: wallet.cdpAccountName,
        fromToken: input.fromToken,
        toToken: input.toToken,
        fromAmount: input.amountInWei,
        slippageBps: input.slippageBps,
      });

      if (result.status === "complete") {
        const trade = db.createTrade({
          walletId: wallet.id,
          fromToken: input.fromToken,
          toToken: input.toToken,
          amountIn: input.amountInWei.toString(),
          amountOut: result.amountOut ?? null,
          operationId: input.operationId ?? null,
          userOpHash: result.userOpHash,
          txHash: result.txHash,
          status: "complete",
          errorMessage: null,
        });

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

        return trade;
      }

      const failureMessage = result.errorMessage ?? `Status ${result.status}`;
      if (!shouldRetryTradeMessage(failureMessage) || attempt >= maxAttempts) {
        return db.createTrade({
          walletId: wallet.id,
          fromToken: input.fromToken,
          toToken: input.toToken,
          amountIn: input.amountInWei.toString(),
          amountOut: null,
          operationId: input.operationId ?? null,
          userOpHash: result.userOpHash,
          txHash: result.txHash,
          status: "failed",
          errorMessage:
            attempt > 1
              ? `Trade failed after ${attempt} attempt(s): ${failureMessage}`
              : failureMessage,
        });
      }

      await sleep(getTradeRetryDelayMs(new Error(failureMessage), attempt));
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown swap error";
      if (!shouldRetryTradeError(error) || attempt >= maxAttempts) {
        return db.createTrade({
          walletId: wallet.id,
          fromToken: input.fromToken,
          toToken: input.toToken,
          amountIn: input.amountInWei.toString(),
          amountOut: null,
          operationId: input.operationId ?? null,
          userOpHash: null,
          txHash: null,
          status: "failed",
          errorMessage:
            attempt > 1
              ? `Trade failed after ${attempt} attempt(s): ${message}`
              : message,
        });
      }

      await sleep(getTradeRetryDelayMs(error, attempt));
    }
  }

  throw new Error("Trade failed without a terminal result");
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

  const entries = input.walletIds.map((walletId, idx) => ({
    walletId,
    amountInWei: amounts[idx]!,
  }));
  const orderedEntries = isEthLike(input.fromToken) ? [...entries].sort(compareSwapEntries) : entries;
  const limiter = pLimit(isEthLike(input.fromToken) ? 1 : (input.concurrency ?? 3));
  const tasks = orderedEntries.map((entry) =>
    limiter(() =>
      executeSingleSwap({
        walletId: entry.walletId,
        fromToken: input.fromToken,
        toToken: input.toToken,
        amountInWei: entry.amountInWei,
        slippageBps: input.slippageBps,
        operationId: input.operationId ?? null,
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

  const isBuy = isEthLike(input.fromToken);
  const isSell = !isBuy;
  const isMockMode = process.env.CDP_MOCK_MODE === "1";

  // ---- Pre-flight holdings check for sells ----
  // Only include wallets that actually hold tokens. Skips dust wallets
  // and wallets already fully sold, avoiding wasted UserOp attempts.
  const MIN_SELL_HOLDINGS = 100n; // skip wallets with fewer tokens than this
  let eligibleWalletIds = input.walletIds;
  if (isSell && !isMockMode) {
    const coinAddress = input.fromToken.toLowerCase();
    const withHoldings: Array<{ walletId: number; holdings: bigint }> = [];

    for (const wid of input.walletIds) {
      const positions = db.listPositionsByWallet(wid);
      const pos = positions.find((p) => p.coinAddress.toLowerCase() === coinAddress);
      const holdings = pos ? BigInt(pos.holdingsRaw) : 0n;
      if (holdings >= MIN_SELL_HOLDINGS) {
        withHoldings.push({ walletId: wid, holdings });
      }
    }

    if (withHoldings.length === 0) {
      throw new Error(
        `No wallets hold sufficient tokens to sell. ` +
        `${input.walletIds.length} wallets checked, 0 above ${MIN_SELL_HOLDINGS} threshold`
      );
    }

    eligibleWalletIds = withHoldings.map((w) => w.walletId);

    // Cap total sell amount to what wallets actually hold
    const totalHoldings = withHoldings.reduce((sum, w) => sum + w.holdings, 0n);
    const cappedAmount = totalHoldings < input.totalAmountInWei ? totalHoldings : input.totalAmountInWei;

    input = { ...input, totalAmountInWei: cappedAmount, walletIds: eligibleWalletIds };
  }

  // ---- Pre-flight balance check for buys ----
  // Only trade with wallets that have enough ETH for their share.
  // Skip in mock mode (tests) since mock wallets have no real balance.
  if (isBuy && !isMockMode) {
    const walletRows = input.walletIds.map((id) => {
      const w = db.getWalletById(id);
      if (!w) throw new Error(`Wallet ${id} not found`);
      return { id: w.id, address: w.address };
    });

    const budgets = await getWalletBudgets(walletRows);
    const perWalletTarget = input.totalAmountInWei / BigInt(input.walletIds.length);

    // Wallet must have at least its per-wallet share to participate.
    // This prevents submitting UserOps that will revert due to insufficient balance.
    const eligible = budgets.wallets.filter((w) => w.balance >= perWalletTarget);

    if (eligible.length === 0) {
      // Calculate the actual max any wallet could trade
      const maxBalance = budgets.wallets.reduce((max, w) => w.balance > max ? w.balance : max, 0n);
      throw new Error(
        `No wallets have sufficient ETH for buy. ` +
        `Need ${perWalletTarget} wei/wallet, max balance is ${maxBalance} wei. ` +
        `${budgets.fundedCount}/${budgets.wallets.length} above dust, ` +
        `0/${budgets.wallets.length} above trade threshold`
      );
    }

    eligibleWalletIds = eligible.map((w) => w.walletId);

    // Cap total to what eligible wallets can actually spend
    const eligibleBudget = eligible.reduce((sum, w) => sum + w.balance, 0n);
    const cappedAmount = eligibleBudget < input.totalAmountInWei
      ? eligibleBudget
      : input.totalAmountInWei;

    input = { ...input, totalAmountInWei: cappedAmount, walletIds: eligibleWalletIds };
  }

  const walletCount = eligibleWalletIds.length;
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
      walletIds: eligibleWalletIds,
      fromToken: input.fromToken,
      toToken: input.toToken,
      amountInWei: 0n, // ignored when amountsPerWallet provided
      amountsPerWallet: amounts,
      slippageBps: input.slippageBps,
      concurrency: Math.min(6, walletCount),
      operationId: input.operationId ?? null,
    });
  }

  const shuffledEntries = shuffle(
    eligibleWalletIds.map((walletId, idx) => ({
      walletId,
      amountInWei: amounts[idx]!,
    })),
  );
  const waveSize = Math.max(1, Math.min(10, input.waveSize ?? 3));
  const maxDelayMs = Math.max(100, input.maxDelayMs ?? 4000);

  const results: TradeRecord[] = [];
  for (let i = 0; i < shuffledEntries.length; i += waveSize) {
    const wave = shuffledEntries.slice(i, i + waveSize);
    if (isBuy) {
      const orderedWave = [...wave].sort(compareSwapEntries);
      for (const entry of orderedWave) {
        const jitter = Math.floor(Math.random() * maxDelayMs);
        await sleep(jitter);
        results.push(await executeSingleSwap({
          walletId: entry.walletId,
          fromToken: input.fromToken,
          toToken: input.toToken,
          amountInWei: entry.amountInWei,
          slippageBps: input.slippageBps,
          operationId: input.operationId ?? null,
        }));
      }
      continue;
    }

    const waveResults = await Promise.all(
      wave.map(async (entry) => {
        const jitter = Math.floor(Math.random() * maxDelayMs);
        await sleep(jitter);
        return executeSingleSwap({
          walletId: entry.walletId,
          fromToken: input.fromToken,
          toToken: input.toToken,
          amountInWei: entry.amountInWei,
          slippageBps: input.slippageBps,
          operationId: input.operationId ?? null,
        });
      }),
    );
    results.push(...waveResults);
  }

  return results;
}

// ---------------------------------------------------------------------------
// Temporal Streaming (drip) — spread buys/sells over time
// ---------------------------------------------------------------------------

/**
 * Schedule for a single drip event: which wallet, how much, when.
 */
interface DripEvent {
  walletId: number;
  amount: bigint;
  /** Delay from operation start in ms */
  delayMs: number;
}

/**
 * Build a drip schedule: distribute each wallet's total amount into
 * `intervals` sub-trades spread over `durationMs` with randomized timing.
 */
export function buildDripSchedule(params: {
  walletIds: number[];
  amounts: bigint[];
  durationMs: number;
  intervals: number;
  jiggle?: boolean;
  jiggleFactor?: number;
}): DripEvent[] {
  const { walletIds, amounts, durationMs, intervals } = params;
  const useJiggle = params.jiggle !== false;
  const factor = params.jiggleFactor ?? 0.1;

  const events: DripEvent[] = [];

  for (let w = 0; w < walletIds.length; w++) {
    const walletId = walletIds[w]!;
    const walletTotal = amounts[w]!;

    // Split wallet's amount into intervals
    const subAmounts = useJiggle
      ? jiggleAmounts(walletTotal, intervals, factor)
      : Array.from({ length: intervals }, (_, i) => {
          const base = walletTotal / BigInt(intervals);
          return i === intervals - 1
            ? walletTotal - base * BigInt(intervals - 1)
            : base;
        });

    for (let i = 0; i < intervals; i++) {
      // Spread evenly with random jitter within each time slot
      const slotStart = (durationMs / intervals) * i;
      const slotEnd = (durationMs / intervals) * (i + 1);
      const delayMs = Math.floor(slotStart + Math.random() * (slotEnd - slotStart));

      events.push({
        walletId,
        amount: subAmounts[i]!,
        delayMs,
      });
    }
  }

  // Sort by delay so we execute in chronological order
  events.sort((a, b) => a.delayMs - b.delayMs);
  return events;
}

/**
 * Execute a drip (temporal streaming) swap — buys/sells spread over durationMs.
 *
 * Each wallet makes `intervals` sub-trades at randomized times within the duration.
 * Supports jiggle on sub-trade amounts.
 */
/** Gas reserve per wallet — disabled (paymaster covers gas). */
export const DEFAULT_GAS_RESERVE_WEI = 0n;

export async function dripSwap(input: {
  walletIds: number[];
  fromToken: `0x${string}`;
  toToken: `0x${string}`;
  totalAmountInWei: bigint;
  slippageBps: number;
  durationMs: number;
  /** Number of sub-trades per wallet (default: auto-calculated) */
  intervals?: number;
  jiggle?: boolean;
  jiggleFactor?: number;
  operationId?: number | null;
  /** Per-wallet gas reserve subtracted from buy amount (default 0, paymaster covers gas). */
  gasReservePerWallet?: bigint;
}): Promise<TradeRecord[]> {
  const walletCount = input.walletIds.length;
  const durationMs = Math.max(1000, input.durationMs);

  // Default intervals: ~1 per 30 seconds, min 2, max 20
  const autoIntervals = Math.max(2, Math.min(20, Math.floor(durationMs / 30_000)));
  const intervals = input.intervals ?? autoIntervals;

  // Subtract gas reserve from total (for buys, ensures ETH left for future sells)
  const gasReserve = input.gasReservePerWallet ?? DEFAULT_GAS_RESERVE_WEI;
  const totalGasReserve = gasReserve * BigInt(walletCount);
  const effectiveTotal = input.totalAmountInWei > totalGasReserve
    ? input.totalAmountInWei - totalGasReserve
    : input.totalAmountInWei; // don't go negative; caller should have checked

  if (gasReserve > 0n && effectiveTotal < input.totalAmountInWei) {
    const reservedEth = Number(totalGasReserve) / 1e18;
    const perWalletReserveEth = Number(gasReserve) / 1e18;
    const effectiveEth = Number(effectiveTotal) / 1e18;
    console.warn(
      `Gas reserve: ${reservedEth.toFixed(4)} ETH (${walletCount} × ${perWalletReserveEth.toFixed(4)})`,
    );
    console.warn(`Effective buy: ${effectiveEth.toFixed(4)} ETH`);
  }

  // Distribute effective total across wallets (with outer jiggle)
  const walletAmounts = input.jiggle !== false
    ? jiggleAmounts(effectiveTotal, walletCount, input.jiggleFactor ?? 0.15)
    : Array.from({ length: walletCount }, () =>
        effectiveTotal / BigInt(walletCount),
      );

  const schedule = buildDripSchedule({
    walletIds: input.walletIds,
    amounts: walletAmounts,
    durationMs,
    intervals,
    ...(input.jiggle != null && { jiggle: input.jiggle }),
    jiggleFactor: input.jiggleFactor ?? 0.1, // tighter jiggle on sub-trades
  });

  const results: TradeRecord[] = [];
  const startTime = Date.now();

  for (const event of schedule) {
    // Wait until it's time for this event
    const elapsed = Date.now() - startTime;
    const waitMs = event.delayMs - elapsed;
    if (waitMs > 0) {
      await sleep(waitMs);
    }

    const result = await executeSingleSwap({
      walletId: event.walletId,
      fromToken: input.fromToken,
      toToken: input.toToken,
      amountInWei: event.amount,
      slippageBps: input.slippageBps,
      operationId: input.operationId ?? null,
    });
    results.push(result);
  }

  return results;
}

export function listTradeHistory(): TradeRecord[] {
  return db.listTrades();
}
