import { Router } from "express";
import {
  getIntelligenceEngine,
  getIntelligenceStatus,
  runIntelligenceTick,
  startIntelligenceLoop,
  stopIntelligenceLoop,
} from "../services/intelligence.js";

export const intelligenceRouter = Router();

interface WatchlistBody {
  coinAddress?: string;
  listName?: string;
  label?: string;
  notes?: string;
}

interface CoinDetailResponse {
  coin?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parseStringQueryValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function parseLimit(value: unknown, fallback: number, max: number): number {
  const parsed = Number(parseStringQueryValue(value) ?? fallback);
  return Math.min(max, Math.max(1, parsed));
}

function parseIntervalSec(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

function parseWatchlistBody(value: unknown): WatchlistBody {
  if (!isRecord(value)) return {};
  const body: WatchlistBody = {};
  if (typeof value.coinAddress === "string") body.coinAddress = value.coinAddress;
  if (typeof value.listName === "string") body.listName = value.listName;
  if (typeof value.label === "string") body.label = value.label;
  if (typeof value.notes === "string") body.notes = value.notes;
  return body;
}

function isCoinDetailResponse(value: unknown): value is CoinDetailResponse {
  return isRecord(value);
}

// ============================================================
// Daemon control
// ============================================================

intelligenceRouter.get("/status", (_req, res) => {
  return res.json(getIntelligenceStatus());
});

intelligenceRouter.post("/start", (req, res) => {
  try {
    const intervalSec = isRecord(req.body) ? parseIntervalSec(req.body.intervalSec) : undefined;
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

intelligenceRouter.post("/tick", (_req, res) => {
  void (async () => {
    try {
      const result = await runIntelligenceTick();
      res.json(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Tick failed";
      res.status(500).json({ error: message });
    }
  })();
});

// ============================================================
// Coins
// ============================================================

intelligenceRouter.get("/coins/recent", (req, res) => {
  try {
    const limit = parseLimit(isRecord(req.query) ? req.query.limit : undefined, 20, 100);
    const engine = getIntelligenceEngine();
    return res.json({ coins: engine.recentCoins(limit) });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to fetch recent coins";
    return res.status(500).json({ error: message });
  }
});

intelligenceRouter.get("/coins/top", (req, res) => {
  try {
    const limit = parseLimit(isRecord(req.query) ? req.query.limit : undefined, 20, 100);
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
    const detail: unknown = engine.getCoinDetail(req.params.address);
    if (!isCoinDetailResponse(detail)) {
      return res.status(500).json({ error: "Invalid coin detail response" });
    }
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
    const limit = parseLimit(isRecord(req.query) ? req.query.limit : undefined, 20, 100);
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
    const limit = parseLimit(isRecord(req.query) ? req.query.limit : undefined, 50, 200);
    const engine = getIntelligenceEngine();
    return res.json({ alerts: engine.latestAlerts(limit) });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to fetch alerts";
    return res.status(500).json({ error: message });
  }
});

intelligenceRouter.post("/alerts/dispatch", (_req, res) => {
  void (async () => {
    try {
      const engine = getIntelligenceEngine();
      const result = await engine.dispatchPendingAlerts();
      res.json({ dispatched: result !== null, message: result });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Dispatch failed";
      res.status(500).json({ error: message });
    }
  })();
});

// ============================================================
// Watchlist
// ============================================================

intelligenceRouter.get("/watchlist", (req, res) => {
  try {
    const listName = isRecord(req.query) ? parseStringQueryValue(req.query.listName) ?? "default" : "default";
    const engine = getIntelligenceEngine();
    return res.json({ items: engine.watchlistList(listName) });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to fetch watchlist";
    return res.status(500).json({ error: message });
  }
});

intelligenceRouter.post("/watchlist", (req, res) => {
  try {
    const { coinAddress, listName, label, notes } = parseWatchlistBody(req.body);
    if (!coinAddress) return res.status(400).json({ error: "coinAddress is required" });
    const engine = getIntelligenceEngine();
    const result: unknown = engine.watchlistAdd(coinAddress, listName, label, notes);
    return res.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to add to watchlist";
    return res.status(400).json({ error: message });
  }
});

intelligenceRouter.delete("/watchlist/:coinAddress", (req, res) => {
  try {
    const listName = isRecord(req.query) ? parseStringQueryValue(req.query.listName) ?? "default" : "default";
    const engine = getIntelligenceEngine();
    const removed = engine.watchlistRemove(req.params.coinAddress, listName);
    return res.json({ removed });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to remove from watchlist";
    return res.status(500).json({ error: message });
  }
});

intelligenceRouter.get("/watchlist/moves", (req, res) => {
  try {
    const listName = isRecord(req.query) ? parseStringQueryValue(req.query.listName) ?? "default" : "default";
    const limit = parseLimit(isRecord(req.query) ? req.query.limit : undefined, 25, 100);
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
