import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const tmpDirs: string[] = [];
const ENV_KEYS = [
  "VITEST",
  "VITEST_SQLITE_PATH",
  "SQLITE_PATH",
  "TRADE_MAX_ATTEMPTS",
  "TRADE_RETRY_BASE_MS",
  "TRADE_RATE_LIMIT_BASE_MS",
  "TRADE_RETRY_MAX_MS",
] as const;
const ORIGINAL_ENV = new Map<string, string | undefined>(
  ENV_KEYS.map((key) => [key, process.env[key]]),
);

const COIN = "0xea5cbc22df465e38b4d70262528b1814e0fe4015" as `0x${string}`;
const WETH = "0x4200000000000000000000000000000000000006" as `0x${string}`;

type DbModule = typeof import("../src/db/index.js");

let currentDbModule: DbModule | null = null;

function makeDbPath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-trade-"));
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
  swapImpl: (input: {
    smartAccountName: string;
    fromToken: `0x${string}`;
    toToken: `0x${string}`;
    fromAmount: bigint;
    slippageBps: number;
  }) => Promise<{
    userOpHash: `0x${string}` | null;
    txHash: `0x${string}` | null;
    status: "pending" | "complete" | "failed";
    amountOut?: string;
    errorMessage?: string;
  }>;
  tradeMaxAttempts?: string;
  tradeRetryBaseMs?: string;
  tradeRateLimitBaseMs?: string;
  tradeRetryMaxMs?: string;
}) {
  const dbPath = makeDbPath();

  vi.resetModules();

  process.env.VITEST = "1";
  process.env.VITEST_SQLITE_PATH = dbPath;
  process.env.SQLITE_PATH = dbPath;
  process.env.TRADE_MAX_ATTEMPTS = options.tradeMaxAttempts ?? "2";
  process.env.TRADE_RETRY_BASE_MS = options.tradeRetryBaseMs ?? "0";
  process.env.TRADE_RATE_LIMIT_BASE_MS = options.tradeRateLimitBaseMs ?? "0";
  process.env.TRADE_RETRY_MAX_MS = options.tradeRetryMaxMs ?? "0";

  const swapFromSmartAccount = vi.fn(options.swapImpl);
  const recordTradePosition = vi.fn();

  vi.doMock("../src/services/cdp.js", () => ({
    swapFromSmartAccount,
  }));
  vi.doMock("../src/services/monitor.js", () => ({
    recordTradePosition,
  }));
  vi.doMock("../src/services/balance.js", () => ({
    getWalletBudgets: vi.fn(async (walletRows: Array<{ id: number }>) => ({
      fundedCount: walletRows.length,
      wallets: walletRows.map((wallet) => ({
        walletId: wallet.id,
        balance: 10n ** 18n,
      })),
    })),
  }));

  const dbModule = await import("../src/db/index.js");
  currentDbModule = dbModule;
  const tradeModule = await import("../src/services/trade.js");

  return {
    db: dbModule.db,
    coordinatedSwap: tradeModule.coordinatedSwap,
    swapFromSmartAccount,
    recordTradePosition,
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

describe("trade execution", () => {
  it("retries slippage failures and records only the final successful trade", async () => {
    let attempts = 0;
    const { db, coordinatedSwap, swapFromSmartAccount, recordTradePosition } = await loadModules({
      swapImpl: async () => {
        attempts += 1;
        if (attempts === 1) {
          return {
            userOpHash: hexHash("a"),
            txHash: hexHash("b"),
            status: "failed" as const,
            amountOut: "999",
            errorMessage: "Too little received: got 90, needed at least 100",
          };
        }

        return {
          userOpHash: hexHash("c"),
          txHash: hexHash("d"),
          status: "complete" as const,
          amountOut: "1200",
        };
      },
    });

    const wallet = db.createWallet({
      name: "wallet-1",
      address: hexAddress(10),
      cdpAccountName: "wallet-1",
      ownerAddress: hexAddress(11),
      type: "smart",
      isMaster: false,
    });

    const records = await coordinatedSwap({
      walletIds: [wallet.id],
      fromToken: WETH,
      toToken: COIN,
      amountInWei: 1000n,
      slippageBps: 300,
    });

    expect(records).toHaveLength(1);
    expect(records[0]?.status).toBe("complete");
    expect(records[0]?.txHash).toBe(hexHash("d"));
    expect(db.listTrades()).toHaveLength(1);
    expect(swapFromSmartAccount).toHaveBeenCalledTimes(2);
    expect(recordTradePosition).toHaveBeenCalledTimes(1);
  });

  it("keeps failed trade amountOut null and preserves the decoded failure after retries", async () => {
    let attempts = 0;
    const { db, coordinatedSwap, swapFromSmartAccount } = await loadModules({
      swapImpl: async () => {
        attempts += 1;
        const char = attempts === 1 ? "a" : "b";
        return {
          userOpHash: hexHash(char),
          txHash: hexHash(char.toUpperCase()),
          status: "failed" as const,
          amountOut: "999",
          errorMessage: "Too little received: got 90, needed at least 100",
        };
      },
      tradeMaxAttempts: "2",
    });

    const wallet = db.createWallet({
      name: "wallet-2",
      address: hexAddress(20),
      cdpAccountName: "wallet-2",
      ownerAddress: hexAddress(21),
      type: "smart",
      isMaster: false,
    });

    const records = await coordinatedSwap({
      walletIds: [wallet.id],
      fromToken: WETH,
      toToken: COIN,
      amountInWei: 1000n,
      slippageBps: 300,
    });

    expect(records).toHaveLength(1);
    expect(records[0]?.status).toBe("failed");
    expect(records[0]?.amountOut).toBeNull();
    expect(records[0]?.userOpHash).toBe(hexHash("b"));
    expect(records[0]?.errorMessage).toContain("Trade failed after 2 attempt(s)");
    expect(records[0]?.errorMessage).toContain("Too little received");
    expect(db.listTrades()).toHaveLength(1);
    expect(swapFromSmartAccount).toHaveBeenCalledTimes(2);
  });

  it("serializes coordinated buys and executes smaller amounts first", async () => {
    const seenAmounts: bigint[] = [];
    let inFlight = 0;
    let maxInFlight = 0;

    const { db, coordinatedSwap } = await loadModules({
      swapImpl: async (input) => {
        seenAmounts.push(input.fromAmount);
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 0));
        inFlight -= 1;
        return {
          userOpHash: hexHash("c"),
          txHash: hexHash("d"),
          status: "complete" as const,
          amountOut: "1234",
        };
      },
    });

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
    const walletC = db.createWallet({
      name: "wallet-c",
      address: hexAddress(34),
      cdpAccountName: "wallet-c",
      ownerAddress: hexAddress(35),
      type: "smart",
      isMaster: false,
    });

    await coordinatedSwap({
      walletIds: [walletA.id, walletB.id, walletC.id],
      fromToken: WETH,
      toToken: COIN,
      amountInWei: 0n,
      amountsPerWallet: [300n, 100n, 200n],
      slippageBps: 300,
      concurrency: 3,
    });

    expect(maxInFlight).toBe(1);
    expect(seenAmounts).toEqual([100n, 200n, 300n]);
  });
});
