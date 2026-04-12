import { Router } from "express";
import { getAutonomyStatus, runAutonomyTick, startAutonomyLoop, stopAutonomyLoop } from "../services/autonomy.js";

interface StartBody {
  intervalSec?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parseStartBody(value: unknown): StartBody {
  if (!isRecord(value)) return {};
  return {
    intervalSec: typeof value.intervalSec === "number" ? value.intervalSec : undefined,
  };
}

export const autonomyRouter = Router();

autonomyRouter.get("/status", (_req, res) => {
  return res.json(getAutonomyStatus());
});

autonomyRouter.post("/start", (req, res) => {
  const body = parseStartBody(req.body);
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

autonomyRouter.post("/tick", (_req, res) => {
  void (async () => {
    try {
      const tick = await runAutonomyTick();
      res.json({ tick });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unexpected error";
      res.status(400).json({ error: message });
    }
  })();
});
