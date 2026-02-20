import { isAddress } from "viem";
import { db } from "../db/index.js";
import { assertExecutionAllowed, assertFundingRequestAllowed, assertTradeRequestAllowed } from "./policy.js";
import { distributeFunding } from "./funding.js";
import { strategySwap } from "./trade.js";
import { selectSignalCoin, topMovers, watchlistSignals, type ZoraSignalCoin, type ZoraSignalMode } from "./zoraSignals.js";
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
    assertTradeRequestAllowed({
      coinAddress: payload.coinAddress,
      totalAmountWei,
      walletCount: walletIds.length,
      slippageBps: payload.slippageBps,
    });

    const records =
      operation.type === "SUPPORT_COIN"
        ? await strategySwap({
            walletIds,
            fromToken: WETH_BASE,
            toToken: payload.coinAddress,
            totalAmountInWei: totalAmountWei,
            slippageBps: payload.slippageBps,
            mode: payload.strategyMode,
            operationId: operation.id,
          })
        : await strategySwap({
            walletIds,
            fromToken: payload.coinAddress,
            toToken: WETH_BASE,
            totalAmountInWei: totalAmountWei,
            slippageBps: payload.slippageBps,
            mode: payload.strategyMode,
            operationId: operation.id,
          });

    return db.updateOperation({
      id: operation.id,
      status: "complete",
      resultJson: JSON.stringify({ tradeCount: records.length, trades: records }),
      approvedBy: input.approvedBy ?? null,
      errorMessage: null,
    });
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
