import { Router } from "express";
import { db } from "../db/index.js";
import { getSwingStatus, runSwingTick, startSwingLoop, stopSwingLoop } from "../services/swing.js";

export const swingRouter = Router();

swingRouter.get("/", (_req, res) => {
  return res.json(db.listSwingConfigs());
});

swingRouter.post("/", (req, res) => {
  try {
    const body = req.body as {
      fleetName: string;
      coinAddress: `0x${string}`;
      takeProfitBps?: number;
      stopLossBps?: number;
      trailingStopBps?: number | null;
      cooldownSec?: number;
      slippageBps?: number;
    };
    if (!body.fleetName || !body.coinAddress) {
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
    const id = parseInt(req.params.id!, 10);
    const config = db.updateSwingConfig(id, req.body);
    return res.json(config);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unexpected error";
    return res.status(400).json({ error: message });
  }
});

swingRouter.delete("/:id", (req, res) => {
  const id = parseInt(req.params.id!, 10);
  const deleted = db.deleteSwingConfig(id);
  return res.json({ deleted });
});

swingRouter.post("/tick", async (_req, res) => {
  try {
    const tick = await runSwingTick();
    return res.json({ tick });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unexpected error";
    return res.status(400).json({ error: message });
  }
});

swingRouter.get("/status", (_req, res) => {
  return res.json(getSwingStatus());
});

swingRouter.post("/start", (req, res) => {
  const body = req.body as { intervalSec?: number };
  try {
    return res.json(startSwingLoop(body.intervalSec));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unexpected error";
    return res.status(400).json({ error: message });
  }
});

swingRouter.post("/stop", (_req, res) => {
  return res.json(stopSwingLoop());
});
