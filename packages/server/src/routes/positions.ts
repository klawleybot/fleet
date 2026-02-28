import { Router } from "express";
import { isAddress } from "viem";
import { db } from "../db/index.js";
import { getFleetStatus } from "../services/monitor.js";
import { getErc20Balance } from "../services/balance.js";

export const positionsRouter = Router();

/** POST /positions/import — scan all fleet wallets for an existing on-chain token balance and begin tracking it */
positionsRouter.post("/import", async (req, res) => {
  const body = req.body as { coinAddress?: string };
  const raw = body.coinAddress?.trim();

  if (!raw || !isAddress(raw)) {
    return res.status(400).json({ error: "coinAddress must be a valid EVM address" });
  }

  const coin = raw.toLowerCase() as `0x${string}`;
  const wallets = db.listWallets().filter((w) => !w.isMaster);

  const balances = await Promise.all(
    wallets.map(async (w) => {
      try {
        const balance = await getErc20Balance(coin, w.address as `0x${string}`);
        return { wallet: w, balance };
      } catch {
        return { wallet: w, balance: 0n };
      }
    }),
  );

  const imported = [];
  let skippedCount = 0;
  let noBalanceCount = 0;

  for (const { wallet, balance } of balances) {
    if (balance <= 0n) {
      noBalanceCount++;
      continue;
    }
    const existing = db.getPosition(wallet.id, coin);
    if (existing) {
      skippedCount++;
      continue;
    }
    const record = db.upsertPosition({
      walletId: wallet.id,
      coinAddress: coin,
      costDelta: "0",
      receivedDelta: "0",
      holdingsDelta: balance.toString(),
      isBuy: true,
    });
    imported.push(record);
  }

  return res.json({ imported, skippedCount, noBalanceCount });
});

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
