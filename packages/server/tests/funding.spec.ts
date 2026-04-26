import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WalletRecord } from "../src/types.js";

const tmpDirs: string[] = [];
const ENV_KEYS = [
  "VITEST",
  "VITEST_SQLITE_PATH",
  "SQLITE_PATH",
  "FUNDING_MAX_ATTEMPTS",
  "FUNDING_RETRY_BASE_MS",
  "FUNDING_RATE_LIMIT_BASE_MS",
  "FUNDING_RETRY_MAX_MS",
  "REQUIRE_WATCHLIST_COIN",
  "CLUSTER_COOLDOWN_SEC",
] as const;
const ORIGINAL_ENV = new Map<string, string | undefined>(
  ENV_KEYS.map((key) => [key, process.env[key]]),
);

type DbModule = typeof import("../src/db/index.js");

let currentDbModule: DbModule | null = null;

function makeDbPath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-funding-"));
  tmpDirs.push(dir);
  return path.join(dir, "test.sqlite");
}

function hexAddress(id: number): `0x${string}` {
  return `0x${id.toString(16).padStart(40, "0")}` as `0x${string}`;
}

function hexHash(char: string): `0x${string}` {
  return `0x${char.repeat(64)}` as `0x${string}`;
}

function restoreEnv() {
  for (const key of ENV_KEYS) {
    const original = ORIGINAL_ENV.get(key);
    if (original === undefined) delete process.env[key];
    else process.env[key] = original;
  }
}

async function loadModules(options: {
  transferImpl: () => Promise<{
    userOpHash: `0x${string}` | null;
    txHash: `0x${string}` | null;
    status: "pending" | "complete" | "failed";
  }>;
  fundingMaxAttempts?: string;
  fundingRetryBaseMs?: string;
  fundingRateLimitBaseMs?: string;
  fundingRetryMaxMs?: string;
}) {
  const dbPath = makeDbPath();

  vi.resetModules();

  process.env.VITEST = "1";
  process.env.VITEST_SQLITE_PATH = dbPath;
  process.env.SQLITE_PATH = dbPath;
  process.env.FUNDING_MAX_ATTEMPTS = options.fundingMaxAttempts ?? "3";
  process.env.FUNDING_RETRY_BASE_MS = options.fundingRetryBaseMs ?? "0";
  process.env.FUNDING_RATE_LIMIT_BASE_MS = options.fundingRateLimitBaseMs ?? "0";
  process.env.FUNDING_RETRY_MAX_MS = options.fundingRetryMaxMs ?? "0";
  process.env.REQUIRE_WATCHLIST_COIN = "false";
  process.env.CLUSTER_COOLDOWN_SEC = "0";

  let masterWallet: WalletRecord | null = null;
  const transferFromSmartAccount = vi.fn(options.transferImpl);

  vi.doMock("../src/services/cdp.js", () => ({
    getSignerBackendInfo: () => ({ backend: "cdp" }),
    transferFromOwnerAccount: vi.fn(),
    transferFromSmartAccount,
  }));
  vi.doMock("../src/services/wallet.js", () => ({
    ensureMasterWallet: vi.fn(async () => {
      if (!masterWallet) throw new Error("master wallet not seeded");
      return masterWallet;
    }),
  }));
  vi.doMock("../src/services/balance.js", () => ({
    getEthBalance: vi.fn(async () => 0n),
  }));
  vi.doMock("../src/services/trade.js", () => ({
    strategySwap: vi.fn(),
  }));
  vi.doMock("../src/services/zoraSignals.js", () => ({
    addToWatchlist: vi.fn(),
    removeFromWatchlist: vi.fn(),
    selectSignalCoin: vi.fn(),
    topMovers: vi.fn(() => []),
    watchlistSignals: vi.fn(() => []),
    isCoinInWatchlist: vi.fn(() => true),
  }));

  const dbModule = await import("../src/db/index.js");
  currentDbModule = dbModule;
  masterWallet = dbModule.db.createWallet({
    name: "master-wallet",
    address: hexAddress(1),
    cdpAccountName: "master-wallet",
    ownerAddress: hexAddress(2),
    type: "smart",
    isMaster: true,
  });

  const fundingModule = await import("../src/services/funding.js");
  const operationsModule = await import("../src/services/operations.js");

  return {
    db: dbModule.db,
    distributeFunding: fundingModule.distributeFunding,
    approveAndExecuteOperation: operationsModule.approveAndExecuteOperation,
    transferFromSmartAccount,
  };
}

