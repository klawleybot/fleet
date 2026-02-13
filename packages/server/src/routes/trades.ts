import { Router } from "express";
import { isAddress } from "viem";
import { coordinatedSwap, listTradeHistory } from "../services/trade.js";
import type { SwapRequestBody } from "../types.js";

export const tradesRouter = Router();

tradesRouter.post("/swap", async (req, res) => {
  const body = req.body as SwapRequestBody;
  if (!Array.isArray(body.walletIds) || body.walletIds.length === 0) {
    return res.status(400).json({
      error: "walletIds must be a non-empty array of wallet ids",
    });
  }
  if (!isAddress(body.fromToken) || !isAddress(body.toToken)) {
    return res.status(400).json({
      error: "fromToken and toToken must be valid EVM addresses",
    });
  }
  if (typeof body.amountInWei !== "string") {
    return res.status(400).json({ error: "amountInWei must be a string" });
  }
  if (!Number.isInteger(body.slippageBps)) {
    return res.status(400).json({ error: "slippageBps must be an integer" });
  }

  let amountInWei: bigint;
  try {
    amountInWei = BigInt(body.amountInWei);
  } catch {
    return res.status(400).json({ error: "amountInWei must be a valid integer string" });
  }

  try {
    const records = await coordinatedSwap({
      walletIds: body.walletIds,
      fromToken: body.fromToken,
      toToken: body.toToken,
      amountInWei,
      slippageBps: body.slippageBps,
    });
    return res.json({ records });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unexpected error";
    return res.status(400).json({ error: message });
  }
});

tradesRouter.get("/history", (_req, res) => {
  return res.json({
    records: listTradeHistory(),
  });
});

