import { Router } from "express";
import {
  getIntelligenceEngine,
  getIntelligenceStatus,
  runIntelligenceTick,
  startIntelligenceLoop,
  stopIntelligenceLoop,
} from "../services/intelligence.js";

export const intelligenceRouter = Router();

// ============================================================
// Daemon control
// ============================================================

intelligenceRouter.get("/status", (_req, res) => {
  return res.json(getIntelligenceStatus());
});

intelligenceRouter.post("/start", (req, res) => {
  try {
    const intervalSec = req.body?.intervalSec ? Number(req.body.intervalSec) : undefined;
    const status = startIntelligenceLoop(intervalSec ? { intervalSec } : undefined);
    return res.json(status);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to start intelligence loop";
    return res.status(400).json({ error: message });
  }
});

intelligenceRouter.post("/stop", (_req, res) => {
  return res.json(stopIntelligenceLoop());
});

intelligenceRouter.post("/tick", async (_req, res) => {
  try {
    const result = await runIntelligenceTick();
    return res.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Tick failed";
    return res.status(500).json({ error: message });
  }
});

// ============================================================
// Coins
// ============================================================

intelligenceRouter.get("/coins/recent", (req, res) => {
  try {
    const limit = Math.min(100, Math.max(1, Number(req.query.limit ?? 20)));
    const engine = getIntelligenceEngine();
    return res.json({ coins: engine.recentCoins(limit) });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to fetch recent coins";
    return res.status(500).json({ error: message });
  }
});

intelligenceRouter.get("/coins/top", (req, res) => {
  try {
    const limit = Math.min(100, Math.max(1, Number(req.query.limit ?? 20)));
    const engine = getIntelligenceEngine();
    return res.json({ coins: engine.topVolumeCoins(limit) });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to fetch top coins";
    return res.status(500).json({ error: message });
  }
});

intelligenceRouter.get("/coins/:address", (req, res) => {
  try {
    const engine = getIntelligenceEngine();
    const detail = engine.getCoinDetail(req.params.address!);
    if (!detail.coin) return res.status(404).json({ error: "Coin not found" });
    return res.json(detail);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to fetch coin detail";
    return res.status(500).json({ error: message });
  }
});

// ============================================================
// Analytics
// ============================================================

intelligenceRouter.get("/analytics", (req, res) => {
  try {
    const limit = Math.min(100, Math.max(1, Number(req.query.limit ?? 20)));
    const engine = getIntelligenceEngine();
    return res.json({ analytics: engine.topAnalytics(limit) });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to fetch analytics";
    return res.status(500).json({ error: message });
  }
});

// ============================================================
// Alerts
// ============================================================

intelligenceRouter.get("/alerts", (req, res) => {
  try {
    const limit = Math.min(200, Math.max(1, Number(req.query.limit ?? 50)));
    const engine = getIntelligenceEngine();
    return res.json({ alerts: engine.latestAlerts(limit) });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to fetch alerts";
    return res.status(500).json({ error: message });
  }
});

intelligenceRouter.post("/alerts/dispatch", async (_req, res) => {
  try {
    const engine = getIntelligenceEngine();
    const result = await engine.dispatchPendingAlerts();
    return res.json({ dispatched: result !== null, message: result });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Dispatch failed";
    return res.status(500).json({ error: message });
  }
});

// ============================================================
// Watchlist
// ============================================================

intelligenceRouter.get("/watchlist", (req, res) => {
  try {
    const listName = (req.query.listName as string) || "default";
    const engine = getIntelligenceEngine();
    return res.json({ items: engine.watchlistList(listName) });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to fetch watchlist";
    return res.status(500).json({ error: message });
  }
});

intelligenceRouter.post("/watchlist", (req, res) => {
  try {
    const { coinAddress, listName, label, notes } = req.body ?? {};
    if (!coinAddress) return res.status(400).json({ error: "coinAddress is required" });
    const engine = getIntelligenceEngine();
    const result = engine.watchlistAdd(coinAddress, listName, label, notes);
    return res.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to add to watchlist";
    return res.status(400).json({ error: message });
  }
});

intelligenceRouter.delete("/watchlist/:coinAddress", (req, res) => {
  try {
    const listName = (req.query.listName as string) || "default";
    const engine = getIntelligenceEngine();
    const removed = engine.watchlistRemove(req.params.coinAddress!, listName);
    return res.json({ removed });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to remove from watchlist";
    return res.status(500).json({ error: message });
  }
});

intelligenceRouter.get("/watchlist/moves", (req, res) => {
  try {
    const listName = (req.query.listName as string) || "default";
    const limit = Math.min(100, Math.max(1, Number(req.query.limit ?? 25)));
    const engine = getIntelligenceEngine();
    return res.json({ moves: engine.watchlistMoves(listName, limit) });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to fetch watchlist moves";
    return res.status(500).json({ error: message });
  }
});

// ============================================================
// Summary stats (for web dashboard)
// ============================================================

intelligenceRouter.get("/summary", (_req, res) => {
  try {
    const engine = getIntelligenceEngine();
    return res.json({
      coinCount: engine.coinCount(),
      alertCount: engine.alertCount(),
      watchlistCount: engine.watchlistCount(),
      status: getIntelligenceStatus(),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to fetch summary";
    return res.status(500).json({ error: message });
  }
});
