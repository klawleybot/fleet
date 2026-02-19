import { Router } from "express";
import { createCluster, getCluster, listClusters, listClusterWallets, setClusterWallets } from "../services/cluster.js";
import type { StrategyMode } from "../types.js";

interface CreateClusterBody {
  name?: string;
  strategyMode?: StrategyMode;
}

interface SetClusterWalletsBody {
  walletIds?: number[];
}

export const clustersRouter = Router();

clustersRouter.get("/", (_req, res) => {
  return res.json({ clusters: listClusters() });
});

clustersRouter.post("/", (req, res) => {
  const body = req.body as CreateClusterBody;
  if (typeof body.name !== "string" || !body.name.trim()) {
    return res.status(400).json({ error: "name is required" });
  }

  const strategyMode = body.strategyMode ?? "sync";
  if (!["sync", "staggered", "momentum"].includes(strategyMode)) {
    return res.status(400).json({ error: "strategyMode must be sync|staggered|momentum" });
  }

  try {
    const cluster = createCluster({ name: body.name, strategyMode });
    return res.status(201).json({ cluster });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unexpected error";
    return res.status(400).json({ error: message });
  }
});

clustersRouter.get("/:id", (req, res) => {
  const id = Number.parseInt(req.params.id, 10);
  if (Number.isNaN(id) || id < 1) {
    return res.status(400).json({ error: "cluster id must be a positive integer" });
  }

  try {
    const cluster = getCluster(id);
    const wallets = listClusterWallets(id);
    return res.json({ cluster, wallets });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unexpected error";
    return res.status(404).json({ error: message });
  }
});

clustersRouter.put("/:id/wallets", (req, res) => {
  const id = Number.parseInt(req.params.id, 10);
  if (Number.isNaN(id) || id < 1) {
    return res.status(400).json({ error: "cluster id must be a positive integer" });
  }

  const body = req.body as SetClusterWalletsBody;
  if (!Array.isArray(body.walletIds) || body.walletIds.length === 0) {
    return res.status(400).json({ error: "walletIds must be a non-empty array" });
  }

  if (!body.walletIds.every((walletId) => Number.isInteger(walletId) && walletId > 0)) {
    return res.status(400).json({ error: "walletIds must contain positive integers" });
  }

  try {
    const assigned = setClusterWallets(id, body.walletIds);
    const wallets = listClusterWallets(id);
    return res.json({ assigned, wallets });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unexpected error";
    return res.status(400).json({ error: message });
  }
});
