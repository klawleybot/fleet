import type {
  AutonomyStatus,
  DeterministicRoute,
  FleetDashboard,
  FleetInfo,
  FundingRecord,
  GlobalDashboard,
  HealthResponse,
  IntelAlert,
  IntelAnalytics,
  IntelCoin,
  IntelligenceStatus,
  IntelligenceSummary,
  OperationRecord,
  PositionRecord,
  TradeRecord,
  Wallet,
  WatchlistItem,
  ZoraSignalCandidate,
  ZoraSignalMode,
} from "../types";

const API_BASE = import.meta.env.VITE_API_BASE_URL ?? "http://localhost:4020";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  });

  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new Error(payload?.error ?? `Request failed (${response.status})`);
  }

  return response.json() as Promise<T>;
}

// ============================================================
// Health
// ============================================================

export async function fetchHealth(): Promise<HealthResponse> {
  return request<HealthResponse>("/health");
}

// ============================================================
// Wallets
// ============================================================

export async function fetchWallets(): Promise<Wallet[]> {
  const payload = await request<{ wallets: Wallet[] }>("/wallets");
  return payload.wallets;
}

export async function createFleetWallets(count: number): Promise<Wallet[]> {
  const payload = await request<{ created: Wallet[] }>("/wallets", {
    method: "POST",
    body: JSON.stringify({ count }),
  });
  return payload.created;
}

export async function deleteWallet(walletId: number): Promise<boolean> {
  const payload = await request<{ deleted: boolean }>(`/wallets/${walletId}`, {
    method: "DELETE",
  });
  return payload.deleted;
}

export async function fetchWalletEthBalance(walletId: number): Promise<string> {
  const payload = await request<{ ethBalanceWei: string }>(`/wallets/${walletId}/balance`);
  return payload.ethBalanceWei;
}

// ============================================================
// Funding
// ============================================================

export async function distributeFunding(input: {
  toWalletIds: number[];
  amountWei: string;
}): Promise<FundingRecord[]> {
  const payload = await request<{ records: FundingRecord[] }>("/funding/distribute", {
    method: "POST",
    body: JSON.stringify(input),
  });
  return payload.records;
}

export async function fetchFundingHistory(): Promise<FundingRecord[]> {
  const payload = await request<{ records: FundingRecord[] }>("/funding/history");
  return payload.records;
}

// ============================================================
// Trades
// ============================================================

export async function executeSwap(input: {
  walletIds: number[];
  fromToken: `0x${string}`;
  toToken: `0x${string}`;
  amountInWei: string;
  slippageBps: number;
}): Promise<TradeRecord[]> {
  const payload = await request<{ records: TradeRecord[] }>("/trades/swap", {
    method: "POST",
    body: JSON.stringify(input),
  });
  return payload.records;
}

export async function fetchTradeHistory(): Promise<TradeRecord[]> {
  const payload = await request<{ records: TradeRecord[] }>("/trades/history");
  return payload.records;
}

// ============================================================
// Fleets
// ============================================================

export async function fetchFleets(): Promise<FleetInfo[]> {
  const payload = await request<{ fleets: FleetInfo[] }>("/fleets");
  return payload.fleets;
}

export async function createFleet(input: {
  name: string;
  wallets: number;
  fundAmountWei?: string;
  strategyMode?: "sync" | "staggered" | "momentum";
}): Promise<unknown> {
  return request("/fleets", { method: "POST", body: JSON.stringify(input) });
}

export async function deleteFleet(name: string): Promise<boolean> {
  const payload = await request<{ deleted: boolean }>(`/fleets/${encodeURIComponent(name)}`, {
    method: "DELETE",
  });
  return payload.deleted;
}

export async function fetchFleetStatus(name: string): Promise<FleetDashboard> {
  return request<FleetDashboard>(`/fleets/${encodeURIComponent(name)}/status`);
}

