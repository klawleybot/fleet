import type {
  AutonomyStatus,
  FleetDashboard,
  FleetInfo,
  FundingRecord,
  GlobalDashboard,
  HealthResponse,
  OperationRecord,
  PositionRecord,
  TradeRecord,
  Wallet,
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
): Promise<unknown> {
  return request(`/fleets/${encodeURIComponent(fleetName)}/buy`, {
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
): Promise<unknown> {
  return request(`/fleets/${encodeURIComponent(fleetName)}/sell`, {
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
