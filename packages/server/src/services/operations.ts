import { isAddress } from "viem";
import { db } from "../db/index.js";
import { assertExecutionAllowed, assertFundingRequestAllowed, assertTradeRequestAllowed, getPolicy } from "./policy.js";
import { distributeFunding } from "./funding.js";
import { strategySwap } from "./trade.js";
import { addToWatchlist, removeFromWatchlist, getFleetWatchlistName, selectSignalCoin, topMovers, watchlistSignals, type ZoraSignalCoin, type ZoraSignalMode } from "./zoraSignals.js";
import type { OperationRecord, StrategyMode } from "../types.js";

const WETH_BASE = "0x4200000000000000000000000000000000000006" as const;

interface FundingPayload {
  amountWei: string;
}

interface TradePayload {
  coinAddress: `0x${string}`;
  totalAmountWei: string;
  slippageBps: number;
  strategyMode: StrategyMode;
  signal?: {
    mode: ZoraSignalMode;
    coinUrl: string;
    momentumScore: number;
  };
}

function ensureClusterHasWallets(clusterId: number) {
  const cluster = db.getClusterById(clusterId);
  if (!cluster) throw new Error(`Cluster ${clusterId} not found`);

  const wallets = db.listClusterWalletDetails(clusterId);
  const walletIds = wallets.map((w) => w.id);
  if (!walletIds.length) throw new Error(`Cluster ${clusterId} has no assigned wallets`);

  return { cluster, walletIds };
}

export function requestFundingOperation(input: {
  clusterId: number;
  amountWei: string;
  requestedBy?: string | null;
}): OperationRecord {
  const amountWei = BigInt(input.amountWei);
  const { walletIds } = ensureClusterHasWallets(input.clusterId);
  assertFundingRequestAllowed({ amountWei, walletCount: walletIds.length });

  return db.createOperation({
    type: "FUNDING_REQUEST",
    clusterId: input.clusterId,
    requestedBy: input.requestedBy ?? null,
    payloadJson: JSON.stringify({ amountWei: amountWei.toString() } satisfies FundingPayload),
  });
}

export function requestSupportCoinOperation(input: {
  clusterId: number;
  coinAddress: `0x${string}`;
  totalAmountWei: string;
  slippageBps: number;
  strategyMode?: StrategyMode;
  requestedBy?: string | null;
}): OperationRecord {
  if (!isAddress(input.coinAddress)) throw new Error("coinAddress must be a valid EVM address");
  const totalAmountWei = BigInt(input.totalAmountWei);
  const { cluster, walletIds } = ensureClusterHasWallets(input.clusterId);

  assertTradeRequestAllowed({
    coinAddress: input.coinAddress,
    totalAmountWei,
    walletCount: walletIds.length,
    slippageBps: input.slippageBps,
  });

  const payload: TradePayload = {
    coinAddress: input.coinAddress,
    totalAmountWei: totalAmountWei.toString(),
    slippageBps: input.slippageBps,
    strategyMode: input.strategyMode ?? cluster.strategyMode,
  };

  return db.createOperation({
    type: "SUPPORT_COIN",
    clusterId: input.clusterId,
    requestedBy: input.requestedBy ?? null,
    payloadJson: JSON.stringify(payload),
  });
}

export function requestExitCoinOperation(input: {
  clusterId: number;
  coinAddress: `0x${string}`;
  totalAmountWei: string;
  slippageBps: number;
  strategyMode?: StrategyMode;
  requestedBy?: string | null;
}): OperationRecord {
  if (!isAddress(input.coinAddress)) throw new Error("coinAddress must be a valid EVM address");
  const totalAmountWei = BigInt(input.totalAmountWei);
  const { cluster, walletIds } = ensureClusterHasWallets(input.clusterId);

  // EXIT_COIN: skip MAX_TRADE_WEI / MAX_PER_WALLET_WEI checks since
  // totalAmountWei is a raw token amount, not ETH. Only validate slippage + coin allowlist.
  const policy = getPolicy();
  if (input.slippageBps < 1 || input.slippageBps > policy.maxSlippageBps) {
    throw new Error(`slippageBps must be between 1 and ${policy.maxSlippageBps}`);
  }

  const payload: TradePayload = {
    coinAddress: input.coinAddress,
    totalAmountWei: totalAmountWei.toString(),
    slippageBps: input.slippageBps,
    strategyMode: input.strategyMode ?? cluster.strategyMode,
  };

  return db.createOperation({
    type: "EXIT_COIN",
    clusterId: input.clusterId,
    requestedBy: input.requestedBy ?? null,
    payloadJson: JSON.stringify(payload),
  });
}

export function listZoraSignalCandidates(input?: {
  mode?: ZoraSignalMode;
  listName?: string;
  minMomentum?: number;
  limit?: number;
}): ZoraSignalCoin[] {
  const mode = input?.mode ?? "top_momentum";
  if (mode === "watchlist_top") {
    return watchlistSignals({
      ...(input?.listName ? { listName: input.listName } : {}),
      limit: input?.limit ?? 10,
    });
  }
  return topMovers({ limit: input?.limit ?? 10, minMomentum: input?.minMomentum ?? 0 });
}

