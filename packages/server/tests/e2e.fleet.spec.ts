import { existsSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import Database from "better-sqlite3";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const WATCHLIST_NAME = "Investments to watch";
const WATCHLIST_COIN = "0x6bd561fe098fa05d5412e2ba33553042a83fcc75" as const;
const __dirname = path.dirname(fileURLToPath(import.meta.url));

let tmpDir = "";
let sqlitePath = "";
let zoraFixturePath = "";
let anvilPort = 8545;
let apiPort = 4029;
let appNetwork: "base" | "base-sepolia" = "base";
let anvil: ChildProcessWithoutNullStreams | null = null;
let server: ChildProcessWithoutNullStreams | null = null;

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

describe("fleet e2e (anvil fork + mock CDP)", () => {
  beforeAll(async () => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), "fleet-e2e-"));
    sqlitePath = path.join(tmpDir, "fleet-e2e.db");
    zoraFixturePath = path.join(tmpDir, "zora-intel-fixture.db");

    appNetwork = process.env.APP_NETWORK === "base-sepolia" ? "base-sepolia" : "base";
    const chainId = appNetwork === "base-sepolia" ? 84532 : 8453;

    createZoraFixtureDb(zoraFixturePath, chainId);

    anvilPort = randomPort(8500);
    apiPort = randomPort(4000);

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
      CLUSTER_COOLDOWN_SEC: "0",
      REQUIRE_WATCHLIST_COIN: "true",
      REQUIRE_WATCHLIST_NAME: WATCHLIST_NAME,
      AUTONOMY_ENABLED: "true",
      AUTONOMY_AUTO_START: "false",
      AUTONOMY_CREATE_REQUESTS: "false",
      AUTONOMY_AUTO_APPROVE_PENDING: "true",
      AUTONOMY_CLUSTER_IDS: "1",
      AUTONOMY_SIGNAL_MODE: "watchlist_top",
      AUTONOMY_WATCHLIST_NAME: WATCHLIST_NAME,
      AUTONOMY_TOTAL_AMOUNT_WEI: "100000000000000",
      AUTONOMY_SLIPPAGE_BPS: "100",
      AUTO_APPROVE_ENABLED: "true",
      AUTO_APPROVE_REQUESTERS: "autonomy-worker",
      AUTO_APPROVE_OPERATION_TYPES: "SUPPORT_COIN",
      AUTO_APPROVE_MAX_TRADE_WEI: "1000000000000000",
    });

    await waitForHealth(`http://127.0.0.1:${apiPort}`);
  });

  afterAll(() => {
    if (server && !server.killed) server.kill("SIGTERM");
    if (anvil && !anvil.killed) anvil.kill("SIGTERM");
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  });

  it("executes funding + trade + signal-driven operation end-to-end", async () => {
    const rpcCheck = await fetch(`http://127.0.0.1:${anvilPort}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] }),
    });
    const rpcJson = (await rpcCheck.json()) as { result: string };
    expect(Number.parseInt(rpcJson.result, 16)).toBeGreaterThan(0);

    const walletsInitial = await api("GET", "/wallets");
    expect(walletsInitial.status).toBe(200);
    expect(Array.isArray(walletsInitial.json.wallets)).toBe(true);

    const createWallets = await api("POST", "/wallets", { count: 3 });
    expect(createWallets.status).toBe(201);
    expect(createWallets.json.created.length).toBe(3);

    const wallets = await api("GET", "/wallets");
    const fleetWalletIds = (wallets.json.wallets as Array<{ id: number; isMaster: boolean }>)
      .filter((w) => !w.isMaster)
      .map((w) => w.id);
    expect(fleetWalletIds.length).toBeGreaterThanOrEqual(3);

    const bal = await api("GET", `/wallets/${fleetWalletIds[0]}/balance`);
    expect(bal.status).toBe(200);
    expect(typeof bal.json.ethBalanceWei).toBe("string");

    const clusterCreate = await api("POST", "/clusters", {
      name: "e2e-cluster",
      strategyMode: "staggered",
    });
    expect(clusterCreate.status).toBe(201);
    const clusterId = Number(clusterCreate.json.cluster.id);
    expect(clusterId).toBeGreaterThan(0);

    const clusterAssign = await api("PUT", `/clusters/${clusterId}/wallets`, {
      walletIds: fleetWalletIds.slice(0, 2),
    });
    expect(clusterAssign.status).toBe(200);
    expect(clusterAssign.json.wallets.length).toBe(2);

    const fundingReq = await api("POST", "/operations/request-funding", {
      clusterId,
      amountWei: "100000000000000",
      requestedBy: "e2e-test",
    });
    expect(fundingReq.status).toBe(201);

    const fundingExec = await api("POST", `/operations/${fundingReq.json.operation.id}/approve-execute`, {
      approvedBy: "e2e-test-approver",
    });
    expect(fundingExec.status).toBe(200);
    expect(fundingExec.json.operation.status).toBe("complete");

    const fundingHistory = await api("GET", "/funding/history");
    expect(fundingHistory.status).toBe(200);
    expect(fundingHistory.json.records.length).toBeGreaterThanOrEqual(2);

    const supportReq = await api("POST", "/operations/support-coin", {
      clusterId,
      coinAddress: WATCHLIST_COIN,
      totalAmountWei: "100000000000000",
      slippageBps: 100,
      strategyMode: "staggered",
      requestedBy: "e2e-test",
    });
    expect(supportReq.status).toBe(201);

    const supportExec = await api("POST", `/operations/${supportReq.json.operation.id}/approve-execute`, {
      approvedBy: "e2e-test-approver",
    });
    expect(supportExec.status).toBe(200);
    expect(supportExec.json.operation.status).toBe("complete");

    const tradeHistory = await api("GET", "/trades/history");
    expect(tradeHistory.status).toBe(200);
    expect(tradeHistory.json.records.length).toBeGreaterThanOrEqual(2);

    const signals = await api(
      "GET",
      `/operations/zora-signals?mode=watchlist_top&listName=${encodeURIComponent(WATCHLIST_NAME)}&limit=3`,
    );
    expect(signals.status).toBe(200);
    expect(signals.json.candidates[0].coinAddress.toLowerCase()).toBe(WATCHLIST_COIN);

    const signalOp = await api("POST", "/operations/support-from-zora-signal", {
      clusterId,
      mode: "watchlist_top",
      listName: WATCHLIST_NAME,
      totalAmountWei: "100000000000000",
      slippageBps: 100,
      strategyMode: "sync",
      requestedBy: "autonomy-worker",
    });
    expect(signalOp.status).toBe(201);

    const tick = await api("POST", "/autonomy/tick", {});
    expect(tick.status).toBe(200);

    const operations = await api("GET", "/operations?limit=50");
    const signalOperation = (operations.json.operations as Array<{ id: number; status: string }>).find(
      (op) => op.id === Number(signalOp.json.operation.id),
    );
    expect(signalOperation?.status).toBe("complete");
  });
});
