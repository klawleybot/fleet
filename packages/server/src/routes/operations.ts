import { Router } from "express";
import { isAddress } from "viem";
import {
  approveAndExecuteOperation,
  listOperations,
  listZoraSignalCandidates,
  requestExitCoinOperation,
  requestFundingOperation,
  requestSupportCoinOperation,
  requestSupportFromZoraSignal,
} from "../services/operations.js";
import type { StrategyMode } from "../types.js";
import type { ZoraSignalMode } from "../services/zoraSignals.js";
import { resolveDeterministicBuyRoute } from "../services/swapRoute.js";

interface FundingBody {
  clusterId?: number;
  amountWei?: string;
  requestedBy?: string;
}

interface TradeBody {
  clusterId?: number;
  coinAddress?: string;
  totalAmountWei?: string;
  slippageBps?: number;
  strategyMode?: StrategyMode;
  requestedBy?: string;
}

interface SignalSupportBody {
  clusterId?: number;
  mode?: ZoraSignalMode;
  listName?: string;
  minMomentum?: number;
  totalAmountWei?: string;
  slippageBps?: number;
  strategyMode?: StrategyMode;
  requestedBy?: string;
}

interface SignalQuery {
  mode?: ZoraSignalMode;
  listName?: string;
  minMomentum?: string;
  limit?: string;
}

interface ApproveBody {
  approvedBy?: string;
}

interface RoutePreviewBody {
  fromToken?: string;
  toToken?: string;
  maxHops?: number;
}

export const operationsRouter = Router();

operationsRouter.get("/", (req, res) => {
  const limit = Number.parseInt(String(req.query.limit ?? "100"), 10);
  const safeLimit = Number.isNaN(limit) ? 100 : Math.max(1, Math.min(500, limit));
  return res.json({ operations: listOperations(safeLimit) });
});

operationsRouter.post("/request-funding", (req, res) => {
  const body = req.body as FundingBody;
  if (!Number.isInteger(body.clusterId) || Number(body.clusterId) < 1) {
    return res.status(400).json({ error: "clusterId must be a positive integer" });
  }
  if (typeof body.amountWei !== "string") {
    return res.status(400).json({ error: "amountWei must be a string" });
  }

  try {
    const operation = requestFundingOperation({
      clusterId: Number(body.clusterId),
      amountWei: body.amountWei,
      requestedBy: body.requestedBy ?? null,
    });
    return res.status(201).json({ operation });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unexpected error";
    return res.status(400).json({ error: message });
  }
});

operationsRouter.post("/support-coin", (req, res) => {
  const body = req.body as TradeBody;
  if (!Number.isInteger(body.clusterId) || Number(body.clusterId) < 1) {
    return res.status(400).json({ error: "clusterId must be a positive integer" });
  }
  if (typeof body.coinAddress !== "string" || !isAddress(body.coinAddress)) {
    return res.status(400).json({ error: "coinAddress must be a valid EVM address" });
  }
  if (typeof body.totalAmountWei !== "string") {
    return res.status(400).json({ error: "totalAmountWei must be a string" });
  }
  if (!Number.isInteger(body.slippageBps)) {
    return res.status(400).json({ error: "slippageBps must be an integer" });
  }

  try {
    const operation = requestSupportCoinOperation({
      clusterId: Number(body.clusterId),
      coinAddress: body.coinAddress as `0x${string}`,
      totalAmountWei: body.totalAmountWei,
      slippageBps: Number(body.slippageBps),
      ...(body.strategyMode ? { strategyMode: body.strategyMode } : {}),
      requestedBy: body.requestedBy ?? null,
    });
    return res.status(201).json({ operation });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unexpected error";
    return res.status(400).json({ error: message });
  }
});