export function requestSupportFromZoraSignal(input: {
  clusterId: number;
  mode: ZoraSignalMode;
  listName?: string;
  minMomentum?: number;
  totalAmountWei: string;
  slippageBps: number;
  strategyMode?: StrategyMode;
  requestedBy?: string | null;
}): OperationRecord {
  const candidate = selectSignalCoin({
    mode: input.mode,
    ...(input.listName ? { listName: input.listName } : {}),
    ...(input.minMomentum !== undefined ? { minMomentum: input.minMomentum } : {}),
  });

  const operation = requestSupportCoinOperation({
    clusterId: input.clusterId,
    coinAddress: candidate.coinAddress,
    totalAmountWei: input.totalAmountWei,
    slippageBps: input.slippageBps,
    ...(input.strategyMode ? { strategyMode: input.strategyMode } : {}),
    requestedBy: input.requestedBy ?? null,
  });

  const payload = JSON.parse(operation.payloadJson) as TradePayload;
  payload.signal = {
    mode: input.mode,
    coinUrl: candidate.coinUrl,
    momentumScore: candidate.momentumScore,
  };

  return db.updateOperation({
    id: operation.id,
    payloadJson: JSON.stringify(payload),
  });
}

export async function approveAndExecuteOperation(input: {
  operationId: number;
  approvedBy?: string | null;
}): Promise<OperationRecord> {
  const operation = db.getOperationById(input.operationId);
  if (!operation) throw new Error(`Operation ${input.operationId} not found`);
  if (operation.status !== "pending" && operation.status !== "approved") {
    throw new Error(`Operation ${operation.id} is not executable (status=${operation.status})`);
  }

  const { walletIds } = ensureClusterHasWallets(operation.clusterId);
  assertExecutionAllowed({ clusterId: operation.clusterId, excludeOperationId: operation.id });

  db.updateOperation({
    id: operation.id,
    status: "approved",
    approvedBy: input.approvedBy ?? null,
  });

  db.updateOperation({ id: operation.id, status: "executing", approvedBy: input.approvedBy ?? null });

  try {
    if (operation.type === "FUNDING_REQUEST") {
      const payload = JSON.parse(operation.payloadJson) as FundingPayload;
      const amountWei = BigInt(payload.amountWei);
      assertFundingRequestAllowed({ amountWei, walletCount: walletIds.length });

      const fundingRecords = await distributeFunding({
        toWalletIds: walletIds,
        amountWei,
        concurrency: 3,
      });
      return db.updateOperation({
        id: operation.id,
        status: "complete",
        resultJson: JSON.stringify({ fundingCount: fundingRecords.length, fundingRecords }),
        approvedBy: input.approvedBy ?? null,
        errorMessage: null,
      });
    }

    const payload = JSON.parse(operation.payloadJson) as TradePayload;
    const totalAmountWei = BigInt(payload.totalAmountWei);
    const isBuy = operation.type === "SUPPORT_COIN";

    // Only enforce MAX_TRADE_WEI / MAX_PER_WALLET_WEI on buys (ETH outflow).
    // Sells pass raw token amounts which are not comparable to ETH limits.
    if (isBuy) {
      assertTradeRequestAllowed({
        coinAddress: payload.coinAddress,
        totalAmountWei,
        walletCount: walletIds.length,
        slippageBps: payload.slippageBps,
      });
    }
    const records = await strategySwap({
      walletIds,
      fromToken: isBuy ? WETH_BASE : payload.coinAddress,
      toToken: isBuy ? payload.coinAddress : WETH_BASE,
      totalAmountInWei: totalAmountWei,
      slippageBps: payload.slippageBps,
      mode: payload.strategyMode,
      operationId: operation.id,
    });

    const result = db.updateOperation({
      id: operation.id,
      status: "complete",
      resultJson: JSON.stringify({ tradeCount: records.length, trades: records }),
      approvedBy: input.approvedBy ?? null,
      errorMessage: null,
    });

    // Auto-track positions in zora-intelligence watchlist
    try {
      if (isBuy) {
        addToWatchlist(payload.coinAddress, {
          label: `fleet-tracked`,
          notes: `Auto-added by fleet operation #${operation.id}`,
        });
      } else {
        // On exit, check if any wallets still hold this coin
        const remaining = db.listPositionsByCoin(payload.coinAddress);
        const hasHoldings = remaining.some((p) => {
          try { return BigInt(p.holdingsRaw || "0") > 0n; } catch { return false; }
        });
        if (!hasHoldings) {
          removeFromWatchlist(payload.coinAddress);
        }
      }
    } catch (watchlistErr) {
      // Non-fatal: don't fail the operation if watchlist update fails
      // (e.g. zora-intelligence DB not available)
    }

    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Operation execution failed";
    return db.updateOperation({
      id: operation.id,
      status: "failed",
      approvedBy: input.approvedBy ?? null,
      errorMessage: message,
    });
  }
}

export function listOperations(limit = 100): OperationRecord[] {
  return db.listOperations(limit);
}
