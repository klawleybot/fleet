export type WalletType = "smart";

export interface WalletRecord {
  id: number;
  name: string;
  address: `0x${string}`;
  cdpAccountName: string;
  ownerAddress: `0x${string}`;
  type: WalletType;
  isMaster: boolean;
  createdAt: string;
}

export type TradeStatus = "pending" | "complete" | "failed";
export type FundingStatus = "pending" | "complete" | "failed";

export interface TradeRecord {
  id: number;
  walletId: number;
  fromToken: `0x${string}`;
  toToken: `0x${string}`;
  amountIn: string;
  amountOut: string | null;
  operationId: number | null;
  userOpHash: `0x${string}` | null;
  txHash: `0x${string}` | null;
  status: TradeStatus;
  errorMessage: string | null;
  createdAt: string;
}

export interface PositionRecord {
  id: number;
  walletId: number;
  coinAddress: `0x${string}`;
  totalCostWei: string;
  totalReceivedWei: string;
  holdingsRaw: string;
  realizedPnlWei: string;
  buyCount: number;
  sellCount: number;
  lastActionAt: string;
}

export interface FundingRecord {
  id: number;
  fromWalletId: number;
  toWalletId: number;
  amountWei: string;
  userOpHash: `0x${string}` | null;
  txHash: `0x${string}` | null;
  status: FundingStatus;
  errorMessage: string | null;
  createdAt: string;
}

export interface FundingRequestBody {
  toWalletIds: number[];
  amountWei: string;
}

export interface SwapRequestBody {
  walletIds: number[];
  fromToken: `0x${string}`;
  toToken: `0x${string}`;
  amountInWei: string;
  slippageBps: number;
}

export type StrategyMode = "sync" | "staggered" | "momentum";

export interface ClusterRecord {
  id: number;
  name: string;
  strategyMode: StrategyMode;
  createdAt: string;
}

export interface ClusterWalletRecord {
  clusterId: number;
  walletId: number;
  enabled: boolean;
  weight: number;
  addedAt: string;
}

export interface SwingConfigRecord {
  id: number;
  fleetName: string;
  coinAddress: `0x${string}`;
  takeProfitBps: number;
  stopLossBps: number;
  trailingStopBps: number | null;
  cooldownSec: number;
  slippageBps: number;
  enabled: boolean;
  peakPnlBps: number | null;
  lastActionAt: string | null;
  createdAt: string;
}

export type OperationType = "FUNDING_REQUEST" | "SUPPORT_COIN" | "EXIT_COIN";
export type OperationStatus = "pending" | "approved" | "executing" | "complete" | "failed";

export interface OperationRecord {
  id: number;
  type: OperationType;
  clusterId: number;
  status: OperationStatus;
  requestedBy: string | null;
  approvedBy: string | null;
  payloadJson: string;
  resultJson: string | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
}

export type CampaignStatus = "planned" | "active" | "paused" | "settled" | "cancelled";
export type CampaignPhase = "launch" | "mid" | "late" | "settlement";
export type CampaignSettlementMode = "recover_1pct" | "retain_1pct";
export type CampaignPlanStatus = "draft" | "approved" | "superseded" | "completed";
export type CampaignPlanStepStatus = "pending" | "ready" | "executing" | "confirmed" | "failed" | "cancelled";
export type CampaignTradeSide = "buy" | "sell" | "burn";
export type CampaignExecutionStatus = "simulated" | "confirmed" | "failed" | "skipped";

export interface CampaignRecord {
  id: number;
  coinAddress: `0x${string}`;
  name: string;
  symbol: string;
  status: CampaignStatus;
  phase: CampaignPhase;
  deployTxHash: `0x${string}` | null;
  deploySource: string | null;
  metadataUri: string | null;
  targetAllocationBps: number;
  selfSnipeEthWei: string;
  totalBuyEthWei: string;
  totalSellEthWei: string;
  totalBurnedTokens: string;
  pnlEthWei: string;
  holders: number;
  externalVolume24hUsd: number;
  externalSwapCount24h: number;
  lastMetricsAt: string | null;
  lastExecutionAt: string | null;
  startedAt: string;
  endsAt: string;
  settlementMode: CampaignSettlementMode | null;
  settlementAt: string | null;
  settlementNotes: string | null;
  retainedAllocationBps: number;
  recoverAllocationBps: number;
  treasuryRetainedEthWei: string;
  burnGainEthWei: string;
  dryRun: boolean;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CampaignMetricsSnapshotRecord {
  id: number;
  campaignId: number;
  holders: number;
  volume24hUsd: number;
  swaps24h: number;
  netFlow24hUsd: number;
  momentumScore: number;
  externalWalletBuyCount24h: number;
  createdAt: string;
}

export interface CampaignPlan {
  id: number;
  campaignId: number;
  phase: CampaignPhase;
  rationale: string;
  status: CampaignPlanStatus;
  plannedFor: string;
  maxConcurrentCampaigns: number;
  createdAt: string;
}

export interface CampaignPlanStep {
  id: number;
  campaignId: number;
  planId: number;
  side: CampaignTradeSide;
  sequenceNo: number;
  scheduledFor: string;
  amountWei: string;
  slippageBps: number;
  status: CampaignPlanStepStatus;
  rationale: string;
  startedAt: string | null;
  completedAt: string | null;
  executionId: number | null;
  createdAt: string;
}

export interface CampaignExecutionRecord {
  id: number;
  campaignId: number;
  planId: number | null;
  stepId: number | null;
  side: CampaignTradeSide;
  status: CampaignExecutionStatus;
  amountInWei: string;
  amountOutRaw: string | null;
  txHash: `0x${string}` | null;
  userOpHash: `0x${string}` | null;
  summary: string | null;
  simulationOnly: boolean;
  reason: string | null;
  createdAt: string;
  completedAt: string | null;
}

export interface CampaignExecutionResult {
  execution: CampaignExecutionRecord;
  dryRun: boolean;
}
