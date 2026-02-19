import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const runLive = process.env.E2E_BASE_LIVE === "1";
const describeLive = runLive ? describe : describe.skip;

let tmpDir = "";
let sqlitePath = "";
let apiPort = 4029;
let server: ChildProcessWithoutNullStreams | null = null;

function randomPort(base: number) {
  return base + Math.floor(Math.random() * 300);
}

async function waitFor(predicate: () => Promise<boolean>, timeoutMs: number, label: string): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  throw new Error(`Timed out waiting for ${label}`);
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
  }, 90_000, "fleet server health");
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

describeLive("fleet e2e local backend funding flow (base-sepolia live bundler)", () => {
  beforeAll(async () => {
    if (!process.env.BASE_SEPOLIA_RPC_URL?.trim()) {
      throw new Error("BASE_SEPOLIA_RPC_URL is required for E2E_BASE_LIVE=1");
    }

    if (!process.env.LOCAL_SIGNER_SEED?.trim() && !process.env.MASTER_WALLET_PRIVATE_KEY?.trim()) {
      throw new Error(
        "Set LOCAL_SIGNER_SEED or MASTER_WALLET_PRIVATE_KEY for E2E_BASE_LIVE=1 (master wallet must be funded).",
      );
    }

    if (!process.env.PIMLICO_BASE_SEPOLIA_BUNDLER_URL?.trim() && !process.env.BUNDLER_PRIMARY_URL?.trim()) {
      throw new Error(
        "Set PIMLICO_BASE_SEPOLIA_BUNDLER_URL (or BUNDLER_PRIMARY_URL) for E2E_BASE_LIVE=1.",
      );
    }

    tmpDir = mkdtempSync(path.join(os.tmpdir(), "fleet-e2e-base-live-"));
    sqlitePath = path.join(tmpDir, "fleet-e2e-base-live.db");
    apiPort = randomPort(4600);

    const repoRoot = path.resolve(__dirname, "../../..");
    const tsxBin = path.join(repoRoot, "node_modules", ".bin", "tsx");

    server = spawnProcess(tsxBin, ["packages/server/src/index.ts"], {
      ...process.env,
      PORT: String(apiPort),
      SQLITE_PATH: sqlitePath,
      APP_NETWORK: "base-sepolia",
      SIGNER_BACKEND: "local",
      CDP_MOCK_MODE: "false",
      BUNDLER_PRIMARY_NAME: process.env.BUNDLER_PRIMARY_NAME || "pimlico",
      FLEET_KILL_SWITCH: "false",
      CLUSTER_COOLDOWN_SEC: "0",
      REQUIRE_WATCHLIST_COIN: "false",
      WALLET_BOOTSTRAP_WEI: process.env.WALLET_BOOTSTRAP_WEI || "10000000000000000",
    });

    await waitForHealth(`http://127.0.0.1:${apiPort}`);
  });

  afterAll(() => {
    if (server && !server.killed) server.kill("SIGTERM");
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  });

  it("creates wallets and executes funding operation against live base-sepolia bundler", async () => {
    const createWallets = await api("POST", "/wallets", { count: 2 });
    expect(createWallets.status).toBe(201);

    const wallets = await api("GET", "/wallets");
    const fleetWallets = (wallets.json.wallets as Array<{ id: number; isMaster: boolean }>).filter((w) => !w.isMaster);
    expect(fleetWallets.length).toBeGreaterThanOrEqual(2);

    const clusterCreate = await api("POST", "/clusters", {
      name: "base-live-funding-cluster",
      strategyMode: "sync",
    });
    expect(clusterCreate.status).toBe(201);

    const clusterId = Number(clusterCreate.json.cluster.id);
    const assign = await api("PUT", `/clusters/${clusterId}/wallets`, {
      walletIds: fleetWallets.map((w) => w.id),
    });
    expect(assign.status).toBe(200);

    const amountWei = process.env.E2E_BASE_LIVE_AMOUNT_WEI || "1000000000000"; // 0.000001 ETH

    const fundingReq = await api("POST", "/operations/request-funding", {
      clusterId,
      amountWei,
      requestedBy: "base-live-e2e",
    });
    expect(fundingReq.status).toBe(201);

    const execute = await api("POST", `/operations/${fundingReq.json.operation.id}/approve-execute`, {
      approvedBy: "base-live-e2e-approver",
    });
    expect(execute.status).toBe(200);
    expect(execute.json.operation.status).toBe("complete");

    const history = await api("GET", "/funding/history");
    expect(history.status).toBe(200);
    expect(history.json.records.length).toBeGreaterThanOrEqual(2);
    for (const rec of history.json.records as Array<{ txHash: string | null; userOpHash: string | null; status: string }>) {
      expect(rec.status).toBe("complete");
      expect(typeof rec.txHash).toBe("string");
      expect(typeof rec.userOpHash).toBe("string");
    }
  });
});
