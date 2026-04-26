import { Router } from "express";
import { createPublicClient, http, isAddress } from "viem";
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
import { getChainConfig } from "../services/network.js";
import { resolvePreferredBuyRoute } from "../services/swapRoute.js";
import type { CoinRouteClient } from "../services/coinRoute.js";

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

function isStrategyMode(value: unknown): value is StrategyMode {
  return value === "sync" || value === "staggered" || value === "momentum";
}

function parseFundingBody(value: unknown): FundingBody {
  if (!isRecord(value)) return {};
  const body: FundingBody = {};
  if (typeof value.clusterId === "number") body.clusterId = value.clusterId;
  if (typeof value.amountWei === "string") body.amountWei = value.amountWei;
  if (typeof value.requestedBy === "string") body.requestedBy = value.requestedBy;
  return body;
}

function parseTradeBody(value: unknown): TradeBody {
  if (!isRecord(value)) return {};
  const body: TradeBody = {};
  if (typeof value.clusterId === "number") body.clusterId = value.clusterId;
  if (typeof value.coinAddress === "string") body.coinAddress = value.coinAddress;
  if (typeof value.totalAmountWei === "string") body.totalAmountWei = value.totalAmountWei;
  if (typeof value.slippageBps === "number") body.slippageBps = value.slippageBps;
  if (isStrategyMode(value.strategyMode)) body.strategyMode = value.strategyMode;
  if (typeof value.requestedBy === "string") body.requestedBy = value.requestedBy;
  return body;
}

function parseSignalSupportBody(value: unknown): SignalSupportBody {
  if (!isRecord(value)) return {};
  const body: SignalSupportBody = {};
  if (typeof value.clusterId === "number") body.clusterId = value.clusterId;
  if (value.mode === "top_momentum" || value.mode === "watchlist_top") body.mode = value.mode;
  if (typeof value.listName === "string") body.listName = value.listName;
  if (typeof value.minMomentum === "number") body.minMomentum = value.minMomentum;
  if (typeof value.totalAmountWei === "string") body.totalAmountWei = value.totalAmountWei;
  if (typeof value.slippageBps === "number") body.slippageBps = value.slippageBps;
  if (isStrategyMode(value.strategyMode)) body.strategyMode = value.strategyMode;
  if (typeof value.requestedBy === "string") body.requestedBy = value.requestedBy;
  return body;
}

function parseApproveBody(value: unknown): ApproveBody {
  if (!isRecord(value)) return {};
  const body: ApproveBody = {};
  if (typeof value.approvedBy === "string") body.approvedBy = value.approvedBy;
  return body;
}

function parseRoutePreviewBody(value: unknown): RoutePreviewBody {
  if (!isRecord(value)) return {};
  const body: RoutePreviewBody = {};
  if (typeof value.fromToken === "string") body.fromToken = value.fromToken;
  if (typeof value.toToken === "string") body.toToken = value.toToken;
  if (typeof value.maxHops === "number") body.maxHops = value.maxHops;
  return body;
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
  const query: SignalQuery = {};
  if (isRecord(req.query)) {
    if (req.query.mode === "top_momentum" || req.query.mode === "watchlist_top") query.mode = req.query.mode;
    const listName = parseStringQueryValue(req.query.listName);
    const minMomentum = parseStringQueryValue(req.query.minMomentum);
    const limit = parseStringQueryValue(req.query.limit);
    if (listName !== undefined) query.listName = listName;
    if (minMomentum !== undefined) query.minMomentum = minMomentum;
    if (limit !== undefined) query.limit = limit;
  }
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
  const fromToken = body.fromToken;
  const toToken = body.toToken;
  const maxHops = Number.isInteger(body.maxHops) ? Number(body.maxHops) : undefined;

  if (typeof fromToken !== "string" || !isAddress(fromToken)) {
    return res.status(400).json({ error: "fromToken must be a valid EVM address" });
  }
  if (typeof toToken !== "string" || !isAddress(toToken)) {
    return res.status(400).json({ error: "toToken must be a valid EVM address" });
  }

  void (async () => {
    try {
      const cfg = getChainConfig();
      const client = createPublicClient({
        chain: cfg.chain,
        transport: http(cfg.rpcUrl),
      });
      const route = await resolvePreferredBuyRoute({
        client: client as unknown as CoinRouteClient,
        chainId: cfg.chainId,
        fromToken,
        toToken,
        ...(maxHops != null ? { maxHops } : {}),
      });
      res.json({ route });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unexpected error";
      res.status(400).json({ error: message });
    }
  })();
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
