import { existsSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import Database from "better-sqlite3";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { IntelligenceEngine } from "@fleet/intelligence";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WATCHLIST_NAME = "fleet-test";
const WATCHLIST_COIN = "0x6bd561fe098fa05d5412e2ba33553042a83fcc75" as const;

let tmpDir = "";
let anvilPort = 8545;
let apiPort = 4029;
let anvil: ChildProcessWithoutNullStreams | null = null;
let server: ChildProcessWithoutNullStreams | null = null;

function randomPort(base: number) {
  return base + Math.floor(Math.random() * 300);
}

async function waitFor(pred: () => Promise<boolean>, ms: number, label: string) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (await pred()) return;
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`Timed out: ${label}`);
}

function spawnProc(cmd: string, args: string[], env: NodeJS.ProcessEnv) {
  const child = spawn(cmd, args, {
    cwd: path.resolve(__dirname, "../../.."),
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (c) => { const l = String(c).trim(); if (l) console.log(`[${path.basename(cmd)}] ${l}`); });
  child.stderr.on("data", (c) => { const l = String(c).trim(); if (l) console.error(`[${path.basename(cmd)}:err] ${l}`); });
  return child;
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

describe("named fleets", () => {
  beforeAll(async () => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), "fleet-named-"));
    const sqlitePath = path.join(tmpDir, "fleet.db");
    const zoraDbPath = path.join(tmpDir, "zora.db");

    const chainId = 8453;
    
    const zoraEngine = new IntelligenceEngine({ dbPath: zoraDbPath });
    const zoraDb = zoraEngine.db;
    zoraDb.prepare("INSERT OR REPLACE INTO coins (address, symbol, name, chain_id, volume_24h, raw_json, indexed_at) VALUES (?, ?, ?, ?, ?, '{}', datetime('now'))").run(WATCHLIST_COIN, "FLT", "FleetCoin", chainId, 100000);
    zoraDb.prepare(
      `INSERT OR REPLACE INTO coin_analytics (
        coin_address, momentum_score, swap_count_24h, net_flow_usdc_24h,
        momentum_acceleration_1h, net_flow_usdc_1h, swap_count_1h,
        unique_traders_1h, buy_count_1h, sell_count_1h, buy_volume_usdc_1h, sell_volume_usdc_1h,
        swap_count_prev_1h, momentum_score_1h,
        unique_traders_24h, buy_count_24h, sell_count_24h, buy_volume_usdc_24h, sell_volume_usdc_24h,
        updated_at
      ) VALUES (?, ?, ?, ?, 1.5, 200, 30, 10, 20, 10, 400, 300, 20, 80, 30, 1500, 1000, 4000, 2500, datetime('now'))`,
    ).run(WATCHLIST_COIN, 5000, 3000, 1000);
    zoraDb.prepare("INSERT OR REPLACE INTO coin_watchlist (list_name, coin_address, enabled, created_at, updated_at) VALUES (?, ?, 1, datetime('now'), datetime('now'))").run(WATCHLIST_NAME, WATCHLIST_COIN);
    zoraEngine.close();

    anvilPort = randomPort(8700);
    apiPort = randomPort(4200);

    const localAnvil = path.join(os.homedir(), ".foundry", "bin", "anvil");
    const anvilCmd = process.env.ANVIL_BIN || (existsSync(localAnvil) ? localAnvil : "anvil");
    const rpc = process.env.BASE_RPC_URL?.trim() || "https://mainnet.base.org";

    anvil = spawnProc(anvilCmd, [
      "--fork-url", rpc, "--host", "127.0.0.1", "--port", String(anvilPort),
      "--chain-id", String(chainId), "--silent",
    ], process.env);

    await waitFor(async () => {
      try {
        const r = await fetch(`http://127.0.0.1:${anvilPort}`, {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
        });
        return r.ok;
      } catch { return false; }
    }, 60_000, "anvil");

    const tsxBin = path.join(path.resolve(__dirname, "../../.."), "node_modules", ".bin", "tsx");
    server = spawnProc(tsxBin, ["packages/server/src/index.ts"], {
      ...process.env,
      PORT: String(apiPort),
      SQLITE_PATH: sqlitePath,
      APP_NETWORK: "base",
      BASE_RPC_URL: `http://127.0.0.1:${anvilPort}`,
      ZORA_INTEL_DB_PATH: zoraDbPath,
      CDP_MOCK_MODE: "1",
      SIGNER_BACKEND: "cdp",
      FLEET_KILL_SWITCH: "false",
      CLUSTER_COOLDOWN_SEC: "0",
      REQUIRE_WATCHLIST_COIN: "true",
      REQUIRE_WATCHLIST_NAME: WATCHLIST_NAME,
      AUTO_APPROVE_ENABLED: "true",
      AUTO_APPROVE_REQUESTERS: "fleet-create,fleet:alpha,fleet:bravo",
      AUTO_APPROVE_OPERATION_TYPES: "FUNDING_REQUEST,SUPPORT_COIN,EXIT_COIN",
      AUTO_APPROVE_MAX_TRADE_WEI: "1000000000000000",
    });

    await waitFor(async () => {
      try {
        const r = await fetch(`http://127.0.0.1:${apiPort}/health`);
        if (!r.ok) return false;
        const j = (await r.json()) as { ok?: boolean };
        return j.ok === true;
      } catch { return false; }
    }, 60_000, "server");
  }, 120_000);

  afterAll(() => {
    if (server && !server.killed) server.kill("SIGTERM");
    if (anvil && !anvil.killed) anvil.kill("SIGTERM");
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  });

  it("creates a named fleet with wallets and funding", async () => {
    const res = await api("POST", "/fleets", {
      name: "alpha",
      wallets: 3,
      fundAmountWei: "100000000000000", // 0.0001 ETH
    });
    expect(res.status).toBe(201);
    expect(res.json.fleet.name).toBe("alpha");
    expect(res.json.fleet.wallets.length).toBe(3);
    expect(res.json.fundingOperationId).toBeTypeOf("number");
  });

  it("lists fleets", async () => {
    const res = await api("GET", "/fleets");
    expect(res.status).toBe(200);
    expect(res.json.fleets.length).toBeGreaterThanOrEqual(1);
    expect(res.json.fleets[0].name).toBe("alpha");
  });

  it("gets fleet by name", async () => {
    const res = await api("GET", "/fleets/alpha");
    expect(res.status).toBe(200);
    expect(res.json.fleet.wallets.length).toBe(3);
  });

  it("rejects duplicate fleet name", async () => {
    const res = await api("POST", "/fleets", { name: "alpha", wallets: 1 });
    expect(res.status).toBe(400);
    expect(res.json.error).toContain("already exists");
  });

  it("fleet buy + sell roundtrip", async () => {
    // Buy
    const buyRes = await api("POST", "/fleets/alpha/buy", {
      coinAddress: WATCHLIST_COIN,
      totalAmountWei: "100000000000000",
      slippageBps: 100,
    });
    expect(buyRes.status).toBe(200);
    expect(buyRes.json.operation.status).toBe("complete");

    // Sell
    const sellRes = await api("POST", "/fleets/alpha/sell", {
      coinAddress: WATCHLIST_COIN,
      totalAmountWei: "100000000000000",
      slippageBps: 100,
    });
    expect(sellRes.status).toBe(200);
    expect(sellRes.json.operation.status).toBe("complete");
  });

  it("gets fleet status", async () => {
    const res = await api("GET", "/fleets/alpha/status");
    expect(res.status).toBe(200);
    expect(res.json.clusterName).toBe("alpha");
    expect(res.json.walletCount).toBe(3);
  });

  it("creates second fleet for sweep target", async () => {
    const res = await api("POST", "/fleets", {
      name: "bravo",
      wallets: 2,
    });
    expect(res.status).toBe(201);
    expect(res.json.fleet.name).toBe("bravo");
    expect(res.json.fleet.wallets.length).toBe(2);
  });

  it("returns 404 for unknown fleet", async () => {
    const res = await api("GET", "/fleets/nonexistent");
    expect(res.status).toBe(404);
  });
});
