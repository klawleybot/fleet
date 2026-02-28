import { useState, useEffect, useCallback } from "react";
import { DashboardTab } from "./components/DashboardTab";
import { FleetsTab } from "./components/FleetsTab";
import { PositionsTab } from "./components/PositionsTab";
import { ActivityTab } from "./components/ActivityTab";
import { ControlsTab } from "./components/ControlsTab";
import { fetchHealth, fetchFleets } from "./api/client";
import type { HealthResponse, FleetInfo } from "./types";

type Tab = "dashboard" | "fleets" | "positions" | "activity" | "controls";

const TABS: { id: Tab; label: string }[] = [
  { id: "dashboard", label: "Dashboard" },
  { id: "fleets", label: "Fleets" },
  { id: "positions", label: "Positions" },
  { id: "activity", label: "Activity" },
  { id: "controls", label: "Controls" },
];

function ConnectionStatus({ health }: { health: HealthResponse | null | "error" }) {
  if (health === null) {
    return (
      <span className="flex items-center gap-1.5 text-xs text-slate-500">
        <span className="h-1.5 w-1.5 rounded-full bg-slate-600" />
        Connecting…
      </span>
    );
  }
  if (health === "error") {
    return (
      <span className="flex items-center gap-1.5 text-xs text-rose-400">
        <span className="h-1.5 w-1.5 rounded-full bg-rose-500" />
        Server offline
      </span>
    );
  }
  return (
    <span className="flex items-center gap-1.5 text-xs text-emerald-400">
      <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
      {health.fleetCount} fleet{health.fleetCount !== 1 ? "s" : ""}
    </span>
  );
}

export default function App() {
  const [tab, setTab] = useState<Tab>("dashboard");
  const [health, setHealth] = useState<HealthResponse | null | "error">(null);
  const [fleetNames, setFleetNames] = useState<string[]>([]);

  useEffect(() => {
    async function checkHealth() {
      try {
        const h = await fetchHealth();
        setHealth(h);
      } catch {
        setHealth("error");
      }
    }
    void checkHealth();
    const id = setInterval(() => void checkHealth(), 15_000);
    return () => clearInterval(id);
  }, []);

  const refreshFleets = useCallback(async () => {
    try {
      const fleets: FleetInfo[] = await fetchFleets();
      setFleetNames(fleets.map((f) => f.name));
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    void refreshFleets();
  }, [refreshFleets]);

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100">
      {/* Header */}
      <header className="border-b border-slate-800 px-4 py-3">
        <div className="mx-auto flex max-w-7xl items-center justify-between">
          <div>
            <h1 className="text-lg font-bold tracking-tight text-slate-100">Fleet Control</h1>
            <p className="text-xs text-slate-500">Base smart account fleet management</p>
          </div>
          <ConnectionStatus health={health} />
        </div>
      </header>

      {/* Nav tabs */}
      <nav className="border-b border-slate-800 px-4">
        <div className="mx-auto flex max-w-7xl gap-0.5 overflow-x-auto">
          {TABS.map((t) => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={`whitespace-nowrap px-4 py-2.5 text-sm font-medium transition-colors ${
                tab === t.id
                  ? "border-b-2 border-slate-300 text-slate-100"
                  : "text-slate-400 hover:text-slate-200"
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>
      </nav>

      {/* Main content */}
      <main className="mx-auto max-w-7xl px-4 py-6">
        {tab === "dashboard" && <DashboardTab />}
        {tab === "fleets" && <FleetsTab />}
        {tab === "positions" && <PositionsTab />}
        {tab === "activity" && <ActivityTab />}
        {tab === "controls" && <ControlsTab fleetNames={fleetNames} onFleetsChanged={() => void refreshFleets()} />}
      </main>
    </div>
  );
}