operationsRouter.post("/exit-coin", (req, res) => {
  const body = req.body as TradeBody;
  if (!Number.isInteger(body.clusterId) || Number(body.clusterId) < 1) {
    return res.status(400).json({ error: "clusterId must be a positive integer" });
  }
  if (typeof body.coinAddress !== "string" || !isAddress(body.coinAddress)) {
    return res.status(400).json({ error: "coinAddress must be a valid EVM address" });
  }
  if (typeof body.totalAmountWei !== "string") {
    return res.status(400).json({ error: "totalAmountWei must be a string" });
  }
  if (!Number.isInteger(body.slippageBps)) {
    return res.status(400).json({ error: "slippageBps must be an integer" });
  }

  try {
    const operation = requestExitCoinOperation({
      clusterId: Number(body.clusterId),
      coinAddress: body.coinAddress as `0x${string}`,
      totalAmountWei: body.totalAmountWei,
      slippageBps: Number(body.slippageBps),
      ...(body.strategyMode ? { strategyMode: body.strategyMode } : {}),
      requestedBy: body.requestedBy ?? null,
    });
    return res.status(201).json({ operation });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unexpected error";
    return res.status(400).json({ error: message });
  }
});

operationsRouter.get("/zora-signals", (req, res) => {
  const query = req.query as SignalQuery;
  const mode = query.mode ?? "top_momentum";
  if (mode !== "top_momentum" && mode !== "watchlist_top") {
    return res.status(400).json({ error: "mode must be top_momentum|watchlist_top" });
  }

  const minMomentum = query.minMomentum ? Number(query.minMomentum) : undefined;
  const limit = query.limit ? Number.parseInt(query.limit, 10) : undefined;

  try {
    const candidates = listZoraSignalCandidates({
      mode,
      ...(query.listName ? { listName: query.listName } : {}),
      ...(minMomentum !== undefined && !Number.isNaN(minMomentum) ? { minMomentum } : {}),
      ...(limit !== undefined && !Number.isNaN(limit) ? { limit } : {}),
    });
    return res.json({ mode, candidates });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unexpected error";
    return res.status(400).json({ error: message });
  }
});

operationsRouter.post("/support-from-zora-signal", (req, res) => {
  const body = req.body as SignalSupportBody;
  if (!Number.isInteger(body.clusterId) || Number(body.clusterId) < 1) {
    return res.status(400).json({ error: "clusterId must be a positive integer" });
  }
  if (typeof body.totalAmountWei !== "string") {
    return res.status(400).json({ error: "totalAmountWei must be a string" });
  }
  if (!Number.isInteger(body.slippageBps)) {
    return res.status(400).json({ error: "slippageBps must be an integer" });
  }

  const mode = body.mode ?? "top_momentum";
  if (mode !== "top_momentum" && mode !== "watchlist_top") {
    return res.status(400).json({ error: "mode must be top_momentum|watchlist_top" });
  }

  try {
    const operation = requestSupportFromZoraSignal({
      clusterId: Number(body.clusterId),
      mode,
      ...(body.listName ? { listName: body.listName } : {}),
      ...(typeof body.minMomentum === "number" ? { minMomentum: body.minMomentum } : {}),
      totalAmountWei: body.totalAmountWei,
      slippageBps: Number(body.slippageBps),
      ...(body.strategyMode ? { strategyMode: body.strategyMode } : {}),
      requestedBy: body.requestedBy ?? null,
    });
    return res.status(201).json({ operation });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unexpected error";
    return res.status(400).json({ error: message });
  }
});

operationsRouter.post("/route-preview", (req, res) => {
  const body = req.body as RoutePreviewBody;
  if (typeof body.fromToken !== "string" || !isAddress(body.fromToken)) {
    return res.status(400).json({ error: "fromToken must be a valid EVM address" });
  }
  if (typeof body.toToken !== "string" || !isAddress(body.toToken)) {
    return res.status(400).json({ error: "toToken must be a valid EVM address" });
  }

  try {
    const route = resolveDeterministicBuyRoute({
      fromToken: body.fromToken as `0x${string}`,
      toToken: body.toToken as `0x${string}`,
      ...(Number.isInteger(body.maxHops) ? { maxHops: Number(body.maxHops) } : {}),
    });
    return res.json({ route });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unexpected error";
    return res.status(400).json({ error: message });
  }
});

operationsRouter.post("/:id/approve-execute", async (req, res) => {
  const id = Number.parseInt(req.params.id, 10);
  if (Number.isNaN(id) || id < 1) {
    return res.status(400).json({ error: "operation id must be a positive integer" });
  }

  const body = req.body as ApproveBody;

  try {
    const operation = await approveAndExecuteOperation({
      operationId: id,
      approvedBy: body.approvedBy ?? null,
    });
    return res.json({ operation });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unexpected error";
    return res.status(400).json({ error: message });
  }
});
