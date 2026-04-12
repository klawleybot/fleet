import { Router } from "express";
import {
  createFleet,
  getFleetByName,
  listFleets,
  sweepFleet,
  getFleetStatusByName,
} from "../services/fleet.js";
import { db } from "../db/index.js";
import {
  requestSupportCoinOperation,
  requestExitCoinOperation,
  approveAndExecuteOperation,
} from "../services/operations.js";
import { dripSwap } from "../services/trade.js";
import { isAddress } from "viem";

export const fleetsRouter = Router();

type FleetStrategyMode = "sync" | "staggered" | "momentum";

interface CreateFleetBody {
  name?: string;
  wallets?: number;
  fundAmountWei?: string;
  sourceFleetName?: string;
  strategyMode?: FleetStrategyMode;
}

interface FleetTradeBody {
  coinAddress?: string;
  totalAmountWei?: string;
  slippageBps?: number;
  overMs?: number;
  intervals?: number;
  jiggle?: boolean;
  jiggleFactor?: number;
}

interface SweepBody {
  targetFleet?: string;
  targetAddress?: string;
  reserveWei?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isStrategyMode(value: unknown): value is FleetStrategyMode {
  return value === "sync" || value === "staggered" || value === "momentum";
}

function parseCreateFleetBody(value: unknown): CreateFleetBody {
  if (!isRecord(value)) return {};
  return {
    name: typeof value.name === "string" ? value.name : undefined,
    wallets: typeof value.wallets === "number" ? value.wallets : undefined,
    fundAmountWei: typeof value.fundAmountWei === "string" ? value.fundAmountWei : undefined,
    sourceFleetName: typeof value.sourceFleetName === "string" ? value.sourceFleetName : undefined,
    strategyMode: isStrategyMode(value.strategyMode) ? value.strategyMode : undefined,
  };
}

function parseFleetTradeBody(value: unknown): FleetTradeBody {
  if (!isRecord(value)) return {};
  return {
    coinAddress: typeof value.coinAddress === "string" ? value.coinAddress : undefined,
    totalAmountWei: typeof value.totalAmountWei === "string" ? value.totalAmountWei : undefined,
    slippageBps: typeof value.slippageBps === "number" ? value.slippageBps : undefined,
    overMs: typeof value.overMs === "number" ? value.overMs : undefined,
    intervals: typeof value.intervals === "number" ? value.intervals : undefined,
    jiggle: typeof value.jiggle === "boolean" ? value.jiggle : undefined,
    jiggleFactor: typeof value.jiggleFactor === "number" ? value.jiggleFactor : undefined,
  };
}

function parseSweepBody(value: unknown): SweepBody {
  if (!isRecord(value)) return {};
  return {
    targetFleet: typeof value.targetFleet === "string" ? value.targetFleet : undefined,
    targetAddress: typeof value.targetAddress === "string" ? value.targetAddress : undefined,
    reserveWei: typeof value.reserveWei === "string" ? value.reserveWei : undefined,
  };
}

/** POST /fleets — create a named fleet */
fleetsRouter.post("/", (req, res) => {
  const { name, wallets, fundAmountWei, sourceFleetName, strategyMode } = parseCreateFleetBody(req.body);

  if (!name || name.length < 1) {
    return res.status(400).json({ error: "name is required" });
  }
  if (!wallets || !Number.isInteger(wallets) || wallets < 1) {
    return res.status(400).json({ error: "wallets must be a positive integer" });
  }

  void (async () => {
    try {
      const result = await createFleet({
        name,
        walletCount: wallets,
        ...(fundAmountWei && { fundAmountWei }),
        ...(sourceFleetName && { sourceFleetName }),
        ...(strategyMode && { strategyMode }),
      });
      res.status(201).json(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unexpected error";
      res.status(400).json({ error: message });
    }
  })();
});

/** GET /fleets — list all fleets */
fleetsRouter.get("/", (_req, res) => {
  const fleets = listFleets();
  return res.json({ fleets });
});

/** GET /fleets/:name — get fleet by name */
fleetsRouter.get("/:name", (req, res) => {
  const fleet = getFleetByName(req.params.name);
  if (!fleet) {
    return res.status(404).json({ error: "Fleet not found" });
  }
  return res.json({ fleet });
});

/** DELETE /fleets/:name — remove the cluster + wallet assignments (wallets themselves remain) */
fleetsRouter.delete("/:name", (req, res) => {
  const fleet = getFleetByName(req.params.name);
  if (!fleet) {
    return res.status(404).json({ error: "Fleet not found" });
  }

  const deleted = db.deleteCluster(fleet.clusterId);
  return res.json({ deleted, name: req.params.name });
});

/** GET /fleets/:name/status — fleet status with positions + P&L */
fleetsRouter.get("/:name/status", (req, res) => {
  const refreshBalances = req.query.refresh === "true";

  void (async () => {
    try {
      const status = await getFleetStatusByName(req.params.name, refreshBalances);
      res.json(status);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unexpected error";
      res.status(400).json({ error: message });
    }
  })();
});

/** POST /fleets/:name/buy — buy a coin with the fleet */
fleetsRouter.post("/:name/buy", (req, res) => {
  const fleet = getFleetByName(req.params.name);
  if (!fleet) {
    return res.status(404).json({ error: "Fleet not found" });
  }

  const { coinAddress, totalAmountWei, slippageBps, overMs, intervals, jiggle, jiggleFactor } = parseFleetTradeBody(req.body);

  if (!coinAddress || !isAddress(coinAddress)) {
    return res.status(400).json({ error: "coinAddress must be a valid address" });
  }
  if (!totalAmountWei) {
    return res.status(400).json({ error: "totalAmountWei is required" });
  }
  if (!Number.isInteger(slippageBps)) {
    return res.status(400).json({ error: "slippageBps must be an integer" });
  }

  void (async () => {
    try {
      if (overMs && overMs > 0) {
        const walletIds = fleet.wallets.map((w) => w.id);
        const trades = await dripSwap({
          walletIds,
          fromToken: "0x4200000000000000000000000000000000000006",
          toToken: coinAddress,
          totalAmountInWei: BigInt(totalAmountWei),
          slippageBps,
          durationMs: overMs,
          ...(intervals != null && { intervals }),
          ...(jiggle != null && { jiggle }),
          ...(jiggleFactor != null && { jiggleFactor }),
        });
        res.json({ mode: "drip", durationMs: overMs, tradeCount: trades.length, trades });
        return;
      }

      const op = requestSupportCoinOperation({
        clusterId: fleet.clusterId,
        coinAddress,
        totalAmountWei,
        slippageBps,
        strategyMode: fleet.strategyMode,
        requestedBy: `fleet:${fleet.name}`,
      });
      const executed = await approveAndExecuteOperation({
        operationId: op.id,
        approvedBy: `fleet:${fleet.name}`,
      });
      res.json({ operation: executed });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unexpected error";
      res.status(400).json({ error: message });
    }
  })();
});

/** POST /fleets/:name/sell — sell a coin from the fleet */
fleetsRouter.post("/:name/sell", (req, res) => {
  const fleet = getFleetByName(req.params.name);
  if (!fleet) {
    return res.status(404).json({ error: "Fleet not found" });
  }

  const { coinAddress, totalAmountWei, slippageBps, overMs, intervals, jiggle, jiggleFactor } = parseFleetTradeBody(req.body);

  if (!coinAddress || !isAddress(coinAddress)) {
    return res.status(400).json({ error: "coinAddress must be a valid address" });
  }
  if (!totalAmountWei) {
    return res.status(400).json({ error: "totalAmountWei is required" });
  }
  if (!Number.isInteger(slippageBps)) {
    return res.status(400).json({ error: "slippageBps must be an integer" });
  }

  void (async () => {
    try {
      if (overMs && overMs > 0) {
        const walletIds = fleet.wallets.map((w) => w.id);
        const trades = await dripSwap({
          walletIds,
          fromToken: coinAddress,
          toToken: "0x4200000000000000000000000000000000000006",
          totalAmountInWei: BigInt(totalAmountWei),
          slippageBps,
          durationMs: overMs,
          ...(intervals != null && { intervals }),
          ...(jiggle != null && { jiggle }),
          ...(jiggleFactor != null && { jiggleFactor }),
        });
        res.json({ mode: "drip", durationMs: overMs, tradeCount: trades.length, trades });
        return;
      }

      const op = requestExitCoinOperation({
        clusterId: fleet.clusterId,
        coinAddress,
        totalAmountWei,
        slippageBps,
        strategyMode: fleet.strategyMode,
        requestedBy: `fleet:${fleet.name}`,
      });
      const executed = await approveAndExecuteOperation({
        operationId: op.id,
        approvedBy: `fleet:${fleet.name}`,
      });
      res.json({ operation: executed });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unexpected error";
      res.status(400).json({ error: message });
    }
  })();
});

/** POST /fleets/:name/sweep — sweep ETH from this fleet to a target */
fleetsRouter.post("/:name/sweep", (req, res) => {
  const { targetFleet, targetAddress, reserveWei } = parseSweepBody(req.body);

  void (async () => {
    try {
      const result = await sweepFleet({
        sourceFleetName: req.params.name,
        ...(targetFleet && { targetFleetName: targetFleet }),
        ...(targetAddress && isAddress(targetAddress) ? { targetAddress } : {}),
        ...(reserveWei && { reserveWei: BigInt(reserveWei) }),
      });
      res.json({
        ...result,
        totalSwept: result.totalSwept.toString(),
        totalFailed: result.totalFailed.toString(),
        transfers: result.transfers.map((t) => ({
          ...t,
          balanceBefore: t.balanceBefore.toString(),
          amountSent: t.amountSent.toString(),
        })),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unexpected error";
      res.status(400).json({ error: message });
    }
  })();
});
