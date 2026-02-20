import pLimit from "p-limit";
import { db } from "../db/index.js";
import { getSignerBackendInfo, transferFromOwnerAccount, transferFromSmartAccount } from "./cdp.js";
import { ensureMasterWallet } from "./wallet.js";
import { getEthBalance } from "./balance.js";
import type { FundingRecord } from "../types.js";

function parseWeiEnv(name: string, fallback: bigint): bigint {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  try {
    const value = BigInt(raw);
    if (value < 0n) throw new Error("negative");
    return value;
  } catch {
    throw new Error(`${name} must be a non-negative integer string`);
  }
}

export function getWalletBootstrapWei(): bigint {
  return parseWeiEnv("WALLET_BOOTSTRAP_WEI", 0n);
}

export function getWalletMinBalanceWei(): bigint {
  return parseWeiEnv("WALLET_MIN_BALANCE_WEI", 0n);
}

export async function bootstrapFleetFunding(input?: {
  walletIds?: number[];
  amountWei?: bigint;
}): Promise<FundingRecord[]> {
  const amountWei = input?.amountWei ?? getWalletBootstrapWei();
  if (amountWei <= 0n) return [];

  const walletIds =
    input?.walletIds ??
    db
      .listWallets()
      .filter((wallet) => !wallet.isMaster)
      .map((wallet) => wallet.id);

  if (!walletIds.length) return [];

  const records = await distributeFunding({
    toWalletIds: walletIds,
    amountWei,
  });

  const failures = records.filter((record) => record.status !== "complete");
  if (failures.length) {
    const detail = failures
      .map((f) => `walletId=${f.toWalletId}: ${f.errorMessage ?? "unknown error"}`)
      .join("; ");
    throw new Error(`Bootstrap funding failed for ${failures.length}/${records.length} wallet(s): ${detail}`);
  }

  return records;
}

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
  const minBalanceWei = getWalletMinBalanceWei();
  const candidates = input.toWalletIds.map((walletId) => {
    const wallet = db.getWalletById(walletId);
    if (!wallet) {
      throw new Error(`Destination wallet ${walletId} was not found.`);
    }
    if (wallet.isMaster) {
      throw new Error("Destination wallet cannot be the master wallet.");
    }
    return wallet;
  });

  const destinations: typeof candidates = [];
  for (const wallet of candidates) {
    if (minBalanceWei > 0n) {
      const currentBalance = await getEthBalance(wallet.address);
      if (currentBalance >= minBalanceWei) {
        continue;
      }
    }
    destinations.push(wallet);
  }

  if (!destinations.length) {
    return [];
  }

  const backend = getSignerBackendInfo().backend;
  const effectiveConcurrency = backend === "local" ? 1 : (input.concurrency ?? 3);
  const limiter = pLimit(effectiveConcurrency);
  const tasks = destinations.map((destination) =>
    limiter(async () => {
      try {
        const useOwnerForLocal = process.env.FUNDING_LOCAL_SOURCE?.trim().toLowerCase() === "owner";
        const result =
          backend === "local" && useOwnerForLocal
            ? await transferFromOwnerAccount({
                ownerName: masterWallet.cdpAccountName,
                to: destination.address,
                amountWei: input.amountWei,
              })
            : await transferFromSmartAccount({
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

