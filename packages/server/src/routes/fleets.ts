import { Router } from "express";
import {
  createFleet,
  getFleetByName,
  listFleets,
  sweepFleet,
  getFleetStatusByName,
} from "../services/fleet.js";
import {
  requestSupportCoinOperation,
  requestExitCoinOperation,
  approveAndExecuteOperation,
} from "../services/operations.js";
import { isAddress } from "viem";

export const fleetsRouter = Router();

/** POST /fleets — create a named fleet */
fleetsRouter.post("/", async (req, res) => {
  const { name, wallets, fundAmountWei, strategyMode } = req.body as {
    name?: string;
    wallets?: number;
    fundAmountWei?: string;
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
      fundAmountWei,
      strategyMode: strategyMode as "sync" | "staggered" | "momentum" | undefined,
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

  const { coinAddress, totalAmountWei, slippageBps } = req.body as {
    coinAddress?: string;
    totalAmountWei?: string;
    slippageBps?: number;
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

  const { coinAddress, totalAmountWei, slippageBps } = req.body as {
    coinAddress?: string;
    totalAmountWei?: string;
    slippageBps?: number;
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

/** POST /fleets/:name/sweep — sweep ETH from this fleet to another */
fleetsRouter.post("/:name/sweep", async (req, res) => {
  const { targetFleet } = req.body as { targetFleet?: string };
  if (!targetFleet) {
    return res.status(400).json({ error: "targetFleet name is required" });
  }

  try {
    const result = await sweepFleet({
      sourceFleetName: req.params.name!,
      targetFleetName: targetFleet,
    });
    return res.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unexpected error";
    return res.status(400).json({ error: message });
  }
});
