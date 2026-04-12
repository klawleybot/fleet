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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parseStringQueryValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function parseFundingBody(value: unknown): FundingBody {
  if (!isRecord(value)) return {};
  return {
    clusterId: typeof value.clusterId === "number" ? value.clusterId : undefined,
    amountWei: typeof value.amountWei === "string" ? value.amountWei : undefined,
    requestedBy: typeof value.requestedBy === "string" ? value.requestedBy : undefined,
  };
}

function parseTradeBody(value: unknown): TradeBody {
  if (!isRecord(value)) return {};
  return {
    clusterId: typeof value.clusterId === "number" ? value.clusterId : undefined,
    coinAddress: typeof value.coinAddress === "string" ? value.coinAddress : undefined,
    totalAmountWei: typeof value.totalAmountWei === "string" ? value.totalAmountWei : undefined,
    slippageBps: typeof value.slippageBps === "number" ? value.slippageBps : undefined,
    strategyMode: typeof value.strategyMode === "string" ? value.strategyMode as StrategyMode : undefined,
    requestedBy: typeof value.requestedBy === "string" ? value.requestedBy : undefined,
  };
}

function parseSignalSupportBody(value: unknown): SignalSupportBody {
  if (!isRecord(value)) return {};
  return {
    clusterId: typeof value.clusterId === "number" ? value.clusterId : undefined,
    mode: value.mode === "top_momentum" || value.mode === "watchlist_top" ? value.mode : undefined,
    listName: typeof value.listName === "string" ? value.listName : undefined,
    minMomentum: typeof value.minMomentum === "number" ? value.minMomentum : undefined,
    totalAmountWei: typeof value.totalAmountWei === "string" ? value.totalAmountWei : undefined,
    slippageBps: typeof value.slippageBps === "number" ? value.slippageBps : undefined,
    strategyMode: typeof value.strategyMode === "string" ? value.strategyMode as StrategyMode : undefined,
    requestedBy: typeof value.requestedBy === "string" ? value.requestedBy : undefined,
  };
}

function parseApproveBody(value: unknown): ApproveBody {
  if (!isRecord(value)) return {};
  return {
    approvedBy: typeof value.approvedBy === "string" ? value.approvedBy : undefined,
  };
}

function parseRoutePreviewBody(value: unknown): RoutePreviewBody {
  if (!isRecord(value)) return {};
  return {
    fromToken: typeof value.fromToken === "string" ? value.fromToken : undefined,
    toToken: typeof value.toToken === "string" ? value.toToken : undefined,
    maxHops: typeof value.maxHops === "number" ? value.maxHops : undefined,
  };
}

operationsRouter.get("/", (req, res) => {
  const limitText = isRecord(req.query) ? parseStringQueryValue(req.query.limit) : undefined;
  const limit = Number.parseInt(limitText ?? "100", 10);
  const safeLimit = Number.isNaN(limit) ? 100 : Math.max(1, Math.min(500, limit));
  return res.json({ operations: listOperations(safeLimit) });
});

operationsRouter.post("/request-funding", (req, res) => {
  const body = parseFundingBody(req.body);
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
  const body = parseTradeBody(req.body);
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
      coinAddress: body.coinAddress,
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
  const body = parseTradeBody(req.body);
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
      coinAddress: body.coinAddress,
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
  const query: SignalQuery = isRecord(req.query)
    ? {
        mode: req.query.mode === "top_momentum" || req.query.mode === "watchlist_top" ? req.query.mode : undefined,
        listName: parseStringQueryValue(req.query.listName),
        minMomentum: parseStringQueryValue(req.query.minMomentum),
        limit: parseStringQueryValue(req.query.limit),
      }
    : {};
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
  const body = parseSignalSupportBody(req.body);
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
  const body = parseRoutePreviewBody(req.body);
  if (typeof body.fromToken !== "string" || !isAddress(body.fromToken)) {
    return res.status(400).json({ error: "fromToken must be a valid EVM address" });
  }
  if (typeof body.toToken !== "string" || !isAddress(body.toToken)) {
    return res.status(400).json({ error: "toToken must be a valid EVM address" });
  }

  try {
    const route = resolveDeterministicBuyRoute({
      fromToken: body.fromToken,
      toToken: body.toToken,
      ...(Number.isInteger(body.maxHops) ? { maxHops: Number(body.maxHops) } : {}),
    });
    return res.json({ route });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unexpected error";
    return res.status(400).json({ error: message });
  }
});

operationsRouter.post("/:id/approve-execute", (req, res) => {
  const id = Number.parseInt(req.params.id, 10);
  if (Number.isNaN(id) || id < 1) {
    return res.status(400).json({ error: "operation id must be a positive integer" });
  }

  const body = parseApproveBody(req.body);

  void (async () => {
    try {
      const operation = await approveAndExecuteOperation({
        operationId: id,
        approvedBy: body.approvedBy ?? null,
      });
      res.json({ operation });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unexpected error";
      res.status(400).json({ error: message });
    }
  })();
});
