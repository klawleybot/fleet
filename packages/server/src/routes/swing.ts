import { Router } from "express";
import { isAddress } from "viem";
import { db } from "../db/index.js";
import { getSwingStatus, runSwingTick, startSwingLoop, stopSwingLoop } from "../services/swing.js";

export const swingRouter = Router();

type CreateSwingConfigInput = Parameters<typeof db.createSwingConfig>[0];
type UpdateSwingConfigPatch = Parameters<typeof db.updateSwingConfig>[1];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parseCreateSwingConfigInput(value: unknown): CreateSwingConfigInput | null {
  if (!isRecord(value)) return null;
  if (typeof value.fleetName !== "string" || !isAddress(value.coinAddress)) return null;

  const trailingStopBps =
    value.trailingStopBps === null || typeof value.trailingStopBps === "number"
      ? value.trailingStopBps
      : undefined;

  return {
    fleetName: value.fleetName,
    coinAddress: value.coinAddress,
    takeProfitBps: typeof value.takeProfitBps === "number" ? value.takeProfitBps : undefined,
    stopLossBps: typeof value.stopLossBps === "number" ? value.stopLossBps : undefined,
    trailingStopBps,
    cooldownSec: typeof value.cooldownSec === "number" ? value.cooldownSec : undefined,
    slippageBps: typeof value.slippageBps === "number" ? value.slippageBps : undefined,
  };
}

function parseUpdateSwingConfigPatch(value: unknown): UpdateSwingConfigPatch | null {
  if (!isRecord(value)) return null;

  const patch: UpdateSwingConfigPatch = {};
  if (typeof value.takeProfitBps === "number") patch.takeProfitBps = value.takeProfitBps;
  if (typeof value.stopLossBps === "number") patch.stopLossBps = value.stopLossBps;
  if (value.trailingStopBps === null || typeof value.trailingStopBps === "number") {
    patch.trailingStopBps = value.trailingStopBps;
  }
  if (typeof value.cooldownSec === "number") patch.cooldownSec = value.cooldownSec;
  if (typeof value.slippageBps === "number") patch.slippageBps = value.slippageBps;
  if (typeof value.enabled === "boolean") patch.enabled = value.enabled;
  if (value.peakPnlBps === null || typeof value.peakPnlBps === "number") patch.peakPnlBps = value.peakPnlBps;
  if (value.lastActionAt === null || typeof value.lastActionAt === "string") patch.lastActionAt = value.lastActionAt;

  return patch;
}

function parseIntervalSec(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

swingRouter.get("/", (_req, res) => {
  return res.json(db.listSwingConfigs());
});

swingRouter.post("/", (req, res) => {
  try {
    const body = parseCreateSwingConfigInput(req.body);
    if (!body) {
      return res.status(400).json({ error: "fleetName and coinAddress are required" });
    }
    const config = db.createSwingConfig(body);
    return res.status(201).json(config);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unexpected error";
    return res.status(400).json({ error: message });
  }
});

swingRouter.patch("/:id", (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const patch = parseUpdateSwingConfigPatch(req.body);
    if (Number.isNaN(id)) {
      return res.status(400).json({ error: "id must be a valid integer" });
    }
    if (!patch) {
      return res.status(400).json({ error: "request body must be an object" });
    }
    const config = db.updateSwingConfig(id, patch);
    return res.json(config);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unexpected error";
    return res.status(400).json({ error: message });
  }
});

swingRouter.delete("/:id", (req, res) => {
  const id = parseInt(req.params.id, 10);
  const deleted = db.deleteSwingConfig(id);
  return res.json({ deleted });
});

swingRouter.post("/tick", (_req, res) => {
  void (async () => {
    try {
      const tick = await runSwingTick();
      res.json({ tick });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unexpected error";
      res.status(400).json({ error: message });
    }
  })();
});

swingRouter.get("/status", (_req, res) => {
  return res.json(getSwingStatus());
});

swingRouter.post("/start", (req, res) => {
  try {
    const intervalSec = isRecord(req.body) ? parseIntervalSec(req.body.intervalSec) : undefined;
    return res.json(startSwingLoop(intervalSec));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unexpected error";
    return res.status(400).json({ error: message });
  }
});

swingRouter.post("/stop", (_req, res) => {
  return res.json(stopSwingLoop());
});
