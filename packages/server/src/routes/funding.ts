import { Router } from "express";
import { bootstrapFleetFunding, distributeFunding, getWalletBootstrapWei, listFundingHistory } from "../services/funding.js";
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

fundingRouter.post("/bootstrap", async (req, res) => {
  const body = (req.body ?? {}) as { walletIds?: number[]; amountWei?: string };
  if (body.walletIds !== undefined) {
    if (!Array.isArray(body.walletIds) || body.walletIds.some((id) => !Number.isInteger(id) || id < 1)) {
      return res.status(400).json({ error: "walletIds must be an array of positive integer wallet ids" });
    }
  }

  let amountWei: bigint | undefined;
  if (body.amountWei !== undefined) {
    try {
      amountWei = BigInt(body.amountWei);
    } catch {
      return res.status(400).json({ error: "amountWei must be a valid integer string" });
    }
    if (amountWei < 0n) {
      return res.status(400).json({ error: "amountWei must be >= 0" });
    }
  }

  try {
    const records = await bootstrapFleetFunding({
      ...(body.walletIds ? { walletIds: body.walletIds } : {}),
      ...(amountWei !== undefined ? { amountWei } : {}),
    });
    return res.json({ records, amountWei: (amountWei ?? getWalletBootstrapWei()).toString() });
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

