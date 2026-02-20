import { Router } from "express";
import { db } from "../db/index.js";
import { getFleetStatus } from "../services/monitor.js";

export const positionsRouter = Router();

/** GET /positions — all positions across all wallets */
positionsRouter.get("/", (_req, res) => {
  const positions = db.listAllPositions();
  return res.json({ positions });
});

/** GET /positions/cluster/:id — positions for a specific cluster */
positionsRouter.get("/cluster/:id", async (req, res) => {
  const clusterId = Number(req.params.id);
  if (!Number.isInteger(clusterId) || clusterId < 1) {
    return res.status(400).json({ error: "Invalid cluster id" });
  }

  const refreshBalances = req.query.refresh === "true";

  try {
    const summary = await getFleetStatus({ clusterId, refreshBalances });
    return res.json(summary);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unexpected error";
    return res.status(400).json({ error: message });
  }
});

/** GET /positions/wallet/:id — positions for a specific wallet */
positionsRouter.get("/wallet/:id", (req, res) => {
  const walletId = Number(req.params.id);
  if (!Number.isInteger(walletId) || walletId < 1) {
    return res.status(400).json({ error: "Invalid wallet id" });
  }

  const positions = db.listPositionsByWallet(walletId);
  return res.json({ walletId, positions });
});

/** GET /positions/coin/:address — positions across all wallets for a coin */
positionsRouter.get("/coin/:address", (req, res) => {
  const coinAddress = req.params.address as `0x${string}`;
  const positions = db.listPositionsByCoin(coinAddress);
  return res.json({ coinAddress, positions });
});
