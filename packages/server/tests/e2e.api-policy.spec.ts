import { existsSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import Database from "better-sqlite3";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const WATCHLIST_NAME = "Investments to watch";
const WATCHLIST_COIN = "0x6bd561fe098fa05d5412e2ba33553042a83fcc75" as const;
const OTHER_COIN = "0x4200000000000000000000000000000000000006" as const;
const __dirname = path.dirname(fileURLToPath(import.meta.url));

let tmpDir = "";
let sqlitePath = "";
let zoraFixturePath = "";
let anvilPort = 8545;
let apiPort = 4029;
let appNetwork: "base" | "base-sepolia" = "base";
let anvil: ChildProcessWithoutNullStreams | null = null;
let server: ChildProcessWithoutNullStreams | null = null;
let clusterId = 0;
let fleetWalletIds: number[] = [];

function randomPort(base: number) {
  return base + Math.floor(Math.random() * 300);
}

async function waitFor(predicate: () => Promise<boolean>, timeoutMs: number, label: string): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 300));
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

function spawnProcess(command: string, args: string[], env: NodeJS.ProcessEnv): ChildProcessWithoutNullStreams {
  const child = spawn(command, args, {
    cwd: path.resolve(__dirname, "../../.."),
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  child.stdout.on("data", (chunk) => {
    const line = String(chunk).trim();
    if (line) console.log(`[${path.basename(command)}] ${line}`);
  });
  child.stderr.on("data", (chunk) => {
    const line = String(chunk).trim();
    if (line) console.error(`[${path.basename(command)}:err] ${line}`);
  });

  return child;
}

function createZoraFixtureDb(filePath: string, chainId: number): void {
  const db = new Database(filePath);
  db.exec(`
    CREATE TABLE IF NOT EXISTS coins (
      address TEXT PRIMARY KEY,
      symbol TEXT,
      name TEXT,
      chain_id INTEGER,
      volume_24h REAL
    );

    CREATE TABLE IF NOT EXISTS coin_analytics (
      coin_address TEXT PRIMARY KEY,
      momentum_score REAL,
      swap_count_24h INTEGER,
      net_flow_usdc_24h REAL
    );

    CREATE TABLE IF NOT EXISTS coin_watchlist (
      list_name TEXT NOT NULL,
      coin_address TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      PRIMARY KEY(list_name, coin_address)
    );
  `);

  db.prepare(
    `INSERT OR REPLACE INTO coins (address, symbol, name, chain_id, volume_24h) VALUES (?, ?, ?, ?, ?)`,
  ).run(WATCHLIST_COIN, "USRX", "USRX", chainId, 1_000_000);

  db.prepare(
    `INSERT OR REPLACE INTO coin_analytics (coin_address, momentum_score, swap_count_24h, net_flow_usdc_24h) VALUES (?, ?, ?, ?)`,
  ).run(WATCHLIST_COIN, 5000, 4000, 2000);

  db.prepare(`INSERT OR REPLACE INTO coin_watchlist (list_name, coin_address, enabled) VALUES (?, ?, 1)`).run(
    WATCHLIST_NAME,
    WATCHLIST_COIN,
  );

  db.close();
}

async function api(method: string, endpoint: string, body?: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(`http://127.0.0.1:${apiPort}${endpoint}`, {
    method,
    headers: { "content-type": "application/json" },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : null;
  return { status: res.status, json };
}

describe("fleet API + policy coverage", () => {
  beforeAll(async () => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), "fleet-e2e-policy-"));
    sqlitePath = path.join(tmpDir, "fleet-e2e.db");
    zoraFixturePath = path.join(tmpDir, "zora-intel-fixture.db");

    appNetwork = process.env.APP_NETWORK === "base-sepolia" ? "base-sepolia" : "base";
    const chainId = appNetwork === "base-sepolia" ? 84532 : 8453;

    createZoraFixtureDb(zoraFixturePath, chainId);

    anvilPort = randomPort(8600);
    apiPort = randomPort(4300);

    const localFoundryAnvil = path.join(os.homedir(), ".foundry", "bin", "anvil");
    const anvilCmd = process.env.ANVIL_BIN || (existsSync(localFoundryAnvil) ? localFoundryAnvil : "anvil");
    const upstreamBaseRpc = appNetwork === "base-sepolia"
      ? (process.env.BASE_SEPOLIA_RPC_URL?.trim() || process.env.BASE_RPC_URL?.trim() || "https://sepolia.base.org")
      : (process.env.BASE_RPC_URL?.trim() || process.env.BASE_SEPOLIA_RPC_URL?.trim() || "https://mainnet.base.org");

    anvil = spawnProcess(
      anvilCmd,
      [
        "--fork-url",
        upstreamBaseRpc,
        "--host",
        "127.0.0.1",
        "--port",
        String(anvilPort),
        "--chain-id",
        String(chainId),
        "--silent",
      ],
      process.env,
    );

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
      ZORA_INTEL_DB_PATH: zoraFixturePath,
      CDP_MOCK_MODE: "1",
      SIGNER_BACKEND: "cdp",
      FLEET_KILL_SWITCH: "false",
      CLUSTER_COOLDOWN_SEC: "120",
      REQUIRE_WATCHLIST_COIN: "true",
      REQUIRE_WATCHLIST_NAME: WATCHLIST_NAME,
      ALLOWED_COIN_ADDRESSES: WATCHLIST_COIN,
      MAX_SLIPPAGE_BPS: "300",
      AUTONOMY_ENABLED: "true",
      AUTONOMY_AUTO_START: "false",
      AUTONOMY_CREATE_REQUESTS: "false",
      AUTONOMY_AUTO_APPROVE_PENDING: "false",
    });

    await waitForHealth(`http://127.0.0.1:${apiPort}`);

    const createWallets = await api("POST", "/wallets", { count: 3 });
    fleetWalletIds = createWallets.json.created.map((w: { id: number }) => w.id);

    const clusterCreate = await api("POST", "/clusters", {
      name: "policy-cluster",
      strategyMode: "sync",
    });
    clusterId = Number(clusterCreate.json.cluster.id);

    await api("PUT", `/clusters/${clusterId}/wallets`, {
      walletIds: fleetWalletIds.slice(0, 2),
    });
  });

  afterAll(() => {
    if (server && !server.killed) server.kill("SIGTERM");
    if (anvil && !anvil.killed) anvil.kill("SIGTERM");
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  });

  it("validates bad wallet and cluster inputs", async () => {
    const badWalletCreate = await api("POST", "/wallets", { count: 0 });
    expect(badWalletCreate.status).toBe(400);

    const badClusterCreate = await api("POST", "/clusters", {
      name: "x",
      strategyMode: "invalid-mode",
    });
    expect(badClusterCreate.status).toBe(400);

    const badAssign = await api("PUT", `/clusters/${clusterId}/wallets`, { walletIds: [0, -1] });
    expect(badAssign.status).toBe(400);
  });

  it("validates funding/trade route parameter errors", async () => {
    const badFunding = await api("POST", "/funding/distribute", {
      toWalletIds: [fleetWalletIds[0]],
      amountWei: "not-a-number",
    });
    expect(badFunding.status).toBe(400);

    const badSwap = await api("POST", "/trades/swap", {
      walletIds: [fleetWalletIds[0]],
      fromToken: "0x123",
      toToken: WATCHLIST_COIN,
      amountInWei: "1000",
      slippageBps: 100,
    });
    expect(badSwap.status).toBe(400);

    const badSupport = await api("POST", "/operations/support-coin", {
      clusterId,
      coinAddress: "0x123",
      totalAmountWei: "1000",
      slippageBps: 100,
    });
    expect(badSupport.status).toBe(400);
  });

  it("enforces allowlist + watchlist + slippage policy constraints", async () => {
    const allowlistBlocked = await api("POST", "/operations/support-coin", {
      clusterId,
      coinAddress: OTHER_COIN,
      totalAmountWei: "10000000000000",
      slippageBps: 100,
    });
    expect(allowlistBlocked.status).toBe(400);
    expect(String(allowlistBlocked.json.error)).toContain("ALLOWED_COIN_ADDRESSES");

    const slippageBlocked = await api("POST", "/operations/support-coin", {
      clusterId,
      coinAddress: WATCHLIST_COIN,
      totalAmountWei: "10000000000000",
      slippageBps: 999,
    });
    expect(slippageBlocked.status).toBe(400);
    expect(String(slippageBlocked.json.error)).toContain("MAX_SLIPPAGE_BPS");
  });

  it("enforces execution cooldown between cluster operations", async () => {
    const fundingReq1 = await api("POST", "/operations/request-funding", {
      clusterId,
      amountWei: "10000000000000",
      requestedBy: "policy-test",
    });
    expect(fundingReq1.status).toBe(201);

    const exec1 = await api("POST", `/operations/${fundingReq1.json.operation.id}/approve-execute`, {
      approvedBy: "policy-approver",
    });
    expect(exec1.status).toBe(200);
    expect(exec1.json.operation.status).toBe("complete");

    const fundingReq2 = await api("POST", "/operations/request-funding", {
      clusterId,
      amountWei: "10000000000000",
      requestedBy: "policy-test",
    });
    expect(fundingReq2.status).toBe(201);

    const exec2 = await api("POST", `/operations/${fundingReq2.json.operation.id}/approve-execute`, {
      approvedBy: "policy-approver",
    });
    expect(exec2.status).toBe(400);
    expect(String(exec2.json.error)).toContain("Cluster cooldown active");
  });

  it("covers autonomy control/status endpoints", async () => {
    const status = await api("GET", "/autonomy/status");
    expect(status.status).toBe(200);

    const badStart = await api("POST", "/autonomy/start", { intervalSec: 5 });
    expect(badStart.status).toBe(400);

    const start = await api("POST", "/autonomy/start", { intervalSec: 10 });
    expect(start.status).toBe(200);

    const stop = await api("POST", "/autonomy/stop", {});
    expect(stop.status).toBe(200);
  });
});