export async function buyFleetCoin(
  fleetName: string,
  input: {
    coinAddress: `0x${string}`;
    totalAmountWei: string;
    slippageBps: number;
    overMs?: number;
    intervals?: number;
    jiggle?: boolean;
  },
): Promise<{ operation: OperationRecord }> {
  return request<{ operation: OperationRecord }>(`/fleets/${encodeURIComponent(fleetName)}/buy`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function sellFleetCoin(
  fleetName: string,
  input: {
    coinAddress: `0x${string}`;
    totalAmountWei: string;
    slippageBps: number;
    overMs?: number;
  },
): Promise<{ operation: OperationRecord }> {
  return request<{ operation: OperationRecord }>(`/fleets/${encodeURIComponent(fleetName)}/sell`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

// ============================================================
// Dashboard
// ============================================================

export async function fetchGlobalDashboard(): Promise<GlobalDashboard> {
  return request<GlobalDashboard>("/dashboard");
}

export async function fetchFleetDashboard(fleetName: string): Promise<FleetDashboard> {
  return request<FleetDashboard>(`/dashboard/fleet/${encodeURIComponent(fleetName)}`);
}

// ============================================================
// Positions
// ============================================================

export async function fetchAllPositions(): Promise<PositionRecord[]> {
  const payload = await request<{ positions: PositionRecord[] }>("/positions");
  return payload.positions;
}

export interface ImportPositionResult {
  imported: PositionRecord[];
  skippedCount: number;
  noBalanceCount: number;
}

export async function importPosition(coinAddress: string): Promise<ImportPositionResult> {
  return request<ImportPositionResult>("/positions/import", {
    method: "POST",
    body: JSON.stringify({ coinAddress }),
  });
}

// ============================================================
// Operations
// ============================================================

export async function fetchOperations(limit = 100): Promise<OperationRecord[]> {
  const payload = await request<{ operations: OperationRecord[] }>(`/operations?limit=${limit}`);
  return payload.operations;
}

export async function fetchZoraSignalCandidates(input: {
  mode: ZoraSignalMode;
  listName?: string;
  minMomentum?: number;
  limit?: number;
}): Promise<ZoraSignalCandidate[]> {
  const params = new URLSearchParams({ mode: input.mode });
  if (input.listName) params.set("listName", input.listName);
  if (input.minMomentum !== undefined) params.set("minMomentum", String(input.minMomentum));
  if (input.limit !== undefined) params.set("limit", String(input.limit));

  const payload = await request<{ candidates: ZoraSignalCandidate[] }>(`/operations/zora-signals?${params.toString()}`);
  return payload.candidates;
}

export async function requestSupportFromZoraSignal(input: {
  clusterId: number;
  mode: ZoraSignalMode;
  listName?: string;
  minMomentum?: number;
  totalAmountWei: string;
  slippageBps: number;
  strategyMode?: "sync" | "staggered" | "momentum";
  requestedBy?: string;
}): Promise<{ operation: OperationRecord }> {
  return request<{ operation: OperationRecord }>("/operations/support-from-zora-signal", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function fetchRoutePreview(input: {
  fromToken: `0x${string}`;
  toToken: `0x${string}`;
  maxHops?: number;
}): Promise<DeterministicRoute> {
  const payload = await request<{ route: DeterministicRoute }>("/operations/route-preview", {
    method: "POST",
    body: JSON.stringify(input),
  });
  return payload.route;
}

export async function approveAndExecuteOperation(
  operationId: number,
  approvedBy?: string,
): Promise<OperationRecord> {
  const payload = await request<{ operation: OperationRecord }>(`/operations/${operationId}/approve-execute`, {
    method: "POST",
    body: JSON.stringify(approvedBy ? { approvedBy } : {}),
  });
  return payload.operation;
}

// ============================================================
// Autonomy
// ============================================================

export async function fetchAutonomyStatus(): Promise<AutonomyStatus> {
  return request<AutonomyStatus>("/autonomy/status");
}

export async function startAutonomy(intervalSec?: number): Promise<AutonomyStatus> {
  return request<AutonomyStatus>("/autonomy/start", {
    method: "POST",
    body: JSON.stringify(intervalSec !== undefined ? { intervalSec } : {}),
  });
}

export async function stopAutonomy(): Promise<AutonomyStatus> {
  return request<AutonomyStatus>("/autonomy/stop", { method: "POST", body: JSON.stringify({}) });
}

export async function runAutonomyTick(): Promise<unknown> {
  return request("/autonomy/tick", { method: "POST", body: JSON.stringify({}) });
}

// ============================================================
// Intelligence
// ============================================================

export async function fetchIntelligenceStatus(): Promise<IntelligenceStatus> {
  return request<IntelligenceStatus>("/intelligence/status");
}

export async function fetchIntelligenceSummary(): Promise<IntelligenceSummary> {
  return request<IntelligenceSummary>("/intelligence/summary");
}

export async function startIntelligence(intervalSec?: number): Promise<IntelligenceStatus> {
  return request<IntelligenceStatus>("/intelligence/start", {
    method: "POST",
    body: JSON.stringify(intervalSec !== undefined ? { intervalSec } : {}),
  });
}

export async function stopIntelligence(): Promise<IntelligenceStatus> {
  return request<IntelligenceStatus>("/intelligence/stop", { method: "POST", body: JSON.stringify({}) });
}

export async function runIntelligenceTick(): Promise<unknown> {
  return request("/intelligence/tick", { method: "POST", body: JSON.stringify({}) });
}

export async function fetchRecentCoins(limit = 20): Promise<IntelCoin[]> {
  const payload = await request<{ coins: IntelCoin[] }>(`/intelligence/coins/recent?limit=${limit}`);
  return payload.coins;
}

export async function fetchTopCoins(limit = 20): Promise<IntelCoin[]> {
  const payload = await request<{ coins: IntelCoin[] }>(`/intelligence/coins/top?limit=${limit}`);
  return payload.coins;
}

export async function fetchTopAnalytics(limit = 20): Promise<IntelAnalytics[]> {
  const payload = await request<{ analytics: IntelAnalytics[] }>(`/intelligence/analytics?limit=${limit}`);
  return payload.analytics;
}

export async function fetchIntelAlerts(limit = 50): Promise<IntelAlert[]> {
  const payload = await request<{ alerts: IntelAlert[] }>(`/intelligence/alerts?limit=${limit}`);
  return payload.alerts;
}

export async function fetchWatchlist(listName = "default"): Promise<WatchlistItem[]> {
  const payload = await request<{ items: WatchlistItem[] }>(`/intelligence/watchlist?listName=${encodeURIComponent(listName)}`);
  return payload.items;
}

export async function addToIntelWatchlist(coinAddress: string, listName?: string, label?: string): Promise<unknown> {
  return request("/intelligence/watchlist", {
    method: "POST",
    body: JSON.stringify({ coinAddress, listName, label }),
  });
}

export async function removeFromIntelWatchlist(coinAddress: string, listName = "default"): Promise<unknown> {
  return request(`/intelligence/watchlist/${encodeURIComponent(coinAddress)}?listName=${encodeURIComponent(listName)}`, {
    method: "DELETE",
  });
}
