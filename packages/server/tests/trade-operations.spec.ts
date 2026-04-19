import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const tmpDirs: string[] = [];
const ENV_KEYS = [
  "VITEST",
  "VITEST_SQLITE_PATH",
  "SQLITE_PATH",
  "REQUIRE_WATCHLIST_COIN",
  "CLUSTER_COOLDOWN_SEC",
] as const;
const ORIGINAL_ENV = new Map<string, string | undefined>(
  ENV_KEYS.map((key) => [key, process.env[key]]),
);

const COIN = "0xea5cbc22df465e38b4d70262528b1814e0fe4015" as `0x${string}`;
const WETH = "0x4200000000000000000000000000000000000006" as `0x${string}`;

type DbModule = typeof import("../src/db/index.js");

let currentDbModule: DbModule | null = null;

function makeDbPath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-trade-ops-"));
  tmpDirs.push(dir);
  return path.join(dir, "test.sqlite");
}

function hexAddress(id: number): `0x${string}` {
  return `0x${id.toString(16).padStart(40, "0")}` as `0x${string}`;
}

function restoreEnv() {
  for (const key of ENV_KEYS) {
    const original = ORIGINAL_ENV.get(key);
    if (original === undefined) delete process.env[key];
    else process.env[key] = original;
  }
}

async function loadModules() {
  const dbPath = makeDbPath();

  vi.resetModules();

  process.env.VITEST = "1";
  process.env.VITEST_SQLITE_PATH = dbPath;
  process.env.SQLITE_PATH = dbPath;
  process.env.REQUIRE_WATCHLIST_COIN = "false";
  process.env.CLUSTER_COOLDOWN_SEC = "0";

  const strategySwap = vi.fn();
  const addToWatchlist = vi.fn();

  vi.doMock("../src/services/trade.js", () => ({
    strategySwap,
  }));
  vi.doMock("../src/services/zoraSignals.js", () => ({
    addToWatchlist,
    removeFromWatchlist: vi.fn(),
    selectSignalCoin: vi.fn(),
    topMovers: vi.fn(() => []),
    watchlistSignals: vi.fn(() => []),
    isCoinInWatchlist: vi.fn(() => true),
  }));

  const dbModule = await import("../src/db/index.js");
  currentDbModule = dbModule;
  const operationsModule = await import("../src/services/operations.js");

  return {
    db: dbModule.db,
    strategySwap,
    addToWatchlist,
    approveAndExecuteOperation: operationsModule.approveAndExecuteOperation,
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

describe("trade operations", () => {
  it("marks SUPPORT_COIN failed when any wallet trade fails", async () => {
    const { db, strategySwap, addToWatchlist, approveAndExecuteOperation } = await loadModules();

    const walletA = db.createWallet({
      name: "wallet-a",
      address: hexAddress(30),
      cdpAccountName: "wallet-a",
      ownerAddress: hexAddress(31),
      type: "smart",
      isMaster: false,
    });
    const walletB = db.createWallet({
      name: "wallet-b",
      address: hexAddress(32),
      cdpAccountName: "wallet-b",
      ownerAddress: hexAddress(33),
      type: "smart",
      isMaster: false,
    });
    const cluster = db.createCluster({ name: "cluster-buy", strategyMode: "sync" });
    db.setClusterWallets(cluster.id, [walletA.id, walletB.id]);

    const operation = db.createOperation({
      type: "SUPPORT_COIN",
      clusterId: cluster.id,
      payloadJson: JSON.stringify({
        coinAddress: COIN,
        totalAmountWei: "1000",
        slippageBps: 300,
        strategyMode: "sync",
      }),
    });

    strategySwap.mockResolvedValue([
      {
        id: 1,
        walletId: walletA.id,
        fromToken: WETH,
        toToken: COIN,
        amountIn: "500",
        amountOut: "1000",
        operationId: operation.id,
        userOpHash: null,
        txHash: null,
        status: "complete",
        errorMessage: null,
        createdAt: new Date().toISOString(),
      },
      {
        id: 2,
        walletId: walletB.id,
        fromToken: WETH,
        toToken: COIN,
        amountIn: "500",
        amountOut: null,
        operationId: operation.id,
        userOpHash: null,
        txHash: null,
        status: "failed",
        errorMessage: "quote reverted",
        createdAt: new Date().toISOString(),
      },
    ]);

    const result = await approveAndExecuteOperation({
      operationId: operation.id,
      approvedBy: "test-runner",
    });

    expect(result.status).toBe("failed");
    expect(result.errorMessage).toContain(`walletId=${walletB.id}`);
    expect(result.errorMessage).toContain("Trade failed for 1/2 wallet(s)");
    expect(addToWatchlist).toHaveBeenCalledWith(COIN, expect.objectContaining({
      label: "fleet-tracked",
    }));
  });
});
