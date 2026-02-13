import pLimit from "p-limit";
import { db } from "../db/index.js";
import { swapFromSmartAccount } from "./cdp.js";
import type { TradeRecord } from "../types.js";

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

  const wallets = input.walletIds.map((walletId) => {
    const wallet = db.getWalletById(walletId);
    if (!wallet) {
      throw new Error(`Wallet ${walletId} was not found.`);
    }
    return wallet;
  });

  const limiter = pLimit(input.concurrency ?? 3);
  const tasks = wallets.map((wallet) =>
    limiter(async () => {
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
    }),
  );

  return Promise.all(tasks);
}

export function listTradeHistory(): TradeRecord[] {
  return db.listTrades();
}

