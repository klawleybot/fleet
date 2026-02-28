import { useState } from "react";
import { useIntelligence } from "../hooks/useIntelligence";
import { useCoins } from "../hooks/useCoins";
import { useAlerts } from "../hooks/useAlerts";
import { useWatchlist } from "../hooks/useWatchlist";
import { shortAddr, relTime } from "../lib/format";
import type { IntelAnalytics, IntelAlert, WatchlistItem } from "../types";

// ============================================================
// Shared helpers
// ============================================================

function SeverityBadge({ severity }: { severity: string }) {
  const colors: Record<string, string> = {
    critical: "bg-rose-900/50 text-rose-300",
    high: "bg-orange-900/50 text-orange-300",
    medium: "bg-amber-900/40 text-amber-400",
    low: "bg-slate-700 text-slate-400",
    info: "bg-slate-800 text-slate-500",
  };
  return (
    <span className={`rounded px-1.5 py-0.5 text-xs ${colors[severity.toLowerCase()] ?? "bg-slate-800 text-slate-400"}`}>
      {severity}
    </span>
  );
}

function fmtUsd(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "—";
  if (Math.abs(v) >= 1_000_000) return `$${(v / 1_000_000).toFixed(1)}M`;
  if (Math.abs(v) >= 1_000) return `$${(v / 1_000).toFixed(1)}K`;
  return `$${v.toFixed(0)}`;
}

function fmtNum(v: number | null | undefined, decimals = 1): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "—";
  return v.toFixed(decimals);
}

function StatCard({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-lg border border-slate-800 bg-slate-900/50 px-4 py-3">
      <p className="text-xs text-slate-500">{label}</p>
      <p className="mt-0.5 text-lg font-semibold text-slate-200">{value}</p>
    </div>
  );
}

// ============================================================
// Overview sub-tab
// ============================================================

