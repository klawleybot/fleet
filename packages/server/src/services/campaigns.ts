import { createPublicClient, formatEther, http, isAddress, parseEther, type Address } from "viem";
import { db } from "../db/index.js";
import type {
  CampaignExecutionResult,
  CampaignMetricsSnapshotRecord,
  CampaignPhase,
  CampaignPlan,
  CampaignPlanStep,
  CampaignRecord,
  CampaignSettlementMode,
  CampaignStatus,
} from "../types.js";
import { getChainConfig } from "./network.js";
import { logger } from "../logger.js";
import { getIntelligenceEngine } from "./intelligence.js";
import { swapFromSmartAccount, KLAWLEY_ACCOUNT_NAME, KLAWLEY_SMART_WALLET } from "./cdp.js";
import { recordTradePosition } from "./monitor.js";

const WETH_BASE = "0x4200000000000000000000000000000000000006" as const;
const ZERO = 0n;
const ONE_HOUR_MS = 60 * 60 * 1000;
const CAMPAIGN_DURATION_HOURS = 72;
const MAX_ACTIVE_CAMPAIGNS = 3;
const DEFAULT_STEP_INTERVAL_HOURS = 6;
const DEFAULT_BUY_SLIPPAGE_BPS = 700;
const DEFAULT_SELL_SLIPPAGE_BPS = 900;
const DEFAULT_MAX_BUY_STEP_ETH = parseEther("0.003");
const DEFAULT_MAX_SELL_STEP_BPS = 1500;
const BURN_VOLUME_THRESHOLD_USD = 2500;
const BURN_SWAP_THRESHOLD_24H = 20;
const BURN_MAX_GAIN_SHARE_BPS = 5000;
const TREASURY_RETAIN_GAIN_BPS = 5000;
const MIN_EXTERNAL_HOLDER_THRESHOLD = 8;
const DEFAULT_TARGET_SELF_SNIPE_BPS = 100;

type MetricsInput = {
  holders?: number | null;
  volume24hUsd?: number | null;
  swaps24h?: number | null;
  netFlow24hUsd?: number | null;
  momentumScore?: number | null;
  externalWalletBuyCount24h?: number | null;
};

interface IntelligenceCoinDetail {
  coin?: {
    volume_24h?: number | string | null;
  };
  analytics?: {
    swap_count_24h?: number | string | null;
    net_flow_usdc_24h?: number | string | null;
    momentum_score?: number | string | null;
    buy_count_24h?: number | string | null;
  };
}

export interface CreateCampaignInput {
  coinAddress: Address;
  name: string;
  symbol: string;
  deployTxHash?: string | null;
  deploySource?: string | null;
  metadataUri?: string | null;
  selfSnipeEthWei?: string | bigint | null;
  targetAllocationBps?: number;
  dryRun?: boolean;
  notes?: string | null;
  startedAt?: string;
}

export interface CampaignSnapshot {
  campaign: CampaignRecord;
  latestMetrics: CampaignMetricsSnapshotRecord | null;
  openSteps: CampaignPlanStep[];
}

export function getCampaignConstants() {
  return {
    maxActiveCampaigns: MAX_ACTIVE_CAMPAIGNS,
    durationHours: CAMPAIGN_DURATION_HOURS,
    defaultStepIntervalHours: DEFAULT_STEP_INTERVAL_HOURS,
    defaultBuySlippageBps: DEFAULT_BUY_SLIPPAGE_BPS,
    defaultSellSlippageBps: DEFAULT_SELL_SLIPPAGE_BPS,
  };
}

function nowIso() {
  return new Date().toISOString();
}

function parseBigintish(value: string | bigint | null | undefined, fallback = ZERO): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "string" && value.trim()) return BigInt(value);
  return fallback;
}

function clampInt(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, Math.round(n)));
}

function phaseForAgeHours(ageHours: number): CampaignPhase {
  if (ageHours >= 72) return "settlement";
  if (ageHours >= 48) return "late";
  if (ageHours >= 24) return "mid";
  return "launch";
}

