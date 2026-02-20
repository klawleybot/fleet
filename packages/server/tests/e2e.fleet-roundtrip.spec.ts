/**
 * Fleet of 2 — Buy + Sell Roundtrip E2E
 *
 * Two fleet wallets in a cluster:
 * 1. Fund both wallets from master
 * 2. Both buy into a Zora coin (support-coin)
 * 3. Both sell out (exit-coin)
 * 4. Verify trade history shows buy + sell for each wallet
 *
 * Uses anvil fork + mock CDP backend (same infra as e2e.fleet.spec.ts).
 */
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import Database from "better-sqlite3";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const WATCHLIST_NAME = "roundtrip-test";
const WATCHLIST_COIN = "0x6bd561fe098fa05d5412e2ba33553042a83fcc75" as const;
const __dirname = path.dirname(fileURLToPath(import.meta.url));

let tmpDir = "";
let anvilPort = 8545;
let apiPort = 4029;
let anvil: ChildProcessWithoutNullStreams | null = null;
let server: ChildProcessWithoutNullStreams | null = null;

function randomPort(base: number) {
  return base + Math.floor(Math.random() * 300);
}

async function waitFor(predicate: () => Promise<boolean>, timeoutMs: number, label: string): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function waitForRpc(rpcUrl: string): Promise<void> {
  await waitFor(async () => {
    try {
      const res = await fetch(rpcUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
      });
      if (!res.ok) return false;
      const json = (await res.json()) as { result?: string };
      return typeof json.result === "string";
    } catch {
      return false;
    }
  }, 60_000, "anvil rpc");
}

async function waitForHealth(baseUrl: string): Promise<void> {
  await waitFor(async () => {
    try {
      const res = await fetch(`${baseUrl}/health`);
      if (!res.ok) return false;
      const json = (await res.json()) as { ok?: boolean };
      return json.ok === true;
    } catch {
      return false;
    }
  }, 60_000, "fleet server health");
}

function spawnProcess(cmd: string, args: string[], env: NodeJS.ProcessEnv): ChildProcessWithoutNullStreams {
  const child = spawn(cmd, args, {
    cwd: path.resolve(__dirname, "../../.."),
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk) => {
    const line = String(chunk).trim();
    if (line) console.log(`[${path.basename(cmd)}] ${line}`);
  });
  child.stderr.on("data", (chunk) => {
    const line = String(chunk).trim();
    if (line) console.error(`[${path.basename(cmd)}:err] ${line}`);
  });
  return child;
}

function createFixtureDb(filePath: string, chainId: number): void {
  const db = new Database(filePath);
  db.exec(`
    CREATE TABLE IF NOT EXISTS coins (
      address TEXT PRIMARY KEY, symbol TEXT, name TEXT, chain_id INTEGER, volume_24h REAL
    );
    CREATE TABLE IF NOT EXISTS coin_analytics (
      coin_address TEXT PRIMARY KEY, momentum_score REAL, swap_count_24h INTEGER, net_flow_usdc_24h REAL
    );
    CREATE TABLE IF NOT EXISTS coin_watchlist (
      list_name TEXT NOT NULL, coin_address TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1,
      PRIMARY KEY(list_name, coin_address)
    );
  `);
  db.prepare("INSERT OR REPLACE INTO coins VALUES (?, ?, ?, ?, ?)").run(
    WATCHLIST_COIN, "FLEET2", "Fleet2Coin", chainId, 500_000,
  );
  db.prepare("INSERT OR REPLACE INTO coin_analytics VALUES (?, ?, ?, ?)").run(
    WATCHLIST_COIN, 8000, 6000, 3000,
  );
  db.prepare("INSERT OR REPLACE INTO coin_watchlist VALUES (?, ?, 1)").run(
    WATCHLIST_NAME, WATCHLIST_COIN,
  );
  db.close();
}

