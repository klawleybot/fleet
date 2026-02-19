import pLimit from "p-limit";
import { db } from "../db/index.js";
import { swapFromSmartAccount } from "./cdp.js";
import type { StrategyMode, TradeRecord } from "../types.js";

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

    return db.createTrade({
      walletId: wallet.id,
      fromToken: input.fromToken,
      toToken: input.toToken,
      amountIn: input.amountInWei.toString(),
      userOpHash: result.userOpHash,
      txHash: result.txHash,
      status: result.status === "complete" ? "complete" : "failed",
      errorMessage: result.status === "complete" ? null : `Status ${result.status}`,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown swap error";
    return db.createTrade({
      walletId: wallet.id,
      fromToken: input.fromToken,
      toToken: input.toToken,
      amountIn: input.amountInWei.toString(),
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
  amountInWei: bigint;
  slippageBps: number;
  concurrency?: number;
}): Promise<TradeRecord[]> {
  if (input.walletIds.length === 0) {
    throw new Error("At least one wallet id is required.");
  }
  if (input.amountInWei <= 0n) {
    throw new Error("amountInWei must be greater than 0.");
  }
  if (input.slippageBps < 1 || input.slippageBps > 2_000) {
    throw new Error("slippageBps must be between 1 and 2000.");
  }

  const limiter = pLimit(input.concurrency ?? 3);
  const tasks = input.walletIds.map((walletId) =>
    limiter(() =>
      executeSingleSwap({
        walletId,
        fromToken: input.fromToken,
        toToken: input.toToken,
        amountInWei: input.amountInWei,
        slippageBps: input.slippageBps,
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
}): Promise<TradeRecord[]> {
  if (!input.walletIds.length) throw new Error("At least one wallet id is required");
  if (input.totalAmountInWei <= 0n) throw new Error("totalAmountInWei must be > 0");
  if (input.slippageBps < 1 || input.slippageBps > 2_000) {
    throw new Error("slippageBps must be between 1 and 2000.");
  }

  const perWalletAmount = input.totalAmountInWei / BigInt(input.walletIds.length);
  if (perWalletAmount <= 0n) {
    throw new Error("totalAmountInWei is too small for the selected wallet count");
  }

  if (input.mode === "sync") {
    return coordinatedSwap({
      walletIds: input.walletIds,
      fromToken: input.fromToken,
      toToken: input.toToken,
      amountInWei: perWalletAmount,
      slippageBps: input.slippageBps,
      concurrency: Math.min(6, input.walletIds.length),
    });
  }

  const ordered = shuffle(input.walletIds);
  const waveSize = Math.max(1, Math.min(10, input.waveSize ?? 3));
  const maxDelayMs = Math.max(100, input.maxDelayMs ?? 4000);

  const results: TradeRecord[] = [];
  for (let i = 0; i < ordered.length; i += waveSize) {
    const wave = ordered.slice(i, i + waveSize);
    const waveResults = await Promise.all(
      wave.map(async (walletId) => {
        const jitter = Math.floor(Math.random() * maxDelayMs);
        await sleep(jitter);
        return executeSingleSwap({
          walletId,
          fromToken: input.fromToken,
          toToken: input.toToken,
          amountInWei: perWalletAmount,
          slippageBps: input.slippageBps,
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
