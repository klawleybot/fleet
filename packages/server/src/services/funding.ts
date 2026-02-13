import pLimit from "p-limit";
import { db } from "../db/index.js";
import { transferFromSmartAccount } from "./cdp.js";
import { ensureMasterWallet } from "./wallet.js";
import type { FundingRecord } from "../types.js";

export async function distributeFunding(input: {
  toWalletIds: number[];
  amountWei: bigint;
  concurrency?: number;
}): Promise<FundingRecord[]> {
  if (input.toWalletIds.length === 0) {
    throw new Error("At least one destination wallet id is required.");
  }
  if (input.amountWei <= 0n) {
    throw new Error("amountWei must be greater than 0.");
  }

  const masterWallet = await ensureMasterWallet();
  const destinations = input.toWalletIds.map((walletId) => {
    const wallet = db.getWalletById(walletId);
    if (!wallet) {
      throw new Error(`Destination wallet ${walletId} was not found.`);
    }
    if (wallet.isMaster) {
      throw new Error("Destination wallet cannot be the master wallet.");
    }
    return wallet;
  });

  const limiter = pLimit(input.concurrency ?? 3);
  const tasks = destinations.map((destination) =>
    limiter(async () => {
      try {
        const result = await transferFromSmartAccount({
          smartAccountName: masterWallet.cdpAccountName,
          to: destination.address,
          amountWei: input.amountWei,
        });

        return db.createFunding({
          fromWalletId: masterWallet.id,
          toWalletId: destination.id,
          amountWei: input.amountWei.toString(),
          userOpHash: result.userOpHash,
          txHash: result.txHash,
          status: result.status === "complete" ? "complete" : "failed",
          errorMessage: result.status === "complete" ? null : `Status ${result.status}`,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown transfer error";
        return db.createFunding({
          fromWalletId: masterWallet.id,
          toWalletId: destination.id,
          amountWei: input.amountWei.toString(),
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

export function listFundingHistory(): FundingRecord[] {
  return db.listFunding();
}

