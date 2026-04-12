import { Router } from "express";
import { getGlobalDashboard, getFleetDashboard } from "../services/dashboard.js";

export const dashboardRouter = Router();

/** GET /dashboard — global P&L + available ETH across all fleets */
dashboardRouter.get("/", (_req, res) => {
  void (async () => {
    try {
      const dashboard = await getGlobalDashboard();
      res.json(dashboard);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unexpected error";
      res.status(500).json({ error: message });
    }
  })();
});

/** GET /dashboard/fleet/:name — per-fleet P&L + available ETH */
dashboardRouter.get("/fleet/:name", (req, res) => {
  void (async () => {
    try {
      const dashboard = await getFleetDashboard(req.params.name);
      res.json(dashboard);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unexpected error";
      res.status(400).json({ error: message });
    }
  })();
});
