import { Router } from "express";
import { isAddress } from "viem";
import { coordinatedSwap, listTradeHistory } from "../services/trade.js";
import type { SwapRequestBody } from "../types.js";

export const tradesRouter = Router();

function isSwapRequestBody(value: unknown): value is SwapRequestBody {
  if (typeof value !== "object" || value === null) return false;
  const body = value as Record<string, unknown>;
  return (
    Array.isArray(body.walletIds) &&
    body.walletIds.every((walletId) => typeof walletId === "number") &&
    isAddress(body.fromToken) &&
    isAddress(body.toToken) &&
    typeof body.amountInWei === "string" &&
    Number.isInteger(body.slippageBps)
  );
}

tradesRouter.post("/swap", (req, res) => {
  const body: unknown = req.body;
  if (!isSwapRequestBody(body) || body.walletIds.length === 0) {
    return res.status(400).json({
      error: "walletIds must be a non-empty array of wallet ids",
    });
  }

  let amountInWei: bigint;
  try {
    amountInWei = BigInt(body.amountInWei);
  } catch {
    return res.status(400).json({ error: "amountInWei must be a valid integer string" });
  }

  void (async () => {
    try {
      const records = await coordinatedSwap({
        walletIds: body.walletIds,
        fromToken: body.fromToken,
        toToken: body.toToken,
        amountInWei,
        slippageBps: body.slippageBps,
      });
      res.json({ records });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unexpected error";
      res.status(400).json({ error: message });
    }
  })();
});

tradesRouter.get("/history", (_req, res) => {
  return res.json({
    records: listTradeHistory(),
  });
});
