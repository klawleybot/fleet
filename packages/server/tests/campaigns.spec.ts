import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const tmpDirs: string[] = [];
const ENV_KEYS = [
  "VITEST",
  "VITEST_SQLITE_PATH",
  "SQLITE_PATH",
] as const;
const ORIGINAL_ENV = new Map<string, string | undefined>(
  ENV_KEYS.map((key) => [key, process.env[key]]),
);

type DbModule = typeof import("../src/db/index.js");

let currentDbModule: DbModule | null = null;

function makeDbPath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-campaigns-"));
  tmpDirs.push(dir);
  return path.join(dir, "test.sqlite");
}

function restoreEnv() {
  for (const key of ENV_KEYS) {
    const original = ORIGINAL_ENV.get(key);
    if (original === undefined) delete process.env[key];
    else process.env[key] = original;
  }
}

async function loadModules(dbPath: string) {
  vi.resetModules();
  process.env.VITEST = "1";
  process.env.VITEST_SQLITE_PATH = dbPath;
  process.env.SQLITE_PATH = dbPath;
  const dbMod = await import("../src/db/index.js");
  currentDbModule = dbMod;
  const campaigns = await import("../src/services/campaigns.js");
  return { ...dbMod, ...campaigns };
}

describe("campaign services", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      json: async () => ({ token_holders_count: "12" }),
    })));
  });

  afterEach(() => {
    currentDbModule?.resetDb();
    currentDbModule = null;
    restoreEnv();
    for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  it("creates campaign from deployment and records self-snipe execution", async () => {
    const dbPath = makeDbPath();
    const { db, createCampaignFromDeployment } = await loadModules(dbPath);

    const campaign = await createCampaignFromDeployment({
      coinAddress: "0x1111111111111111111111111111111111111111",
      name: "Klaw Coin",
      symbol: "KLAW",
      deployTxHash: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      metadataUri: "ipfs://meta",
      selfSnipeEthWei: "1000000000000000",
      dryRun: true,
    });

    expect(campaign.status).toBe("active");
    expect(campaign.phase).toBe("launch");
    expect(campaign.totalBuyEthWei).toBe("1000000000000000");

    const executions = db.listCampaignExecutions(campaign.id);
    expect(executions).toHaveLength(1);
    expect(executions[0]?.side).toBe("buy");
    expect(executions[0]?.summary).toContain("integrated self-snipe");
  });

  it("plans deterministic launch steps with first step ready", async () => {
    const dbPath = makeDbPath();
    const { db, createCampaignFromDeployment, planCampaign } = await loadModules(dbPath);

    const campaign = await createCampaignFromDeployment({
      coinAddress: "0x2222222222222222222222222222222222222222",
      name: "Paint Stair",
      symbol: "STAIR",
      selfSnipeEthWei: "0",
    });

    const plan = await planCampaign(campaign.id, new Date(campaign.startedAt));
    expect(plan.phase).toBe("launch");

    const steps = db.listCampaignPlanSteps(campaign.id);
    expect(steps.map((s) => s.side)).toEqual(["buy", "buy", "buy"]);
    expect(steps[0]?.status).toBe("ready");
    expect(steps[1]?.status).toBe("pending");
    expect(BigInt(steps[0]!.amountWei)).toBeGreaterThan(BigInt(steps[1]!.amountWei));
  });

  it("adds light sells in late phase when activity supports it", async () => {
    const dbPath = makeDbPath();
    const { db, createCampaignFromDeployment, planCampaign } = await loadModules(dbPath);

    const startedAt = new Date(Date.now() - 60 * 3600 * 1000).toISOString();
    const campaign = await createCampaignFromDeployment({
      coinAddress: "0x3333333333333333333333333333333333333333",
      name: "Late Runner",
      symbol: "LATE",
      startedAt,
    });

    db.createCampaignMetricsSnapshot({
      campaignId: campaign.id,
      holders: 12,
      volume24hUsd: 4200,
      swaps24h: 31,
      netFlow24hUsd: 800,
      momentumScore: 3,
      externalWalletBuyCount24h: 14,
    });

    const plan = await planCampaign(campaign.id, new Date(Date.now() - 1_000));
    expect(plan.phase).toBe("late");

    const steps = db.listCampaignPlanSteps(campaign.id);
    expect(steps.some((s) => s.side === "sell")).toBe(true);
    const sellSteps = steps.filter((s) => s.side === "sell");
    expect(sellSteps.every((s) => Number(s.amountWei) > 0)).toBe(true);
  });

  it("settles negative or farmed campaigns into recover mode", async () => {
    const dbPath = makeDbPath();
    const { db, createCampaignFromDeployment, computeCampaignSettlement, settleCampaign } = await loadModules(dbPath);

    const campaign = await createCampaignFromDeployment({
      coinAddress: "0x4444444444444444444444444444444444444444",
      name: "Farm Bait",
      symbol: "FARM",
      selfSnipeEthWei: "3000000000000000",
    });

    db.updateCampaign(campaign.id, {
      totalBuyEthWei: "5000000000000000",
      totalSellEthWei: "1000000000000000",
    });
    db.createCampaignMetricsSnapshot({
      campaignId: campaign.id,
      holders: 3,
      volume24hUsd: 400,
      swaps24h: 2,
      netFlow24hUsd: -120,
      momentumScore: 0,
      externalWalletBuyCount24h: 1,
    });

    const summary = computeCampaignSettlement(campaign.id);
    expect(summary.settlementMode).toBe("recover_1pct");
    expect(summary.recoverAllocationBps).toBe(100);
    expect(summary.burnGainEthWei).toBe(0n);

    const settled = await settleCampaign(campaign.id);
    expect(settled.campaign.status).toBe("settled");
    expect(settled.campaign.settlementMode).toBe("recover_1pct");
  });

  it("settles profitable campaigns with bounded burn when activity is real", async () => {
    const dbPath = makeDbPath();
    const { db, createCampaignFromDeployment, computeCampaignSettlement, settleCampaign } = await loadModules(dbPath);

    const campaign = await createCampaignFromDeployment({
      coinAddress: "0x5555555555555555555555555555555555555555",
      name: "Real Flow",
      symbol: "FLOW",
      selfSnipeEthWei: "1000000000000000",
    });

    db.updateCampaign(campaign.id, {
      totalBuyEthWei: "2000000000000000",
      totalSellEthWei: "7000000000000000",
    });
    db.createCampaignMetricsSnapshot({
      campaignId: campaign.id,
      holders: 18,
      volume24hUsd: 9000,
      swaps24h: 48,
      netFlow24hUsd: 1600,
      momentumScore: 6,
      externalWalletBuyCount24h: 27,
    });

    const summary = computeCampaignSettlement(campaign.id);
    expect(summary.settlementMode).toBe("retain_1pct");
    expect(summary.retainedAllocationBps).toBe(100);
    expect(summary.treasuryGainEthWei).toBeGreaterThan(0n);
    expect(summary.burnGainEthWei).toBeGreaterThan(0n);

    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      json: async () => ({ token_holders_count: "18" }),
    })));

    const settled = await settleCampaign(campaign.id);
    expect(settled.campaign.status).toBe("settled");
    const executions = db.listCampaignExecutions(campaign.id);
    expect(executions.some((e) => e.side === "burn" && e.status === "confirmed")).toBe(true);
  });
});
