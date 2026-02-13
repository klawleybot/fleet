import { Router } from "express";
import { isAddress } from "viem";
import { createFleetWallets, ensureMasterWallet, getWalletEthBalance, listWallets } from "../services/wallet.js";
import { getErc20Balance } from "../services/balance.js";

interface CreateWalletsBody {
  count?: number;
}

interface TokenBalanceQuery {
  token?: string;
}

export const walletsRouter = Router();

walletsRouter.post("/", async (req, res) => {
  const body = req.body as CreateWalletsBody;
  const count = body.count ?? 1;

  if (!Number.isInteger(count) || count < 1 || count > 500) {
    return res.status(400).json({
      error: "count must be an integer between 1 and 500",
    });
  }

  try {
    const created = await createFleetWallets(count);
    return res.status(201).json({ created });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unexpected error";
    return res.status(500).json({ error: message });
  }
});

walletsRouter.get("/", async (_req, res) => {
  try {
    await ensureMasterWallet();
    const wallets = listWallets();
    return res.json({ wallets });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unexpected error";
    return res.status(500).json({ error: message });
  }
});

walletsRouter.get("/:id/balance", async (req, res) => {
  const id = Number.parseInt(req.params.id, 10);
  if (Number.isNaN(id) || id < 1) {
    return res.status(400).json({ error: "wallet id must be a positive integer" });
  }

  try {
    const ethResult = await getWalletEthBalance(id);
    const query = req.query as TokenBalanceQuery;
    if (!query.token) {
      return res.json({
        wallet: ethResult.wallet,
        ethBalanceWei: ethResult.balanceWei,
      });
    }

    if (!isAddress(query.token)) {
      return res.status(400).json({ error: "token must be a valid EVM address" });
    }

    const tokenBalance = await getErc20Balance(
      query.token as `0x${string}`,
      ethResult.wallet.address,
    );
    return res.json({
      wallet: ethResult.wallet,
      ethBalanceWei: ethResult.balanceWei,
      tokenAddress: query.token,
      tokenBalanceRaw: tokenBalance.toString(),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unexpected error";
    if (message.includes("was not found")) {
      return res.status(404).json({ error: message });
    }
    return res.status(500).json({ error: message });
  }
});

