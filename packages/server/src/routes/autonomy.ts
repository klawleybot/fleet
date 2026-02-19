import { Router } from "express";
import { getAutonomyStatus, runAutonomyTick, startAutonomyLoop, stopAutonomyLoop } from "../services/autonomy.js";

interface StartBody {
  intervalSec?: number;
}

export const autonomyRouter = Router();

autonomyRouter.get("/status", (_req, res) => {
  return res.json(getAutonomyStatus());
});

autonomyRouter.post("/start", (req, res) => {
  const body = req.body as StartBody;
  if (body.intervalSec !== undefined && (!Number.isInteger(body.intervalSec) || body.intervalSec < 10)) {
    return res.status(400).json({ error: "intervalSec must be an integer >= 10" });
  }

  try {
    return res.json(startAutonomyLoop({ ...(body.intervalSec ? { intervalSec: body.intervalSec } : {}) }));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unexpected error";
    return res.status(400).json({ error: message });
  }
});

autonomyRouter.post("/stop", (_req, res) => {
  return res.json(stopAutonomyLoop());
});

autonomyRouter.post("/tick", async (_req, res) => {
  try {
    const tick = await runAutonomyTick();
    return res.json({ tick });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unexpected error";
    return res.status(400).json({ error: message });
  }
});
