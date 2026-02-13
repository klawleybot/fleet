import type { FundingRecord, TradeRecord, Wallet } from "../types";

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
    const payload = (await response.json().catch(() => null)) as
      | { error?: string }
      | null;
    throw new Error(payload?.error ?? `Request failed (${response.status})`);
  }

  return response.json() as Promise<T>;
}

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

export async function fetchWalletEthBalance(walletId: number): Promise<string> {
  const payload = await request<{ ethBalanceWei: string }>(`/wallets/${walletId}/balance`);
  return payload.ethBalanceWei;
}

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

