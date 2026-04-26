import { Router } from "express";
import { isAddress } from "viem";
import { createFleetWallets, ensureMasterWallet, getWalletEthBalance, listWallets } from "../services/wallet.js";
import { bootstrapFleetFunding, getWalletBootstrapWei } from "../services/funding.js";
import { getErc20Balance } from "../services/balance.js";
import { db } from "../db/index.js";

interface CreateWalletsBody {
  count?: number;
  name?: string;
  bootstrapAmountWei?: string;
}

interface TokenBalanceQuery {
  token?: string;
}

function isCreateWalletsBody(value: unknown): value is CreateWalletsBody {
  if (typeof value !== "object" || value === null) return false;
  const body = value as Record<string, unknown>;
  return (
    (body.count === undefined || typeof body.count === "number") &&
    (body.name === undefined || typeof body.name === "string") &&
    (body.bootstrapAmountWei === undefined || typeof body.bootstrapAmountWei === "string")
  );
}

function isTokenBalanceQuery(value: unknown): value is TokenBalanceQuery {
  if (typeof value !== "object" || value === null) return false;
  const query = value as Record<string, unknown>;
  return query.token === undefined || typeof query.token === "string";
}

export const walletsRouter = Router();

walletsRouter.post("/", (req, res) => {
  const body = isCreateWalletsBody(req.body) ? req.body : {};
  const count = body.count ?? 1;

  if (!Number.isInteger(count) || count < 1 || count > 500) {
    return res.status(400).json({
      error: "count must be an integer between 1 and 500",
    });
  }

  let bootstrapWei = getWalletBootstrapWei();
  if (body.bootstrapAmountWei !== undefined) {
    try {
      bootstrapWei = BigInt(body.bootstrapAmountWei);
    } catch {
      return res.status(400).json({ error: "bootstrapAmountWei must be a valid integer string" });
    }
    if (bootstrapWei < 0n) {
      return res.status(400).json({ error: "bootstrapAmountWei must be >= 0" });
    }
  }

  void (async () => {
    try {
      const fleetName = typeof body.name === "string" && body.name.trim() ? body.name.trim() : `wallet-${Date.now()}`;
      const created = await createFleetWallets(count, fleetName);
      if (bootstrapWei > 0n && created.length > 0) {
        try {
          const bootstrapRecords = await bootstrapFleetFunding({
            walletIds: created.map((wallet) => wallet.id),
            amountWei: bootstrapWei,
          });
          res.status(201).json({ created, bootstrapRecords, bootstrapAmountWei: bootstrapWei.toString() });
          return;
        } catch (error) {
          const message = error instanceof Error ? error.message : "Bootstrap funding failed";
          res.status(500).json({
            error: message,
            created,
            bootstrapAmountWei: bootstrapWei.toString(),
          });
          return;
        }
      }
      res.status(201).json({ created });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unexpected error";
      res.status(500).json({ error: message });
    }
  })();
});

walletsRouter.get("/", (_req, res) => {
  void (async () => {
    try {
      await ensureMasterWallet();
      const wallets = listWallets();
      res.json({ wallets });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unexpected error";
      res.status(500).json({ error: message });
    }
  })();
});

walletsRouter.delete("/:id", (req, res) => {
  const id = Number.parseInt(req.params.id, 10);
  if (Number.isNaN(id) || id < 1) {
    return res.status(400).json({ error: "wallet id must be a positive integer" });
  }

  const wallet = db.getWalletById(id);
  if (!wallet) {
    return res.status(404).json({ error: "Wallet not found" });
  }
  if (wallet.isMaster) {
    return res.status(400).json({ error: "Cannot delete master wallet" });
  }

  const deleted = db.deleteWallet(id);
  return res.json({ deleted });
});

walletsRouter.get("/:id/balance", (req, res) => {
  const id = Number.parseInt(req.params.id, 10);
  if (Number.isNaN(id) || id < 1) {
    return res.status(400).json({ error: "wallet id must be a positive integer" });
  }

  const query = isTokenBalanceQuery(req.query) ? req.query : {};
  const token = typeof query.token === "string" ? query.token : undefined;

  void (async () => {
    try {
      const ethResult = await getWalletEthBalance(id);
      if (!token) {
        res.json({
          wallet: ethResult.wallet,
          ethBalanceWei: ethResult.balanceWei,
        });
        return;
      }

      if (!isAddress(token)) {
        res.status(400).json({ error: "token must be a valid EVM address" });
        return;
      }

      const tokenBalance = await getErc20Balance(token, ethResult.wallet.address);
      res.json({
        wallet: ethResult.wallet,
        ethBalanceWei: ethResult.balanceWei,
        tokenAddress: token,
        tokenBalanceRaw: tokenBalance.toString(),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unexpected error";
      if (message.includes("was not found")) {
        res.status(404).json({ error: message });
        return;
      }
      res.status(500).json({ error: message });
    }
  })();
});
