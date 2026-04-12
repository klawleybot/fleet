import { Router } from "express";
import { bootstrapFleetFunding, distributeFunding, getWalletBootstrapWei, listFundingHistory } from "../services/funding.js";
import type { FundingRequestBody } from "../types.js";

export const fundingRouter = Router();

function isFundingRequestBody(value: unknown): value is FundingRequestBody {
  if (typeof value !== "object" || value === null) return false;
  const body = value as Record<string, unknown>;
  return (
    Array.isArray(body.toWalletIds) &&
    body.toWalletIds.every((walletId) => typeof walletId === "number") &&
    typeof body.amountWei === "string"
  );
}

function isBootstrapBody(value: unknown): value is { walletIds?: number[]; amountWei?: string } {
  if (typeof value !== "object" || value === null) return false;
  const body = value as Record<string, unknown>;
  return (
    (body.walletIds === undefined || (Array.isArray(body.walletIds) && body.walletIds.every((id) => typeof id === "number"))) &&
    (body.amountWei === undefined || typeof body.amountWei === "string")
  );
}

fundingRouter.post("/distribute", (req, res) => {
  const body: unknown = req.body;
  if (!isFundingRequestBody(body) || body.toWalletIds.length === 0) {
    return res.status(400).json({
      error: "toWalletIds must be a non-empty array of wallet ids",
    });
  }

  let amountWei: bigint;
  try {
    amountWei = BigInt(body.amountWei);
  } catch {
    return res.status(400).json({ error: "amountWei must be a valid integer string" });
  }

  void (async () => {
    try {
      const records = await distributeFunding({
        toWalletIds: body.toWalletIds,
        amountWei,
      });
      res.json({ records });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unexpected error";
      res.status(400).json({ error: message });
    }
  })();
});

fundingRouter.post("/bootstrap", (req, res) => {
  const body = isBootstrapBody(req.body) ? req.body : {};
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

  void (async () => {
    try {
      const records = await bootstrapFleetFunding({
        ...(body.walletIds ? { walletIds: body.walletIds } : {}),
        ...(amountWei !== undefined ? { amountWei } : {}),
      });
      res.json({ records, amountWei: (amountWei ?? getWalletBootstrapWei()).toString() });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unexpected error";
      res.status(400).json({ error: message });
    }
  })();
});

fundingRouter.get("/history", (_req, res) => {
  return res.json({
    records: listFundingHistory(),
  });
});
