import { Router } from "express";
import { distributeFunding, listFundingHistory } from "../services/funding.js";
import type { FundingRequestBody } from "../types.js";

export const fundingRouter = Router();

fundingRouter.post("/distribute", async (req, res) => {
  const body = req.body as FundingRequestBody;
  if (!Array.isArray(body.toWalletIds) || body.toWalletIds.length === 0) {
    return res.status(400).json({
      error: "toWalletIds must be a non-empty array of wallet ids",
    });
  }
  if (typeof body.amountWei !== "string") {
    return res.status(400).json({ error: "amountWei must be a string" });
  }

  let amountWei: bigint;
  try {
    amountWei = BigInt(body.amountWei);
  } catch {
    return res.status(400).json({ error: "amountWei must be a valid integer string" });
  }

  try {
    const records = await distributeFunding({
      toWalletIds: body.toWalletIds,
      amountWei,
    });
    return res.json({ records });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unexpected error";
    return res.status(400).json({ error: message });
  }
});

fundingRouter.get("/history", (_req, res) => {
  return res.json({
    records: listFundingHistory(),
  });
});