function plannedBuysForPhase(phase: CampaignPhase): number {
  switch (phase) {
    case "launch": return 3;
    case "mid": return 2;
    case "late": return 1;
    case "settlement": return 0;
  }
}

function plannedSellsForPhase(phase: CampaignPhase): number {
  switch (phase) {
    case "launch": return 0;
    case "mid": return 1;
    case "late": return 2;
    case "settlement": return 0;
  }
}

type BlockscoutTokenCountersResponse = {
  token_holders_count?: number | string | null;
};

function isBlockscoutTokenCountersResponse(value: unknown): value is BlockscoutTokenCountersResponse {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as { token_holders_count?: unknown };
  return (
    candidate.token_holders_count === undefined ||
    candidate.token_holders_count === null ||
    typeof candidate.token_holders_count === "number" ||
    typeof candidate.token_holders_count === "string"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parseIntelligenceCoinDetail(value: unknown): IntelligenceCoinDetail | null {
  if (!isRecord(value)) return null;

  const coin = isRecord(value.coin) ? value.coin : undefined;
  const analytics = isRecord(value.analytics) ? value.analytics : undefined;

  const detail: IntelligenceCoinDetail = {};
  if (coin) {
    detail.coin = {
      volume_24h: typeof coin.volume_24h === "number" || typeof coin.volume_24h === "string" ? coin.volume_24h : null,
    };
  }
  if (analytics) {
    detail.analytics = {
      swap_count_24h:
        typeof analytics.swap_count_24h === "number" || typeof analytics.swap_count_24h === "string"
          ? analytics.swap_count_24h
          : null,
      net_flow_usdc_24h:
        typeof analytics.net_flow_usdc_24h === "number" || typeof analytics.net_flow_usdc_24h === "string"
          ? analytics.net_flow_usdc_24h
          : null,
      momentum_score:
        typeof analytics.momentum_score === "number" || typeof analytics.momentum_score === "string"
          ? analytics.momentum_score
          : null,
      buy_count_24h:
        typeof analytics.buy_count_24h === "number" || typeof analytics.buy_count_24h === "string"
          ? analytics.buy_count_24h
          : null,
    };
  }
  return detail;
}

async function getUniqueHolders(coinAddress: Address): Promise<number> {
  try {
    const resp = await fetch(`https://base.blockscout.com/api/v2/tokens/${coinAddress}/counters`);
    if (!resp.ok) return 0;
    const data: unknown = await resp.json();
    if (!isBlockscoutTokenCountersResponse(data)) return 0;
    return Number.parseInt(String(data.token_holders_count ?? "0"), 10) || 0;
  } catch {
    return 0;
  }
}

function asHexHash(value: string | null | undefined): `0x${string}` | null {
  if (!value?.startsWith("0x")) return null;
  return value as `0x${string}`;
}

function getWalletPositionForCoin(coinAddress: Address) {
  const wallets = db.listWallets();
  const wallet = wallets.find((w) => w.cdpAccountName === KLAWLEY_ACCOUNT_NAME || w.address.toLowerCase() === KLAWLEY_SMART_WALLET.toLowerCase());
  if (!wallet) return null;
  const position = db.getPosition(wallet.id, coinAddress);
  return { wallet, position };
}

export function createCampaignFromDeployment(input: CreateCampaignInput): CampaignRecord {
  if (!isAddress(input.coinAddress)) throw new Error(`Invalid coin address: ${String(input.coinAddress)}`);

  const active = db.listCampaignsByStatus(["active", "planned"]);
  if (active.length >= MAX_ACTIVE_CAMPAIGNS) {
    throw new Error(`Campaign capacity reached (${active.length}/${MAX_ACTIVE_CAMPAIGNS})`);
  }

  const startedAt = input.startedAt ?? nowIso();
  const endsAt = new Date(new Date(startedAt).getTime() + CAMPAIGN_DURATION_HOURS * ONE_HOUR_MS).toISOString();
  const selfSnipeEthWei = parseBigintish(input.selfSnipeEthWei, ZERO);

  const campaign = db.createCampaign({
    coinAddress: input.coinAddress.toLowerCase() as Address,
    name: input.name,
    symbol: input.symbol,
    status: "active",
    phase: "launch",
    deployTxHash: asHexHash(input.deployTxHash) ?? null,
    deploySource: input.deploySource ?? "daily-content-coin",
    metadataUri: input.metadataUri ?? null,
    targetAllocationBps: input.targetAllocationBps ?? DEFAULT_TARGET_SELF_SNIPE_BPS,
    selfSnipeEthWei: selfSnipeEthWei.toString(),
    totalBuyEthWei: selfSnipeEthWei.toString(),
    totalSellEthWei: "0",
    totalBurnedTokens: "0",
    pnlEthWei: "0",
    startedAt,
    endsAt,
    dryRun: input.dryRun ?? false,
    notes: input.notes ?? null,
  });

  if (selfSnipeEthWei > ZERO) {
    db.createCampaignExecution({
      campaignId: campaign.id,
      planId: null,
      stepId: null,
      side: "buy",
      status: "confirmed",
      amountInWei: selfSnipeEthWei.toString(),
      amountOutRaw: null,
      txHash: asHexHash(input.deployTxHash),
      userOpHash: null,
      summary: "integrated self-snipe on deploy",
      simulationOnly: input.dryRun ?? false,
      reason: "deploy-self-snipe",
      createdAt: startedAt,
      completedAt: startedAt,
    });
  }

  return campaign;
}

export async function snapshotCampaignMetrics(campaignId: number, overrides?: MetricsInput): Promise<CampaignMetricsSnapshotRecord> {
  const campaign = db.getCampaignById(campaignId);
  if (!campaign) throw new Error(`Campaign ${campaignId} not found`);

  let volume24hUsd = overrides?.volume24hUsd ?? 0;
  let swaps24h = overrides?.swaps24h ?? 0;
  let netFlow24hUsd = overrides?.netFlow24hUsd ?? 0;
  let momentumScore = overrides?.momentumScore ?? 0;
  let externalWalletBuyCount24h = overrides?.externalWalletBuyCount24h ?? 0;

  try {
    const intel = getIntelligenceEngine();
    const detail = parseIntelligenceCoinDetail(intel.getCoinDetail(campaign.coinAddress));
    volume24hUsd = overrides?.volume24hUsd ?? Number(detail?.coin?.volume_24h ?? 0);
    swaps24h = overrides?.swaps24h ?? Number(detail?.analytics?.swap_count_24h ?? 0);
    netFlow24hUsd = overrides?.netFlow24hUsd ?? Number(detail?.analytics?.net_flow_usdc_24h ?? 0);
    momentumScore = overrides?.momentumScore ?? Number(detail?.analytics?.momentum_score ?? 0);
    externalWalletBuyCount24h = overrides?.externalWalletBuyCount24h ?? Number(detail?.analytics?.buy_count_24h ?? 0);
  } catch {
    // intelligence optional in tests
  }

  const holders = overrides?.holders ?? await getUniqueHolders(campaign.coinAddress);
  const snapshot = db.createCampaignMetricsSnapshot({
    campaignId,
    holders: holders ?? 0,
    volume24hUsd,
    swaps24h,
    netFlow24hUsd,
    momentumScore,
    externalWalletBuyCount24h,
  });

  db.updateCampaign(campaignId, {
    holders: snapshot.holders,
    externalVolume24hUsd: snapshot.volume24hUsd,
    externalSwapCount24h: snapshot.swaps24h,
    lastMetricsAt: snapshot.createdAt,
  });

  return snapshot;
}

export function getCampaignSnapshot(campaignId: number): CampaignSnapshot {
  const campaign = db.getCampaignById(campaignId);
  if (!campaign) throw new Error(`Campaign ${campaignId} not found`);
  return {
    campaign,
    latestMetrics: db.getLatestCampaignMetricsSnapshot(campaignId),
    openSteps: db.listCampaignPlanSteps(campaignId, ["pending", "ready", "executing"]),
  };
}

function deriveSettlementMode(args: {
  pnlEthWei: bigint;
  latestMetrics: CampaignMetricsSnapshotRecord | null;
}): CampaignSettlementMode {
  const holders = args.latestMetrics?.holders ?? 0;
  const swaps24h = args.latestMetrics?.swaps24h ?? 0;
  const netFlow24h = args.latestMetrics?.netFlow24hUsd ?? 0;

  if (args.pnlEthWei <= ZERO) return "recover_1pct";
  if (holders < MIN_EXTERNAL_HOLDER_THRESHOLD) return "recover_1pct";
  if (swaps24h > 0 && netFlow24h < 0 && holders < MIN_EXTERNAL_HOLDER_THRESHOLD * 2) return "recover_1pct";
  return "retain_1pct";
}

function computeBurnAllowance(args: {
  pnlEthWei: bigint;
  latestMetrics: CampaignMetricsSnapshotRecord | null;
}): { shouldBurn: boolean; gainToBurnEthWei: bigint; reason: string } {
  const metrics = args.latestMetrics;
  if (!metrics) {
    return { shouldBurn: false, gainToBurnEthWei: ZERO, reason: "no metrics snapshot" };
  }
  if (args.pnlEthWei <= ZERO) {
    return { shouldBurn: false, gainToBurnEthWei: ZERO, reason: "campaign not profitable" };
  }
  if (metrics.volume24hUsd < BURN_VOLUME_THRESHOLD_USD) {
    return { shouldBurn: false, gainToBurnEthWei: ZERO, reason: `volume24h ${metrics.volume24hUsd} below ${BURN_VOLUME_THRESHOLD_USD}` };
  }
  if (metrics.swaps24h < BURN_SWAP_THRESHOLD_24H) {
    return { shouldBurn: false, gainToBurnEthWei: ZERO, reason: `swaps24h ${metrics.swaps24h} below ${BURN_SWAP_THRESHOLD_24H}` };
  }
  const burnShareBps = clampInt(
    Math.min(BURN_MAX_GAIN_SHARE_BPS, 1500 + Math.floor(metrics.swaps24h / 2) * 10),
    1000,
    BURN_MAX_GAIN_SHARE_BPS,
  );
  const gainToBurnEthWei = (args.pnlEthWei * BigInt(burnShareBps)) / 10_000n;
  return {
    shouldBurn: gainToBurnEthWei > ZERO,
    gainToBurnEthWei,
    reason: `external activity supports bounded burn (${burnShareBps} bps of gains)`,
  };
}

export function computeCampaignSettlement(campaignId: number) {
  const campaign = db.getCampaignById(campaignId);
  if (!campaign) throw new Error(`Campaign ${campaignId} not found`);

  const latestMetrics = db.getLatestCampaignMetricsSnapshot(campaignId);
  const pnlEthWei = parseBigintish(campaign.totalSellEthWei) - parseBigintish(campaign.totalBuyEthWei);
  const settlementMode = deriveSettlementMode({ pnlEthWei, latestMetrics });
  const burn = computeBurnAllowance({ pnlEthWei, latestMetrics });
  const retainedAllocationBps = settlementMode === "retain_1pct" ? campaign.targetAllocationBps : 0;
  const recoverAllocationBps = settlementMode === "recover_1pct" ? campaign.targetAllocationBps : 0;
  const treasuryGainEthWei = pnlEthWei > ZERO ? (pnlEthWei * BigInt(TREASURY_RETAIN_GAIN_BPS)) / 10_000n : ZERO;
  const burnGainEthWei = burn.shouldBurn ? burn.gainToBurnEthWei : ZERO;

  return {
    campaign,
    latestMetrics,
    pnlEthWei,
    settlementMode,
    retainedAllocationBps,
    recoverAllocationBps,
    treasuryGainEthWei,
    burnGainEthWei,
    burnReason: burn.reason,
  };
}

export async function planCampaign(campaignId: number, now = new Date()): Promise<CampaignPlan> {
  const campaign = db.getCampaignById(campaignId);
  if (!campaign) throw new Error(`Campaign ${campaignId} not found`);
  if (campaign.status !== "active" && campaign.status !== "planned") {
    throw new Error(`Campaign ${campaignId} is not plannable from status ${campaign.status}`);
  }

  const latestMetrics = await snapshotCampaignMetrics(campaignId).catch(() => db.getLatestCampaignMetricsSnapshot(campaignId));
  const ageHours = Math.max(0, (now.getTime() - new Date(campaign.startedAt).getTime()) / ONE_HOUR_MS);
  const phase = phaseForAgeHours(ageHours);
  const pendingSteps = db.listCampaignPlanSteps(campaignId, ["pending", "ready", "executing"]);
  if (pendingSteps.length > 0) {
    return db.createCampaignPlan({
      campaignId,
      phase,
      rationale: `existing ${pendingSteps.length} open plan steps retained`,
      status: "draft",
      plannedFor: nowIso(),
      maxConcurrentCampaigns: MAX_ACTIVE_CAMPAIGNS,
    });
  }

  const plan = db.createCampaignPlan({
    campaignId,
    phase,
    rationale: `deterministic ${phase} plan with conservative stair-step cadence`,
    status: "approved",
    plannedFor: nowIso(),
    maxConcurrentCampaigns: MAX_ACTIVE_CAMPAIGNS,
  });

  const buyCount = plannedBuysForPhase(phase);
  const sellCount = plannedSellsForPhase(phase);
  const intervalMs = DEFAULT_STEP_INTERVAL_HOURS * ONE_HOUR_MS;
  const holders = latestMetrics?.holders ?? 0;
  const activityScore = Math.max(0, (latestMetrics?.swaps24h ?? 0) + Math.floor((latestMetrics?.volume24hUsd ?? 0) / 500));
  const canSellLightly = holders >= 4 || activityScore >= 10;

  for (let i = 0; i < buyCount; i += 1) {
    const amount = DEFAULT_MAX_BUY_STEP_ETH - (BigInt(i) * parseEther("0.0005"));
    const scheduledFor = new Date(now.getTime() + i * intervalMs).toISOString();
    db.createCampaignPlanStep({
      campaignId,
      planId: plan.id,
      side: "buy",
      sequenceNo: i + 1,
      scheduledFor,
      amountWei: amount > ZERO ? amount.toString() : parseEther("0.001").toString(),
      slippageBps: DEFAULT_BUY_SLIPPAGE_BPS,
      status: i === 0 ? "ready" : "pending",
      rationale: `phase=${phase}; stair-step buy ${i + 1}/${buyCount}; holders=${holders}; activity=${activityScore}`,
    });
  }

  for (let i = 0; i < sellCount; i += 1) {
    const sellBps = canSellLightly ? Math.min(DEFAULT_MAX_SELL_STEP_BPS, 500 + i * 250) : 0;
    if (sellBps <= 0) continue;
    const scheduledFor = new Date(now.getTime() + (buyCount + i) * intervalMs).toISOString();
    db.createCampaignPlanStep({
      campaignId,
      planId: plan.id,
      side: "sell",
      sequenceNo: buyCount + i + 1,
      scheduledFor,
      amountWei: sellBps.toString(),
      slippageBps: DEFAULT_SELL_SLIPPAGE_BPS,
      status: "pending",
      rationale: `phase=${phase}; liquidity-aware distribution sell ${i + 1}/${sellCount}; holders=${holders}`,
    });
  }

  db.updateCampaign(campaignId, { phase, status: "active" });
  return plan;
}

function getDueExecutableSteps(now = new Date()): CampaignPlanStep[] {
  const active = db.listCampaignsByStatus(["active"])
    .sort((a, b) => new Date(a.startedAt).getTime() - new Date(b.startedAt).getTime())
    .slice(0, MAX_ACTIVE_CAMPAIGNS);
  const ids = new Set(active.map((c) => c.id));
  return db
    .listDueCampaignPlanSteps(now.toISOString())
    .filter((step) => ids.has(step.campaignId));
}

async function readCurrentTokenBalance(coinAddress: Address): Promise<bigint> {
  const chainCfg = getChainConfig();
  const client = createPublicClient({ chain: chainCfg.chain, transport: http(chainCfg.rpcUrl) });
  const balanceOfAbi = [{
    name: "balanceOf",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  }] as const;
  try {
    const result = await client.readContract({
      address: coinAddress,
      abi: balanceOfAbi,
      functionName: "balanceOf",
      args: [KLAWLEY_SMART_WALLET],
    });
    return result;
  } catch {
    const local = getWalletPositionForCoin(coinAddress);
    return local?.position ? BigInt(local.position.holdingsRaw) : ZERO;
  }
}

async function executePlanStep(step: CampaignPlanStep): Promise<CampaignExecutionResult> {
  const campaign = db.getCampaignById(step.campaignId);
  if (!campaign) throw new Error(`Campaign ${step.campaignId} missing for step ${step.id}`);

  db.updateCampaignPlanStep(step.id, { status: "executing", startedAt: nowIso() });
  const simulationOnly = campaign.dryRun || getChainConfig().network === "base-sepolia";

  if (simulationOnly) {
    const simulated = db.createCampaignExecution({
      campaignId: campaign.id,
      planId: step.planId,
      stepId: step.id,
      side: step.side,
      status: "simulated",
      amountInWei: step.amountWei,
      amountOutRaw: null,
      txHash: null,
      userOpHash: null,
      summary: `${step.side} simulated (${step.rationale})`,
      simulationOnly: true,
      reason: step.rationale,
      createdAt: nowIso(),
      completedAt: nowIso(),
    });
    db.updateCampaignPlanStep(step.id, { status: "confirmed", completedAt: nowIso(), executionId: simulated.id });
    return { execution: simulated, dryRun: true };
  }

  try {
    let swapResult: Awaited<ReturnType<typeof swapFromSmartAccount>>;
    let amountInWei = ZERO;

    if (step.side === "buy") {
      amountInWei = BigInt(step.amountWei);
      swapResult = await swapFromSmartAccount({
        smartAccountName: KLAWLEY_ACCOUNT_NAME,
        fromToken: WETH_BASE,
        toToken: campaign.coinAddress,
        fromAmount: amountInWei,
        slippageBps: step.slippageBps,
      });
    } else {
      const currentBalance = await readCurrentTokenBalance(campaign.coinAddress);
      const sellBps = BigInt(step.amountWei);
      const rawSell = (currentBalance * sellBps) / 10_000n;
      const minRetained = (currentBalance * BigInt(campaign.targetAllocationBps)) / 10_000n;
      amountInWei = currentBalance > minRetained ? rawSell : ZERO;
      if (currentBalance - amountInWei < minRetained) amountInWei = currentBalance > minRetained ? currentBalance - minRetained : ZERO;
      if (amountInWei <= ZERO) {
        const skipped = db.createCampaignExecution({
          campaignId: campaign.id,
          planId: step.planId,
          stepId: step.id,
          side: step.side,
          status: "skipped",
          amountInWei: "0",
          amountOutRaw: null,
          txHash: null,
          userOpHash: null,
          summary: `sell skipped to preserve retained allocation (${campaign.targetAllocationBps} bps)`,
          simulationOnly: false,
          reason: "retention floor",
          createdAt: nowIso(),
          completedAt: nowIso(),
        });
        db.updateCampaignPlanStep(step.id, { status: "confirmed", completedAt: nowIso(), executionId: skipped.id });
        return { execution: skipped, dryRun: false };
      }
      swapResult = await swapFromSmartAccount({
        smartAccountName: KLAWLEY_ACCOUNT_NAME,
        fromToken: campaign.coinAddress,
        toToken: WETH_BASE,
        fromAmount: amountInWei,
        slippageBps: step.slippageBps,
      });
    }

    const execution = db.createCampaignExecution({
      campaignId: campaign.id,
      planId: step.planId,
      stepId: step.id,
      side: step.side,
      status: swapResult.status === "complete" ? "confirmed" : "failed",
      amountInWei: amountInWei.toString(),
      amountOutRaw: swapResult.amountOut ?? null,
      txHash: swapResult.txHash ?? null,
      userOpHash: swapResult.userOpHash ?? null,
      summary: `${step.side} ${swapResult.status}`,
      simulationOnly: false,
      reason: step.rationale,
      createdAt: nowIso(),
      completedAt: nowIso(),
    });

    if (swapResult.status === "complete") {
      const walletRef = getWalletPositionForCoin(campaign.coinAddress);
      if (walletRef) {
        recordTradePosition({
          walletId: walletRef.wallet.id,
          coinAddress: campaign.coinAddress,
          isBuy: step.side === "buy",
          ethAmountWei: step.side === "buy" ? amountInWei.toString() : (swapResult.amountOut ?? "0"),
          tokenAmount: step.side === "buy" ? (swapResult.amountOut ?? "0") : amountInWei.toString(),
        });
      }

      const totalBuyEthWei = parseBigintish(campaign.totalBuyEthWei) + (step.side === "buy" ? amountInWei : ZERO);
      const totalSellEthWei = parseBigintish(campaign.totalSellEthWei) + (step.side === "sell" ? parseBigintish(swapResult.amountOut) : ZERO);
      const pnlEthWei = totalSellEthWei - totalBuyEthWei;
      db.updateCampaign(campaign.id, {
        totalBuyEthWei: totalBuyEthWei.toString(),
        totalSellEthWei: totalSellEthWei.toString(),
        pnlEthWei: pnlEthWei.toString(),
        lastExecutionAt: nowIso(),
      });
      db.updateCampaignPlanStep(step.id, { status: "confirmed", completedAt: nowIso(), executionId: execution.id });
    } else {
      db.updateCampaignPlanStep(step.id, { status: "failed", completedAt: nowIso(), executionId: execution.id });
    }

    return { execution, dryRun: false };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const failed = db.createCampaignExecution({
      campaignId: campaign.id,
      planId: step.planId,
      stepId: step.id,
      side: step.side,
      status: "failed",
      amountInWei: step.amountWei,
      amountOutRaw: null,
      txHash: null,
      userOpHash: null,
      summary: message,
      simulationOnly: false,
      reason: step.rationale,
      createdAt: nowIso(),
      completedAt: nowIso(),
    });
    db.updateCampaignPlanStep(step.id, { status: "failed", completedAt: nowIso(), executionId: failed.id });
    throw error;
  }
}

export async function runCampaignExecutorOnce(now = new Date()): Promise<{ executed: CampaignExecutionResult[]; settled: number[]; }> {
  const dueSteps = getDueExecutableSteps(now);
  const executed: CampaignExecutionResult[] = [];
  for (const step of dueSteps) {
    executed.push(await executePlanStep(step));
  }

  const settled: number[] = [];
  const activeCampaigns = db.listCampaignsByStatus(["active"]);
  for (const campaign of activeCampaigns) {
    if (new Date(campaign.endsAt).getTime() <= now.getTime()) {
      await settleCampaign(campaign.id);
      settled.push(campaign.id);
    }
  }

  return { executed, settled };
}

export async function settleCampaign(campaignId: number) {
  const campaign = db.getCampaignById(campaignId);
  if (!campaign) throw new Error(`Campaign ${campaignId} not found`);

  const priorMetrics = db.getLatestCampaignMetricsSnapshot(campaignId);
  const latestMetrics = await snapshotCampaignMetrics(campaignId).catch(() => priorMetrics);
  if (priorMetrics && latestMetrics) {
    const mergedHolders = Math.max(priorMetrics.holders, latestMetrics.holders);
    const mergedVolume = Math.max(priorMetrics.volume24hUsd, latestMetrics.volume24hUsd);
    const mergedSwaps = Math.max(priorMetrics.swaps24h, latestMetrics.swaps24h);
    const mergedNetFlow = Math.max(priorMetrics.netFlow24hUsd, latestMetrics.netFlow24hUsd);
    const mergedMomentum = Math.max(priorMetrics.momentumScore, latestMetrics.momentumScore);
    const mergedBuys = Math.max(priorMetrics.externalWalletBuyCount24h, latestMetrics.externalWalletBuyCount24h);
    if (
      mergedHolders !== latestMetrics.holders ||
      mergedVolume !== latestMetrics.volume24hUsd ||
      mergedSwaps !== latestMetrics.swaps24h ||
      mergedNetFlow !== latestMetrics.netFlow24hUsd ||
      mergedMomentum !== latestMetrics.momentumScore ||
      mergedBuys !== latestMetrics.externalWalletBuyCount24h
    ) {
      db.createCampaignMetricsSnapshot({
        campaignId,
        holders: mergedHolders,
        volume24hUsd: mergedVolume,
        swaps24h: mergedSwaps,
        netFlow24hUsd: mergedNetFlow,
        momentumScore: mergedMomentum,
        externalWalletBuyCount24h: mergedBuys,
      });
      db.updateCampaign(campaignId, {
        holders: mergedHolders,
        externalVolume24hUsd: mergedVolume,
        externalSwapCount24h: mergedSwaps,
        lastMetricsAt: nowIso(),
      });
    }
  }
  const summary = computeCampaignSettlement(campaignId);
  const notes = [
    `settlement=${summary.settlementMode}`,
    `pnl=${formatEther(summary.pnlEthWei)} ETH`,
    `treasury=${formatEther(summary.treasuryGainEthWei)} ETH`,
    `burn=${formatEther(summary.burnGainEthWei)} ETH`,
    `reason=${summary.burnReason}`,
  ].join(" | ");

  db.updateCampaign(campaignId, {
    status: "settled",
    phase: "settlement",
    settlementMode: summary.settlementMode,
    settlementAt: nowIso(),
    pnlEthWei: summary.pnlEthWei.toString(),
    settlementNotes: notes,
    retainedAllocationBps: summary.retainedAllocationBps,
    recoverAllocationBps: summary.recoverAllocationBps,
    treasuryRetainedEthWei: summary.treasuryGainEthWei.toString(),
    burnGainEthWei: summary.burnGainEthWei.toString(),
  });

  if (summary.burnGainEthWei > ZERO) {
    db.createCampaignExecution({
      campaignId,
      planId: null,
      stepId: null,
      side: "burn",
      status: "confirmed",
      amountInWei: summary.burnGainEthWei.toString(),
      amountOutRaw: null,
      txHash: null,
      userOpHash: null,
      summary: `bounded burn booked from gains: ${formatEther(summary.burnGainEthWei)} ETH equivalent`,
      simulationOnly: campaign.dryRun,
      reason: summary.burnReason,
      createdAt: nowIso(),
      completedAt: nowIso(),
    });
  }

  return {
    campaign: db.getCampaignById(campaignId)!,
    latestMetrics,
    settlement: summary,
  };
}

export function listCampaigns(statuses?: CampaignStatus[]) {
  return statuses?.length ? db.listCampaignsByStatus(statuses) : db.listCampaigns();
}

export async function ensurePlansForActiveCampaigns(): Promise<CampaignPlan[]> {
  const campaigns = db.listCampaignsByStatus(["active"])
    .sort((a, b) => new Date(a.startedAt).getTime() - new Date(b.startedAt).getTime())
    .slice(0, MAX_ACTIVE_CAMPAIGNS);
  const plans: CampaignPlan[] = [];
  for (const campaign of campaigns) {
    const openSteps = db.listCampaignPlanSteps(campaign.id, ["pending", "ready", "executing"]);
    if (openSteps.length === 0) {
      plans.push(await planCampaign(campaign.id));
    }
  }
  return plans;
}

export async function runCampaignPlannerOnce() {
  const plans = await ensurePlansForActiveCampaigns();
  logger.info({ plans: plans.length }, "campaign planner tick complete");
  return plans;
}
