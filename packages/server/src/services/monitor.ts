/**
 * Fleet Monitoring Service
 *
 * Aggregates position data, queries on-chain balances, and computes P&L
 * for fleet clusters.
 */
import { type Address, type Hex, createPublicClient, http } from "viem";
import { db } from "../db/index.js";
import type { PositionRecord } from "../types.js";
import { getChainConfig } from "./network.js";
import { quoteExactInputSingle } from "./v4Quoter.js";

// Minimal ABI for balanceOf
const balanceOfAbi = [
  {
    name: "balanceOf",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface WalletPosition {
  walletId: number;
  walletAddress: Address;
  coinAddress: Address;
  /** Cost basis in ETH wei */
  totalCostWei: string;
  /** Total ETH received from sells */
  totalReceivedWei: string;
  /** Token holdings (from DB, may be stale) */
  holdingsDb: string;
  /** Token holdings (on-chain, null if not queried) */
  holdingsOnChain: string | null;
  /** Realized P&L in ETH wei (sells - proportional cost) */
  realizedPnlWei: string;
  /** Current value in ETH wei (null if not quoted) */
  currentValueWei: string | null;
  /** Unrealized P&L (currentValue - remaining cost basis) */
  unrealizedPnlWei: string | null;
  buyCount: number;
  sellCount: number;
  lastActionAt: string;
}

export interface FleetSummary {
  clusterId: number;
  clusterName: string;
  walletCount: number;
  positions: WalletPosition[];
  /** Aggregate per-coin stats */
  coinSummaries: CoinSummary[];
  /** Total ETH invested across all coins */
  totalCostWei: string;
  /** Total ETH received from sells */
  totalReceivedWei: string;
  /** Total realized P&L */
  totalRealizedPnlWei: string;
}

export interface CoinSummary {
  coinAddress: Address;
  totalCostWei: string;
  totalReceivedWei: string;
  totalHoldings: string;
  totalCurrentValueWei: string | null;
  totalRealizedPnlWei: string;
  totalUnrealizedPnlWei: string | null;
  walletCount: number;
}

// ---------------------------------------------------------------------------
// On-chain balance query
// ---------------------------------------------------------------------------

export interface BalanceClient {
  readContract(args: {
    address: Address;
    abi: readonly Record<string, unknown>[];
    functionName: string;
    args: readonly unknown[];
  }): Promise<unknown>;
}

async function queryOnChainBalance(
  client: BalanceClient,
  coinAddress: Address,
  holder: Address,
): Promise<bigint> {
  try {
    return (await client.readContract({
      address: coinAddress,
      abi: balanceOfAbi,
      functionName: "balanceOf",
      args: [holder],
    })) as bigint;
  } catch {
    return 0n;
  }
}

// ---------------------------------------------------------------------------
// Position enrichment
// ---------------------------------------------------------------------------

function enrichPosition(
  pos: PositionRecord,
  walletAddress: Address,
  onChainBalance: bigint | null,
  currentValueWei: bigint | null,
): WalletPosition {
  const cost = BigInt(pos.totalCostWei);
  const received = BigInt(pos.totalReceivedWei);
  const realized = received - cost > 0n ? received - cost : -(cost - received);

  let unrealized: string | null = null;
  if (currentValueWei !== null) {
    // Remaining cost basis = totalCost - totalReceived (floored at 0)
    const remainingCost = cost > received ? cost - received : 0n;
    unrealized = (currentValueWei - remainingCost).toString();
  }

  return {
    walletId: pos.walletId,
    walletAddress,
    coinAddress: pos.coinAddress,
    totalCostWei: pos.totalCostWei,
    totalReceivedWei: pos.totalReceivedWei,
    holdingsDb: pos.holdingsRaw,
    holdingsOnChain: onChainBalance !== null ? onChainBalance.toString() : null,
    realizedPnlWei: realized.toString(),
    currentValueWei: currentValueWei !== null ? currentValueWei.toString() : null,
    unrealizedPnlWei: unrealized,
    buyCount: pos.buyCount,
    sellCount: pos.sellCount,
    lastActionAt: pos.lastActionAt,
  };
}

// ---------------------------------------------------------------------------
// Fleet status
// ---------------------------------------------------------------------------

/**
 * Get full fleet status with optional on-chain balance refresh.
 */
export async function getFleetStatus(params: {
  clusterId: number;
  refreshBalances?: boolean;
}): Promise<FleetSummary> {
  const { clusterId, refreshBalances = false } = params;

  const cluster = db.getClusterById(clusterId);
  if (!cluster) throw new Error(`Cluster ${clusterId} not found`);

  const wallets = db.listClusterWalletDetails(clusterId);
  const walletMap = new Map(wallets.map((w) => [w.id, w]));
  const positions = db.listPositionsByCluster(clusterId);

  let client: BalanceClient | null = null;
  if (refreshBalances && positions.length > 0) {
    const chainCfg = getChainConfig();
    client = createPublicClient({
      chain: chainCfg.chain,
      transport: http(chainCfg.rpcUrl),
    }) as unknown as BalanceClient;
  }

  const enriched: WalletPosition[] = [];
  for (const pos of positions) {
    const wallet = walletMap.get(pos.walletId);
    if (!wallet) continue;

    let onChainBalance: bigint | null = null;
    if (client && refreshBalances) {
      onChainBalance = await queryOnChainBalance(
        client,
        pos.coinAddress,
        wallet.address,
      );
    }

    // TODO: quote current value via quoter (requires pool params discovery)
    enriched.push(enrichPosition(pos, wallet.address, onChainBalance, null));
  }

  // Aggregate per-coin
  const coinMap = new Map<string, CoinSummary>();
  for (const wp of enriched) {
    const key = wp.coinAddress.toLowerCase();
    const existing = coinMap.get(key);
    if (existing) {
      existing.totalCostWei = (BigInt(existing.totalCostWei) + BigInt(wp.totalCostWei)).toString();
      existing.totalReceivedWei = (BigInt(existing.totalReceivedWei) + BigInt(wp.totalReceivedWei)).toString();
      existing.totalHoldings = (BigInt(existing.totalHoldings) + BigInt(wp.holdingsOnChain ?? wp.holdingsDb)).toString();
      existing.totalRealizedPnlWei = (BigInt(existing.totalRealizedPnlWei) + BigInt(wp.realizedPnlWei)).toString();
      existing.walletCount += 1;
    } else {
      coinMap.set(key, {
        coinAddress: wp.coinAddress,
        totalCostWei: wp.totalCostWei,
        totalReceivedWei: wp.totalReceivedWei,
        totalHoldings: wp.holdingsOnChain ?? wp.holdingsDb,
        totalCurrentValueWei: wp.currentValueWei,
        totalRealizedPnlWei: wp.realizedPnlWei,
        totalUnrealizedPnlWei: wp.unrealizedPnlWei,
        walletCount: 1,
      });
    }
  }

  const totalCostWei = enriched.reduce((acc, wp) => acc + BigInt(wp.totalCostWei), 0n);
  const totalReceivedWei = enriched.reduce((acc, wp) => acc + BigInt(wp.totalReceivedWei), 0n);
  const totalRealizedPnlWei = enriched.reduce((acc, wp) => acc + BigInt(wp.realizedPnlWei), 0n);

  return {
    clusterId,
    clusterName: cluster.name,
    walletCount: wallets.length,
    positions: enriched,
    coinSummaries: Array.from(coinMap.values()),
    totalCostWei: totalCostWei.toString(),
    totalReceivedWei: totalReceivedWei.toString(),
    totalRealizedPnlWei: totalRealizedPnlWei.toString(),
  };
}

/**
 * Record a trade's impact on positions.
 * Call this after a trade completes successfully.
 */
export function recordTradePosition(input: {
  walletId: number;
  coinAddress: `0x${string}`;
  isBuy: boolean;
  /** ETH amount spent (buy) or received (sell) */
  ethAmountWei: string;
  /** Token amount received (buy) or sold (sell) */
  tokenAmount: string;
}): PositionRecord {
  const { walletId, coinAddress, isBuy, ethAmountWei, tokenAmount } = input;

  if (isBuy) {
    return db.upsertPosition({
      walletId,
      coinAddress,
      costDelta: ethAmountWei,
      receivedDelta: "0",
      holdingsDelta: tokenAmount,
      isBuy: true,
    });
  } else {
    // Sell: negative holdings, positive received
    const negHoldings = (-BigInt(tokenAmount)).toString();
    return db.upsertPosition({
      walletId,
      coinAddress,
      costDelta: "0",
      receivedDelta: ethAmountWei,
      holdingsDelta: negHoldings,
      isBuy: false,
    });
  }
}
