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
import { isAddress, parseEther } from "viem";

export const fleetsRouter = Router();

/** POST /fleets — create a named fleet */
fleetsRouter.post("/", async (req, res) => {
  const { name, wallets, fundAmountWei, sourceFleetName, strategyMode } = req.body as {
    name?: string;
    wallets?: number;
    fundAmountWei?: string;
    sourceFleetName?: string;
    strategyMode?: string;
  };

  if (!name || typeof name !== "string" || name.length < 1) {
    return res.status(400).json({ error: "name is required" });
  }
  if (!wallets || !Number.isInteger(wallets) || wallets < 1) {
    return res.status(400).json({ error: "wallets must be a positive integer" });
  }

  try {
    const result = await createFleet({
      name,
      walletCount: wallets,
      ...(fundAmountWei && { fundAmountWei }),
      ...(sourceFleetName && { sourceFleetName }),
      ...(strategyMode && { strategyMode: strategyMode as "sync" | "staggered" | "momentum" }),
    });
    return res.status(201).json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unexpected error";
    return res.status(400).json({ error: message });
  }
});

/** GET /fleets — list all fleets */
fleetsRouter.get("/", (_req, res) => {
  const fleets = listFleets();
  return res.json({ fleets });
});

/** GET /fleets/:name — get fleet by name */
fleetsRouter.get("/:name", (req, res) => {
  const fleet = getFleetByName(req.params.name!);
  if (!fleet) {
    return res.status(404).json({ error: "Fleet not found" });
  }
  return res.json({ fleet });
});

/** DELETE /fleets/:name — remove the cluster + wallet assignments (wallets themselves remain) */
fleetsRouter.delete("/:name", (req, res) => {
  const fleet = getFleetByName(req.params.name!);
  if (!fleet) {
    return res.status(404).json({ error: "Fleet not found" });
  }

  const deleted = db.deleteCluster(fleet.clusterId);
  return res.json({ deleted, name: req.params.name });
});

/** GET /fleets/:name/status — fleet status with positions + P&L */
fleetsRouter.get("/:name/status", async (req, res) => {
  const refreshBalances = req.query.refresh === "true";
  try {
    const status = await getFleetStatusByName(req.params.name!, refreshBalances);
    return res.json(status);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unexpected error";
    return res.status(400).json({ error: message });
  }
});

/** POST /fleets/:name/buy — buy a coin with the fleet */
fleetsRouter.post("/:name/buy", async (req, res) => {
  const fleet = getFleetByName(req.params.name!);
  if (!fleet) {
    return res.status(404).json({ error: "Fleet not found" });
  }

  const { coinAddress, totalAmountWei, slippageBps, overMs, intervals, jiggle, jiggleFactor } = req.body as {
    coinAddress?: string;
    totalAmountWei?: string;
    slippageBps?: number;
    overMs?: number;
    intervals?: number;
    jiggle?: boolean;
    jiggleFactor?: number;
  };

  if (!coinAddress || !isAddress(coinAddress)) {
    return res.status(400).json({ error: "coinAddress must be a valid address" });
  }
  if (!totalAmountWei) {
    return res.status(400).json({ error: "totalAmountWei is required" });
  }
  if (!Number.isInteger(slippageBps)) {
    return res.status(400).json({ error: "slippageBps must be an integer" });
  }

  try {
    // Temporal streaming: use dripSwap when overMs is set
    if (overMs && overMs > 0) {
      const walletIds = fleet.wallets.map((w) => w.id);
      const trades = await dripSwap({
        walletIds,
        fromToken: "0x4200000000000000000000000000000000000006",
        toToken: coinAddress as `0x${string}`,
        totalAmountInWei: BigInt(totalAmountWei),
        slippageBps: slippageBps!,
        durationMs: overMs,
        ...(intervals != null && { intervals }),
        ...(jiggle != null && { jiggle }),
        ...(jiggleFactor != null && { jiggleFactor }),
      });
      return res.json({ mode: "drip", durationMs: overMs, tradeCount: trades.length, trades });
    }

    const op = requestSupportCoinOperation({
      clusterId: fleet.clusterId,
      coinAddress: coinAddress as `0x${string}`,
      totalAmountWei,
      slippageBps: slippageBps!,
      strategyMode: fleet.strategyMode as "sync" | "staggered" | "momentum",
      requestedBy: `fleet:${fleet.name}`,
    });
    const executed = await approveAndExecuteOperation({
      operationId: op.id,
      approvedBy: `fleet:${fleet.name}`,
    });
    return res.json({ operation: executed });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unexpected error";
    return res.status(400).json({ error: message });
  }
});

/** POST /fleets/:name/sell — sell a coin from the fleet */
fleetsRouter.post("/:name/sell", async (req, res) => {
  const fleet = getFleetByName(req.params.name!);
  if (!fleet) {
    return res.status(404).json({ error: "Fleet not found" });
  }

  const { coinAddress, totalAmountWei, slippageBps, overMs, intervals, jiggle, jiggleFactor } = req.body as {
    coinAddress?: string;
    totalAmountWei?: string;
    slippageBps?: number;
    overMs?: number;
    intervals?: number;
    jiggle?: boolean;
    jiggleFactor?: number;
  };

  if (!coinAddress || !isAddress(coinAddress)) {
    return res.status(400).json({ error: "coinAddress must be a valid address" });
  }
  if (!totalAmountWei) {
    return res.status(400).json({ error: "totalAmountWei is required" });
  }
  if (!Number.isInteger(slippageBps)) {
    return res.status(400).json({ error: "slippageBps must be an integer" });
  }

  try {
    if (overMs && overMs > 0) {
      const walletIds = fleet.wallets.map((w) => w.id);
      const trades = await dripSwap({
        walletIds,
        fromToken: coinAddress as `0x${string}`,
        toToken: "0x4200000000000000000000000000000000000006",
        totalAmountInWei: BigInt(totalAmountWei),
        slippageBps: slippageBps!,
        durationMs: overMs,
        ...(intervals != null && { intervals }),
        ...(jiggle != null && { jiggle }),
        ...(jiggleFactor != null && { jiggleFactor }),
      });
      return res.json({ mode: "drip", durationMs: overMs, tradeCount: trades.length, trades });
    }

    const op = requestExitCoinOperation({
      clusterId: fleet.clusterId,
      coinAddress: coinAddress as `0x${string}`,
      totalAmountWei,
      slippageBps: slippageBps!,
      strategyMode: fleet.strategyMode as "sync" | "staggered" | "momentum",
      requestedBy: `fleet:${fleet.name}`,
    });
    const executed = await approveAndExecuteOperation({
      operationId: op.id,
      approvedBy: `fleet:${fleet.name}`,
    });
    return res.json({ operation: executed });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unexpected error";
    return res.status(400).json({ error: message });
  }
});

/** POST /fleets/:name/sweep — sweep ETH from this fleet to a target */
fleetsRouter.post("/:name/sweep", async (req, res) => {
  const { targetFleet, targetAddress, reserveWei } = req.body as {
    targetFleet?: string;
    targetAddress?: string;
    reserveWei?: string;
  };

  // At least one target, or default to master
  try {
    const result = await sweepFleet({
      sourceFleetName: req.params.name!,
      ...(targetFleet && { targetFleetName: targetFleet }),
      ...(targetAddress && { targetAddress: targetAddress as `0x${string}` }),
      ...(reserveWei && { reserveWei: BigInt(reserveWei) }),
    });
    // Serialize bigints for JSON
    return res.json({
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
    return res.status(400).json({ error: message });
  }
});