afterEach(() => {
  currentDbModule?.resetDb();
  currentDbModule = null;
  vi.restoreAllMocks();
  restoreEnv();
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("funding retries", () => {
  it("retries Pimlico-style 429s and respects Retry-After=0", async () => {
    let attempts = 0;
    const { db, distributeFunding, transferFromSmartAccount } = await loadModules({
      transferImpl: async () => {
        attempts += 1;
        if (attempts === 1) {
          const error = Object.assign(new Error("429 too many requests"), {
            response: {
              headers: {
                get: (name: string) => (name.toLowerCase() === "retry-after" ? "0" : null),
              },
            },
          });
          throw error;
        }

        return {
          userOpHash: hexHash("a"),
          txHash: hexHash("b"),
          status: "complete" as const,
        };
      },
      fundingMaxAttempts: "2",
      fundingRateLimitBaseMs: "2500",
      fundingRetryMaxMs: "2500",
    });

    const destination = db.createWallet({
      name: "wallet-1",
      address: hexAddress(10),
      cdpAccountName: "wallet-1",
      ownerAddress: hexAddress(11),
      type: "smart",
      isMaster: false,
    });

    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const records = await distributeFunding({
      toWalletIds: [destination.id],
      amountWei: 1000n,
    });

    expect(records).toHaveLength(1);
    expect(records[0]?.status).toBe("complete");
    expect(records[0]?.txHash).toBe(hexHash("b"));
    expect(transferFromSmartAccount).toHaveBeenCalledTimes(2);
    expect(setTimeoutSpy).not.toHaveBeenCalled();
  });

  it("fails the funding operation only after a wallet exhausts its retries", async () => {
    let callCount = 0;
    const { db, approveAndExecuteOperation, transferFromSmartAccount } = await loadModules({
      transferImpl: async () => {
        callCount += 1;
        if (callCount === 1) {
          return {
            userOpHash: hexHash("c"),
            txHash: hexHash("d"),
            status: "complete" as const,
          };
        }

        throw new Error("429 too many requests");
      },
      fundingMaxAttempts: "2",
    });

    const walletA = db.createWallet({
      name: "wallet-a",
      address: hexAddress(20),
      cdpAccountName: "wallet-a",
      ownerAddress: hexAddress(21),
      type: "smart",
      isMaster: false,
    });
    const walletB = db.createWallet({
      name: "wallet-b",
      address: hexAddress(22),
      cdpAccountName: "wallet-b",
      ownerAddress: hexAddress(23),
      type: "smart",
      isMaster: false,
    });
    const cluster = db.createCluster({ name: "cluster-a", strategyMode: "sync" });
    db.setClusterWallets(cluster.id, [walletA.id, walletB.id]);
    const operation = db.createOperation({
      type: "FUNDING_REQUEST",
      clusterId: cluster.id,
      payloadJson: JSON.stringify({ amountWei: "1000" }),
    });

    const result = await approveAndExecuteOperation({
      operationId: operation.id,
      approvedBy: "test-runner",
    });

    expect(result.status).toBe("failed");
    expect(result.errorMessage).toContain(`walletId=${walletB.id}`);
    expect(result.errorMessage).toContain("Funding failed for 1/2 wallet(s)");
    expect(transferFromSmartAccount).toHaveBeenCalledTimes(3);

    const funding = db.listFunding();
    expect(funding).toHaveLength(2);
    expect(funding.find((record) => record.toWalletId === walletA.id)?.status).toBe("complete");

    const failedRecord = funding.find((record) => record.toWalletId === walletB.id);
    expect(failedRecord?.status).toBe("failed");
    expect(failedRecord?.errorMessage).toContain("Funding failed after 2 attempt(s)");
  });
});