async function api(method: string, endpoint: string, body?: unknown) {
  const res = await fetch(`http://127.0.0.1:${apiPort}${endpoint}`, {
    method,
    headers: { "content-type": "application/json" },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

describe("fleet of 2 — buy + sell roundtrip", () => {
  beforeAll(async () => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), "fleet-rt-"));
    const sqlitePath = path.join(tmpDir, "fleet-rt.db");
    const zoraDbPath = path.join(tmpDir, "zora-rt.db");

    const appNetwork = process.env.APP_NETWORK === "base-sepolia" ? "base-sepolia" : "base";
    const chainId = appNetwork === "base-sepolia" ? 84532 : 8453;
    createFixtureDb(zoraDbPath, chainId);

    anvilPort = randomPort(8600);
    apiPort = randomPort(4100);

    const localAnvil = path.join(os.homedir(), ".foundry", "bin", "anvil");
    const anvilCmd = process.env.ANVIL_BIN || (existsSync(localAnvil) ? localAnvil : "anvil");
    const upstreamRpc = appNetwork === "base-sepolia"
      ? (process.env.BASE_SEPOLIA_RPC_URL?.trim() || "https://sepolia.base.org")
      : (process.env.BASE_RPC_URL?.trim() || "https://mainnet.base.org");

    anvil = spawnProcess(anvilCmd, [
      "--fork-url", upstreamRpc,
      "--host", "127.0.0.1",
      "--port", String(anvilPort),
      "--chain-id", String(chainId),
      "--silent",
    ], process.env);

    await waitForRpc(`http://127.0.0.1:${anvilPort}`);

    const repoRoot = path.resolve(__dirname, "../../..");
    const tsxBin = path.join(repoRoot, "node_modules", ".bin", "tsx");

    server = spawnProcess(tsxBin, ["packages/server/src/index.ts"], {
      ...process.env,
      PORT: String(apiPort),
      SQLITE_PATH: sqlitePath,
      APP_NETWORK: appNetwork,
      BASE_RPC_URL: `http://127.0.0.1:${anvilPort}`,
      BASE_SEPOLIA_RPC_URL: `http://127.0.0.1:${anvilPort}`,
      ZORA_INTEL_DB_PATH: zoraDbPath,
      CDP_MOCK_MODE: "1",
      SIGNER_BACKEND: "cdp",
      FLEET_KILL_SWITCH: "false",
      CLUSTER_COOLDOWN_SEC: "0",
      REQUIRE_WATCHLIST_COIN: "true",
      REQUIRE_WATCHLIST_NAME: WATCHLIST_NAME,
      AUTONOMY_ENABLED: "true",
      AUTONOMY_AUTO_START: "false",
      AUTONOMY_CREATE_REQUESTS: "false",
      AUTONOMY_AUTO_APPROVE_PENDING: "true",
      AUTO_APPROVE_ENABLED: "true",
      AUTO_APPROVE_REQUESTERS: "e2e-roundtrip",
      AUTO_APPROVE_OPERATION_TYPES: "SUPPORT_COIN,EXIT_COIN",
      AUTO_APPROVE_MAX_TRADE_WEI: "1000000000000000",
    });

    await waitForHealth(`http://127.0.0.1:${apiPort}`);
  }, 120_000);

  afterAll(() => {
    if (server && !server.killed) server.kill("SIGTERM");
    if (anvil && !anvil.killed) anvil.kill("SIGTERM");
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  });

  it("two wallets buy and sell in coordinated roundtrip", async () => {
    // --- Step 1: Create 2 fleet wallets ---
    const createRes = await api("POST", "/wallets", { count: 2 });
    expect(createRes.status).toBe(201);
    expect(createRes.json.created.length).toBe(2);

    const walletsRes = await api("GET", "/wallets");
    const fleetWallets = (walletsRes.json.wallets as Array<{ id: number; isMaster: boolean }>)
      .filter((w) => !w.isMaster);
    expect(fleetWallets.length).toBeGreaterThanOrEqual(2);
    const walletIds = fleetWallets.slice(0, 2).map((w) => w.id);

    // --- Step 2: Create cluster with both wallets ---
    const clusterRes = await api("POST", "/clusters", {
      name: "roundtrip-cluster",
      strategyMode: "sync",
    });
    expect(clusterRes.status).toBe(201);
    const clusterId = Number(clusterRes.json.cluster.id);

    const assignRes = await api("PUT", `/clusters/${clusterId}/wallets`, { walletIds });
    expect(assignRes.status).toBe(200);
    expect(assignRes.json.wallets.length).toBe(2);

    // --- Step 3: Fund both wallets ---
    const fundReq = await api("POST", "/operations/request-funding", {
      clusterId,
      amountWei: "100000000000000",
      requestedBy: "e2e-roundtrip",
    });
    expect(fundReq.status).toBe(201);

    const fundExec = await api("POST", `/operations/${fundReq.json.operation.id}/approve-execute`, {
      approvedBy: "e2e-roundtrip",
    });
    expect(fundExec.status).toBe(200);
    expect(fundExec.json.operation.status).toBe("complete");

    // --- Step 4: Both wallets buy (support-coin) ---
    const buyReq = await api("POST", "/operations/support-coin", {
      clusterId,
      coinAddress: WATCHLIST_COIN,
      totalAmountWei: "100000000000000",
      slippageBps: 100,
      strategyMode: "sync",
      requestedBy: "e2e-roundtrip",
    });
    expect(buyReq.status).toBe(201);
    const buyOpId = buyReq.json.operation.id;

    const buyExec = await api("POST", `/operations/${buyOpId}/approve-execute`, {
      approvedBy: "e2e-roundtrip",
    });
    expect(buyExec.status).toBe(200);
    expect(buyExec.json.operation.status).toBe("complete");

    // Verify buy trades recorded (2 wallets = 2 trades)
    const tradesAfterBuy = await api("GET", "/trades/history");
    expect(tradesAfterBuy.status).toBe(200);
    const buyTradeCount = tradesAfterBuy.json.records.length;
    expect(buyTradeCount).toBeGreaterThanOrEqual(2);

    // --- Step 5: Both wallets sell (exit-coin) ---
    const sellReq = await api("POST", "/operations/exit-coin", {
      clusterId,
      coinAddress: WATCHLIST_COIN,
      totalAmountWei: "100000000000000",
      slippageBps: 100,
      strategyMode: "sync",
      requestedBy: "e2e-roundtrip",
    });
    expect(sellReq.status).toBe(201);

    const sellExec = await api("POST", `/operations/${sellReq.json.operation.id}/approve-execute`, {
      approvedBy: "e2e-roundtrip",
    });
    expect(sellExec.status).toBe(200);
    expect(sellExec.json.operation.status).toBe("complete");

    // Verify sell trades added (should be at least 2 more than after buy)
    const tradesAfterSell = await api("GET", "/trades/history");
    expect(tradesAfterSell.status).toBe(200);
    const totalTrades = tradesAfterSell.json.records.length;
    expect(totalTrades).toBeGreaterThanOrEqual(buyTradeCount + 2);

    // --- Step 6: Verify both wallets participated ---
    const tradeWalletIds = new Set(
      (tradesAfterSell.json.records as Array<{ walletId: number }>).map((r) => r.walletId),
    );
    for (const wid of walletIds) {
      expect(tradeWalletIds.has(wid)).toBe(true);
    }
  }, 60_000);
});
