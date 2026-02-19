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
let clusterId = 0;

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

describe("autonomy soak", () => {
  beforeAll(async () => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), "fleet-autonomy-soak-"));
    sqlitePath = path.join(tmpDir, "fleet-autonomy.db");
    zoraFixturePath = path.join(tmpDir, "zora-intel-fixture.db");

    appNetwork = process.env.APP_NETWORK === "base-sepolia" ? "base-sepolia" : "base";
    const chainId = appNetwork === "base-sepolia" ? 84532 : 8453;

    createZoraFixtureDb(zoraFixturePath, chainId);

    anvilPort = randomPort(8900);
    apiPort = randomPort(4700);

    const localFoundryAnvil = path.join(os.homedir(), ".foundry", "bin", "anvil");
    const anvilCmd = process.env.ANVIL_BIN || (existsSync(localFoundryAnvil) ? localFoundryAnvil : "anvil");
    const upstreamBaseRpc = appNetwork === "base-sepolia"
      ? (process.env.BASE_SEPOLIA_RPC_URL?.trim() || process.env.BASE_RPC_URL?.trim() || "https://sepolia.base.org")
      : (process.env.BASE_RPC_URL?.trim() || process.env.BASE_SEPOLIA_RPC_URL?.trim() || "https://mainnet.base.org");

    anvil = spawnProcess(
      anvilCmd,
      ["--fork-url", upstreamBaseRpc, "--host", "127.0.0.1", "--port", String(anvilPort), "--chain-id", String(chainId), "--silent"],
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
      AUTONOMY_CREATE_REQUESTS: "true",
      AUTONOMY_AUTO_APPROVE_PENDING: "true",
      AUTONOMY_SIGNAL_MODE: "watchlist_top",
      AUTONOMY_WATCHLIST_NAME: WATCHLIST_NAME,
      AUTONOMY_TOTAL_AMOUNT_WEI: "100000000000000",
      AUTONOMY_SLIPPAGE_BPS: "100",
      AUTONOMY_REQUESTED_BY: "autonomy-worker",
      AUTONOMY_CLUSTER_IDS: "1",
      AUTO_APPROVE_ENABLED: "true",
      AUTO_APPROVE_REQUESTERS: "autonomy-worker",
      AUTO_APPROVE_OPERATION_TYPES: "SUPPORT_COIN",
      AUTO_APPROVE_MAX_TRADE_WEI: "1000000000000000",
    });

    await waitForHealth(`http://127.0.0.1:${apiPort}`);

    const createWallets = await api("POST", "/wallets", { count: 3 });
    const walletIds = createWallets.json.created.map((w: { id: number }) => w.id);
    const clusterCreate = await api("POST", "/clusters", { name: "autonomy-soak-cluster", strategyMode: "sync" });
    clusterId = Number(clusterCreate.json.cluster.id);
    expect(clusterId).toBe(1);
    await api("PUT", `/clusters/${clusterId}/wallets`, { walletIds });
  });

  afterAll(() => {
    if (server && !server.killed) server.kill("SIGTERM");
    if (anvil && !anvil.killed) anvil.kill("SIGTERM");
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  });

  it("runs repeated ticks without leaving pending operations", async () => {
    const ticks = 12;
    let executedTotal = 0;

    for (let i = 0; i < ticks; i += 1) {
      const tick = await api("POST", "/autonomy/tick", {});
      expect(tick.status).toBe(200);
      const t = tick.json.tick as { errors: string[]; executedOperationIds: number[] };
      expect(Array.isArray(t.errors)).toBe(true);
      expect(t.errors.length).toBe(0);
      executedTotal += t.executedOperationIds.length;
    }

    expect(executedTotal).toBeGreaterThan(0);

    const ops = await api("GET", "/operations?limit=200");
    expect(ops.status).toBe(200);

    const rows = ops.json.operations as Array<{ status: string; requestedBy: string | null; type: string }>;
    const pending = rows.filter((r) => r.status === "pending" || r.status === "approved" || r.status === "executing");
    expect(pending.length).toBe(0);

    const autonomySupportOps = rows.filter((r) => r.requestedBy === "autonomy-worker" && r.type === "SUPPORT_COIN");
    expect(autonomySupportOps.length).toBeGreaterThan(0);
    expect(autonomySupportOps.every((r) => r.status === "complete")).toBe(true);
  });
});
