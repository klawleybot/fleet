import pLimit from "p-limit";
import { db } from "../db/index.js";
import { classifyBundlerError } from "./bundler/errors.js";
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

function parseIntEnv(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  return value;
}

function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
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
  if (typeof headers === "object" && headers !== null && "get" in headers && typeof headers.get === "function") {
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

function shouldRetryFundingError(error: unknown): boolean {
  const { category } = classifyBundlerError(error);
  return category === "retryable" || category === "rate_limit" || category === "underpriced";
}

function getFundingRetryDelayMs(error: unknown, attempt: number): number {
  const baseMs = parseIntEnv("FUNDING_RETRY_BASE_MS", 750);
  const rateLimitBaseMs = parseIntEnv("FUNDING_RATE_LIMIT_BASE_MS", 2_500);
  const maxMs = parseIntEnv("FUNDING_RETRY_MAX_MS", 15_000);
  const { category } = classifyBundlerError(error);

  const retryAfterMs = getRetryAfterMs(error);
  if (retryAfterMs !== null) {
    return Math.min(maxMs, Math.max(0, retryAfterMs));
  }

  const base = category === "rate_limit" ? rateLimitBaseMs : baseMs;
  return Math.min(maxMs, base * 2 ** Math.max(0, attempt - 1));
}

function summarizeFundingFailure(record: FundingRecord): string {
  return `walletId=${record.toWalletId}: ${record.errorMessage ?? "unknown error"}`;
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
    const detail = failures.map(summarizeFundingFailure).join("; ");
    throw new Error(`Bootstrap funding failed for ${failures.length}/${records.length} wallet(s): ${detail}`);
  }

  return records;
}

export async function distributeFunding(input: {
  toWalletIds: number[];
  amountWei: bigint;
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
  const useOwnerForLocal = process.env.FUNDING_LOCAL_SOURCE?.trim().toLowerCase() === "owner";
  // Funding from a single source account is serialized to avoid nonce / bundler races.
  const effectiveConcurrency = 1;
  const limiter = pLimit(effectiveConcurrency);
  const maxAttempts = Math.max(1, parseIntEnv("FUNDING_MAX_ATTEMPTS", 4));
  const tasks = destinations.map((destination) =>
    limiter(async () => {
      let lastError: unknown = null;

      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        try {
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
          lastError = error;
          if (!shouldRetryFundingError(error) || attempt >= maxAttempts) {
            break;
          }

          await sleep(getFundingRetryDelayMs(error, attempt));
        }
      }

      const message = lastError instanceof Error ? lastError.message : "Unknown transfer error";
      return db.createFunding({
        fromWalletId: masterWallet.id,
        toWalletId: destination.id,
        amountWei: input.amountWei.toString(),
        userOpHash: null,
        txHash: null,
        status: "failed",
        errorMessage: `Funding failed after ${maxAttempts} attempt(s): ${message}`,
      });
    }),
  );

  return Promise.all(tasks);
}

export function listFundingHistory(): FundingRecord[] {
  return db.listFunding();
}