function OverviewPanel() {
  const { summary, isLoading, isBusy, error, start, stop, tick } = useIntelligence();
  const status = summary?.status;

  return (
    <div className="space-y-4">
      {error && <p className="text-xs text-rose-400">{error}</p>}

      {/* Daemon controls */}
      <div className="flex items-center gap-3">
        <span className="flex items-center gap-1.5 text-sm">
          <span className={`h-2 w-2 rounded-full ${status?.running ? "bg-emerald-500" : "bg-slate-600"}`} />
          {status?.running ? "Running" : "Stopped"}
          {status?.running && <span className="text-xs text-slate-500">({status.intervalSec}s)</span>}
        </span>
        <div className="flex gap-1.5">
          {!status?.running ? (
            <button
              onClick={() => void start()}
              disabled={isBusy || isLoading}
              className="rounded bg-emerald-700 px-2.5 py-1 text-xs text-white hover:bg-emerald-600 disabled:opacity-50"
            >
              Start
            </button>
          ) : (
            <button
              onClick={() => void stop()}
              disabled={isBusy}
              className="rounded bg-slate-700 px-2.5 py-1 text-xs text-slate-300 hover:bg-slate-600 disabled:opacity-50"
            >
              Stop
            </button>
          )}
          <button
            onClick={() => void tick()}
            disabled={isBusy || status?.isTicking}
            className="rounded bg-slate-700 px-2.5 py-1 text-xs text-slate-300 hover:bg-slate-600 disabled:opacity-50"
          >
            {status?.isTicking ? "Ticking…" : "Tick"}
          </button>
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatCard label="Coins tracked" value={summary?.coinCount ?? "—"} />
        <StatCard label="Unsent alerts" value={summary?.alertCount ?? "—"} />
        <StatCard label="Watchlist" value={summary?.watchlistCount ?? "—"} />
        <StatCard
          label="Last sync"
          value={status?.lastTick ? relTime(status.lastTick.finishedAt) : "—"}
        />
      </div>

      {/* Last tick details */}
      {status?.lastTick && (
        <div className="rounded border border-slate-800 bg-slate-900/30 p-3">
          <p className="mb-1.5 text-xs font-medium text-slate-400">Last tick</p>
          <div className="grid grid-cols-3 gap-2 text-xs sm:grid-cols-6">
            <div>
              <span className="text-slate-500">Recent</span>{" "}
              <span className="text-slate-300">{status.lastTick.syncedRecent}</span>
            </div>
            <div>
              <span className="text-slate-500">Top</span>{" "}
              <span className="text-slate-300">{status.lastTick.syncedTop}</span>
            </div>
            <div>
              <span className="text-slate-500">Swaps</span>{" "}
              <span className="text-slate-300">{status.lastTick.swaps}</span>
            </div>
            <div>
              <span className="text-slate-500">Clusters</span>{" "}
              <span className="text-slate-300">{status.lastTick.clusters}</span>
            </div>
            <div>
              <span className="text-slate-500">Analytics</span>{" "}
              <span className="text-slate-300">{status.lastTick.analytics}</span>
            </div>
            <div>
              <span className="text-slate-500">Alerts</span>{" "}
              <span className="text-slate-300">{status.lastTick.alerts}</span>
            </div>
          </div>
          {status.lastTick.errors.length > 0 && (
            <div className="mt-2">
              {status.lastTick.errors.map((e, i) => (
                <p key={i} className="text-xs text-rose-400">{e}</p>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ============================================================
// Coins sub-tab
// ============================================================

type CoinSort = "momentum_score_1h" | "momentum_acceleration_1h" | "swap_count_1h" | "net_flow_usdc_1h" | "volume_24h";

function CoinsPanel() {
  const { coins, isLoading, error, refresh } = useCoins(50);
  const [sortBy, setSortBy] = useState<CoinSort>("momentum_score_1h");
  const [sortAsc, setSortAsc] = useState(false);

  const sorted = [...coins].sort((a, b) => {
    const av = Number(a[sortBy] ?? 0);
    const bv = Number(b[sortBy] ?? 0);
    return sortAsc ? av - bv : bv - av;
  });

  function toggleSort(col: CoinSort) {
    if (sortBy === col) setSortAsc(!sortAsc);
    else { setSortBy(col); setSortAsc(false); }
  }

  function SortHeader({ col, label }: { col: CoinSort; label: string }) {
    return (
      <th
        className="cursor-pointer pb-1 pr-2 text-right font-medium hover:text-slate-300"
        onClick={() => toggleSort(col)}
      >
        {label}{sortBy === col ? (sortAsc ? " +" : " -") : ""}
      </th>
    );
  }

  if (isLoading) return <p className="text-sm text-slate-400">Loading coins…</p>;
  if (error) return <p className="text-sm text-rose-400">{error}</p>;

  return (
    <div className="space-y-3">
      <div className="flex justify-end">
        <button onClick={() => void refresh()} className="text-xs text-slate-500 hover:text-slate-300">
          Refresh
        </button>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-slate-500">
              <th className="pb-1 pr-3 font-medium">Coin</th>
              <th className="pb-1 pr-2 text-right font-medium">MCap</th>
              <SortHeader col="volume_24h" label="Vol 24h" />
              <SortHeader col="swap_count_1h" label="Swaps 1h" />
              <SortHeader col="net_flow_usdc_1h" label="Flow 1h" />
              <SortHeader col="momentum_score_1h" label="Mom 1h" />
              <SortHeader col="momentum_acceleration_1h" label="Accel" />
              <th className="pb-1 pr-2 text-right font-medium">Swaps 24h</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((c) => (
              <CoinRow key={c.coin_address} coin={c} />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function CoinRow({ coin: c }: { coin: IntelAnalytics }) {
  const label = c.symbol || c.name || shortAddr(c.coin_address);
  const flowColor = (c.net_flow_usdc_1h ?? 0) > 0 ? "text-emerald-400" : (c.net_flow_usdc_1h ?? 0) < 0 ? "text-rose-400" : "text-slate-400";
  const accelColor = (c.momentum_acceleration_1h ?? 0) > 1.5 ? "text-emerald-400" : (c.momentum_acceleration_1h ?? 0) < 0.5 ? "text-rose-400" : "text-slate-400";

  return (
    <tr className="border-t border-slate-800 hover:bg-slate-800/30">
      <td className="py-1.5 pr-3">
        <a
          href={c.coin_url}
          target="_blank"
          rel="noreferrer"
          className="text-xs font-medium text-slate-200 hover:text-white hover:underline"
        >
          {label}
        </a>
        {c.symbol && c.name && (
          <span className="ml-1.5 text-xs text-slate-500">{c.name}</span>
        )}
      </td>
      <td className="py-1.5 pr-2 text-right text-xs text-slate-400">{fmtUsd(c.market_cap)}</td>
      <td className="py-1.5 pr-2 text-right text-xs text-slate-400">{fmtUsd(c.volume_24h)}</td>
      <td className="py-1.5 pr-2 text-right text-xs text-slate-300">{c.swap_count_1h}</td>
      <td className={`py-1.5 pr-2 text-right text-xs ${flowColor}`}>{fmtUsd(c.net_flow_usdc_1h)}</td>
      <td className="py-1.5 pr-2 text-right text-xs text-slate-300">{fmtNum(c.momentum_score_1h, 0)}</td>
      <td className={`py-1.5 pr-2 text-right text-xs ${accelColor}`}>{fmtNum(c.momentum_acceleration_1h, 2)}x</td>
      <td className="py-1.5 pr-2 text-right text-xs text-slate-400">{c.swap_count_24h}</td>
    </tr>
  );
}

// ============================================================
// Alerts sub-tab
// ============================================================

function AlertsPanel() {
  const { alerts, isLoading, error, refresh } = useAlerts(50);
  const [filter, setFilter] = useState<string | null>(null);

  const filtered = filter ? alerts.filter((a) => a.severity.toLowerCase() === filter) : alerts;

  if (isLoading) return <p className="text-sm text-slate-400">Loading alerts…</p>;
  if (error) return <p className="text-sm text-rose-400">{error}</p>;

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex gap-1">
          {[null, "high", "medium", "low"].map((sev) => (
            <button
              key={sev ?? "all"}
              onClick={() => setFilter(sev)}
              className={`rounded px-2 py-1 text-xs ${filter === sev ? "bg-slate-700 text-slate-100" : "text-slate-400 hover:text-slate-200"}`}
            >
              {sev ?? "All"}
              <span className="ml-1 rounded-full bg-slate-800 px-1.5 py-0.5 text-xs text-slate-500">
                {sev ? alerts.filter((a) => a.severity.toLowerCase() === sev).length : alerts.length}
              </span>
            </button>
          ))}
        </div>
        <button onClick={() => void refresh()} className="text-xs text-slate-500 hover:text-slate-300">
          Refresh
        </button>
      </div>

      {filtered.length === 0 ? (
        <p className="text-sm text-slate-400">No alerts.</p>
      ) : (
        <div className="space-y-1.5">
          {filtered.map((a, i) => (
            <AlertCard key={i} alert={a} />
          ))}
        </div>
      )}
    </div>
  );
}

function AlertCard({ alert: a }: { alert: IntelAlert }) {
  return (
    <div className="flex items-start gap-2 rounded border border-slate-800 bg-slate-900/30 p-2.5">
      <SeverityBadge severity={a.severity} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="text-xs font-medium text-slate-300">{a.type}</span>
          {a.entity_id && (
            <a
              href={a.coin_url ?? `https://zora.co/coin/base:${a.entity_id.toLowerCase()}`}
              target="_blank"
              rel="noreferrer"
              className="font-mono text-xs text-slate-500 hover:text-slate-300 hover:underline"
            >
              {shortAddr(a.entity_id)}
            </a>
          )}
          <span className="text-xs text-slate-600">{relTime(a.created_at)}</span>
        </div>
        <p className="mt-0.5 text-xs text-slate-400 break-all">{a.message}</p>
      </div>
    </div>
  );
}

// ============================================================
// Watchlist sub-tab
// ============================================================

function WatchlistPanel() {
  const { items, isLoading, isBusy, error, addCoin, removeCoin, refresh } = useWatchlist();
  const [addAddr, setAddAddr] = useState("");
  const [addLabel, setAddLabel] = useState("");
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  function handleAdd(e: React.FormEvent) {
    e.preventDefault();
    if (!addAddr.trim()) return;
    void addCoin(addAddr.trim(), addLabel.trim() || undefined);
    setAddAddr("");
    setAddLabel("");
  }

  function handleRemove(coinAddress: string) {
    if (confirmDelete === coinAddress) {
      void removeCoin(coinAddress);
      setConfirmDelete(null);
    } else {
      setConfirmDelete(coinAddress);
    }
  }

  if (isLoading) return <p className="text-sm text-slate-400">Loading watchlist…</p>;
  if (error) return <p className="text-sm text-rose-400">{error}</p>;

  return (
    <div className="space-y-4">
      {/* Add form */}
      <form onSubmit={handleAdd} className="flex gap-2">
        <input
          type="text"
          placeholder="0x coin address"
          value={addAddr}
          onChange={(e) => setAddAddr(e.target.value)}
          className="flex-1 rounded border border-slate-700 bg-slate-800 px-3 py-1.5 text-xs text-slate-200 placeholder:text-slate-600 focus:border-slate-500 focus:outline-none"
        />
        <input
          type="text"
          placeholder="Label (optional)"
          value={addLabel}
          onChange={(e) => setAddLabel(e.target.value)}
          className="w-32 rounded border border-slate-700 bg-slate-800 px-3 py-1.5 text-xs text-slate-200 placeholder:text-slate-600 focus:border-slate-500 focus:outline-none"
        />
        <button
          type="submit"
          disabled={isBusy || !addAddr.trim()}
          className="rounded bg-blue-700 px-3 py-1.5 text-xs text-white hover:bg-blue-600 disabled:opacity-50"
        >
          Add
        </button>
      </form>

      {/* Table */}
      {items.length === 0 ? (
        <p className="text-sm text-slate-400">Watchlist empty.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-slate-500">
                <th className="pb-1 pr-3 font-medium">Coin</th>
                <th className="pb-1 pr-2 text-right font-medium">Vol 24h</th>
                <th className="pb-1 pr-2 text-right font-medium">Swaps 1h</th>
                <th className="pb-1 pr-2 text-right font-medium">Flow 1h</th>
                <th className="pb-1 pr-2 text-right font-medium">Mom 1h</th>
                <th className="pb-1 pr-2 text-right font-medium">Accel</th>
                <th className="pb-1 font-medium" />
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <WatchlistRow
                  key={item.coin_address}
                  item={item}
                  isConfirming={confirmDelete === item.coin_address}
                  onRemove={() => handleRemove(item.coin_address)}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="flex justify-end">
        <button onClick={() => void refresh()} className="text-xs text-slate-500 hover:text-slate-300">
          Refresh
        </button>
      </div>
    </div>
  );
}

function WatchlistRow({
  item,
  isConfirming,
  onRemove,
}: {
  item: WatchlistItem;
  isConfirming: boolean;
  onRemove: () => void;
}) {
  const label = item.label || item.symbol || item.name || shortAddr(item.coin_address);
  const flowColor = (item.net_flow_usdc_1h ?? 0) > 0 ? "text-emerald-400" : (item.net_flow_usdc_1h ?? 0) < 0 ? "text-rose-400" : "text-slate-400";

  return (
    <tr className="border-t border-slate-800 hover:bg-slate-800/30">
      <td className="py-1.5 pr-3">
        <a
          href={item.coin_url}
          target="_blank"
          rel="noreferrer"
          className="text-xs font-medium text-slate-200 hover:text-white hover:underline"
        >
          {label}
        </a>
        <span className="ml-1.5 font-mono text-xs text-slate-600">{shortAddr(item.coin_address)}</span>
      </td>
      <td className="py-1.5 pr-2 text-right text-xs text-slate-400">{fmtUsd(item.volume_24h)}</td>
      <td className="py-1.5 pr-2 text-right text-xs text-slate-300">{item.swap_count_1h ?? "—"}</td>
      <td className={`py-1.5 pr-2 text-right text-xs ${flowColor}`}>{fmtUsd(item.net_flow_usdc_1h)}</td>
      <td className="py-1.5 pr-2 text-right text-xs text-slate-300">{fmtNum(item.momentum_score_1h, 0)}</td>
      <td className="py-1.5 pr-2 text-right text-xs text-slate-400">{fmtNum(item.momentum_acceleration_1h, 2)}x</td>
      <td className="py-1.5 text-right">
        <button
          onClick={onRemove}
          className={`rounded px-2 py-0.5 text-xs ${
            isConfirming
              ? "bg-rose-800 text-rose-200 hover:bg-rose-700"
              : "text-slate-500 hover:text-rose-400"
          }`}
        >
          {isConfirming ? "Confirm" : "Remove"}
        </button>
      </td>
    </tr>
  );
}

// ============================================================
// Main tab
// ============================================================

type SubTab = "overview" | "coins" | "alerts" | "watchlist";

export function IntelligenceTab() {
  const [activeTab, setActiveTab] = useState<SubTab>("overview");

  const tabs: { id: SubTab; label: string }[] = [
    { id: "overview", label: "Overview" },
    { id: "coins", label: "Coins" },
    { id: "alerts", label: "Alerts" },
    { id: "watchlist", label: "Watchlist" },
  ];

  return (
    <div className="space-y-3">
      <div className="flex gap-1">
        {tabs.map((t) => (
          <button
            key={t.id}
            onClick={() => setActiveTab(t.id)}
            className={`rounded px-3 py-1.5 text-xs font-medium transition-colors ${
              activeTab === t.id
                ? "bg-slate-700 text-slate-100"
                : "text-slate-400 hover:text-slate-200"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {activeTab === "overview" && <OverviewPanel />}
      {activeTab === "coins" && <CoinsPanel />}
      {activeTab === "alerts" && <AlertsPanel />}
      {activeTab === "watchlist" && <WatchlistPanel />}
    </div>
  );
}
