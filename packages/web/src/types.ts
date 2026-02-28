// ============================================================
// Wallet
// ============================================================

export interface Wallet {
  id: number;
  name: string;
  address: `0x${string}`;
  cdpAccountName: string;
  ownerAddress: `0x${string}`;
  type: "smart";
  isMaster: boolean;
  createdAt: string;
}

// ============================================================
// Trades & Funding
// ============================================================

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
  status: "pending" | "complete" | "failed";
  errorMessage: string | null;
  createdAt: string;
}

export interface FundingRecord {
  id: number;
  fromWalletId: number;
  toWalletId: number;
  amountWei: string;
  userOpHash: `0x${string}` | null;
  txHash: `0x${string}` | null;
  status: "pending" | "complete" | "failed";
  errorMessage: string | null;
  createdAt: string;
}

// ============================================================
// Positions
// ============================================================

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

// ============================================================
// Clusters & Operations
// ============================================================

export interface ClusterRecord {
  id: number;
  name: string;
  strategyMode: "sync" | "staggered" | "momentum";
  createdAt: string;
}

export type OperationType = "FUNDING_REQUEST" | "SUPPORT_COIN" | "EXIT_COIN";
export type OperationStatus = "pending" | "approved" | "executing" | "complete" | "failed";

export interface OperationRecord {
  id: number;
  type: OperationType;
  clusterId: number;
  status: OperationStatus;
  requestedBy: string;
  approvedBy: string | null;
  payloadJson: string;
  resultJson: string | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
}

// ============================================================
// Fleets
// ============================================================

export interface FleetInfo {
  name: string;
  clusterId: number;
  strategyMode: "sync" | "staggered" | "momentum";
  wallets: Wallet[];
}

// ============================================================
// Dashboard
// ============================================================

export interface WalletBalance {
  name: string;
  address: `0x${string}`;
  balanceWei: string;
}

export interface CoinSummary {
  coinAddress: `0x${string}`;
  totalCostWei: string;
  totalReceivedWei: string;
  totalHoldings: string;
  totalCurrentValueWei: string | null;
  totalRealizedPnlWei: string;
  totalUnrealizedPnlWei: string | null;
  walletCount: number;
}

export interface FleetDashboard {
  name: string;
  clusterId: number;
  walletCount: number;
  wallets: WalletBalance[];
  totalEthWei: string;
  totalEth: string;
  totalCostWei: string;
  totalReceivedWei: string;
  realizedPnlWei: string;
  realizedPnl: string;
  coinSummaries: CoinSummary[];
}

export interface GlobalDashboard {
  master: WalletBalance;
  fleets: FleetDashboard[];
  totalAvailableEthWei: string;
  totalAvailableEth: string;
  globalCostWei: string;
  globalReceivedWei: string;
  globalRealizedPnlWei: string;
  globalRealizedPnl: string;
}

// ============================================================
// Autonomy
// ============================================================

export interface AutonomyStatus {
  running: boolean;
  intervalSec: number;
  isTicking: boolean;
  lastTick: {
    startedAt: string;
    finishedAt: string;
    createdOperationIds: number[];
    executedOperationIds: number[];
    skipped: Array<{ operationId?: number; reason: string }>;
    errors: string[];
  } | null;
}

// ============================================================
// Intelligence
// ============================================================

export interface IntelligenceStatus {
  running: boolean;
  intervalSec: number;
  isTicking: boolean;
  lastTick: {
    syncedRecent: number;
    syncedTop: number;
    swaps: number;
    clusters: number;
    analytics: number;
    alerts: number;
    startedAt: string;
    finishedAt: string;
    errors: string[];
  } | null;
}

export interface IntelligenceSummary {
  coinCount: number;
  alertCount: number;
  watchlistCount: number;
  status: IntelligenceStatus;
}

export interface IntelCoin {
  address: string;
  symbol: string | null;
  name: string | null;
  created_at: string | null;
  volume_24h: number;
  market_cap: number;
  coin_url: string;
}

export interface IntelAnalytics {
  coin_address: string;
  symbol: string | null;
  name: string | null;
  market_cap: number | null;
  volume_24h: number | null;
  swap_count_1h: number;
  unique_traders_1h: number;
  buy_count_1h: number;
  sell_count_1h: number;
  buy_volume_usdc_1h: number;
  sell_volume_usdc_1h: number;
  net_flow_usdc_1h: number;
  momentum_score_1h: number;
  momentum_acceleration_1h: number;
  swap_count_24h: number;
  unique_traders_24h: number;
  net_flow_usdc_24h: number;
  momentum_score: number;
  coin_url: string;
}

export interface IntelAlert {
  type: string;
  entity_id: string | null;
  severity: string;
  message: string;
  created_at: string;
  coin_url: string | null;
}

export interface WatchlistItem {
  list_name: string;
  coin_address: string;
  label: string | null;
  notes: string | null;
  enabled: number;
  updated_at: string;
  symbol: string | null;
  name: string | null;
  volume_24h: number | null;
  swap_count_1h: number | null;
  net_flow_usdc_1h: number | null;
  momentum_score_1h: number | null;
  momentum_acceleration_1h: number | null;
  swap_count_24h: number | null;
  momentum_score: number | null;
  coin_url: string;
}

// ============================================================
// Health
// ============================================================

export interface HealthResponse {
  status: string;
  uptime: number;
  fleetCount: number;
  lastTrade: string | null;
  masterBalance: string | null;
}
