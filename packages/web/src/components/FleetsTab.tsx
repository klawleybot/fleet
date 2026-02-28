import { useState, useCallback } from "react";
import { fetchFleetDashboard, deleteFleet } from "../api/client";
import { fmtEth, fmtPnl, pnlColor, shortAddr, baseScanAddr, relTime } from "../lib/format";
import type { FleetDashboard, FleetInfo } from "../types";
import { useDashboard } from "../hooks/useDashboard";

function CoinRow({ coin }: { coin: FleetDashboard["coinSummaries"][0] }) {
  const hasHoldings = BigInt(coin.totalHoldings) > 0n;
  return (
    <tr className="border-t border-slate-800">
      <td className="py-2 pr-4 font-mono text-xs text-slate-300">
        <a
          href={baseScanAddr(coin.coinAddress)}
          target="_blank"
          rel="noreferrer"
          className="hover:underline"
        >
          {shortAddr(coin.coinAddress)}
        </a>
      </td>
      <td className="py-2 pr-4 text-right text-xs text-slate-300">
        {fmtEth(coin.totalCostWei, 5)} ETH
      </td>
      <td className="py-2 pr-4 text-right text-xs text-slate-300">
        {fmtEth(coin.totalReceivedWei, 5)} ETH
      </td>
      <td className={`py-2 pr-4 text-right text-xs ${pnlColor(coin.totalRealizedPnlWei)}`}>
        {fmtPnl(coin.totalRealizedPnlWei)} ETH
      </td>
      <td className="py-2 text-right text-xs text-slate-400">
        {hasHoldings ? "holding" : "closed"}
      </td>
    </tr>
  );
}

function WalletRow({ wallet }: { wallet: FleetDashboard["wallets"][0] }) {
  return (
    <tr className="border-t border-slate-800">
      <td className="py-2 pr-4 text-xs text-slate-300">{wallet.name}</td>
      <td className="py-2 pr-4 font-mono text-xs">
        <a
          href={baseScanAddr(wallet.address)}
          target="_blank"
          rel="noreferrer"
          className="text-slate-400 hover:text-slate-200 hover:underline"
        >
          {shortAddr(wallet.address)}
        </a>
      </td>
      <td className="py-2 text-right text-xs text-slate-300">
        {fmtEth(wallet.balanceWei, 6)} ETH
      </td>
    </tr>
  );
}

function FleetDetail({ fleetName }: { fleetName: string }) {
  const [detail, setDetail] = useState<FleetDashboard | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  const load = useCallback(async () => {
    setIsLoading(true);
    try {
      const data = await fetchFleetDashboard(fleetName);
      setDetail(data);
      setError(null);
      setLoaded(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load fleet detail");
    } finally {
      setIsLoading(false);
    }
  }, [fleetName]);

  if (!loaded) {
    return (
      <div className="mt-3 px-1">
        <button
          onClick={() => void load()}
          disabled={isLoading}
          className="rounded bg-slate-700 px-3 py-1 text-xs hover:bg-slate-600 disabled:opacity-50"
        >
          {isLoading ? "Loading…" : "Load detail"}
        </button>
        {error && <p className="mt-1 text-xs text-rose-400">{error}</p>}
      </div>
    );
  }

  if (!detail) return null;

  return (
    <div className="mt-3 space-y-4 border-t border-slate-800 pt-3">
      {/* Wallet balances */}
      <div>
        <h4 className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-400">
          Wallets
        </h4>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-slate-500">
                <th className="pb-1 pr-4 font-medium">Name</th>
                <th className="pb-1 pr-4 font-medium">Address</th>
                <th className="pb-1 text-right font-medium">Balance</th>
              </tr>
            </thead>
            <tbody>
              {detail.wallets.map((w) => (
                <WalletRow key={w.address} wallet={w} />
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Coin positions */}
      {detail.coinSummaries.length > 0 && (
        <div>
          <h4 className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-400">
            Positions
          </h4>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-slate-500">
                  <th className="pb-1 pr-4 font-medium">Coin</th>
                  <th className="pb-1 pr-4 text-right font-medium">Cost</th>
                  <th className="pb-1 pr-4 text-right font-medium">Received</th>
                  <th className="pb-1 pr-4 text-right font-medium">P&L</th>
                  <th className="pb-1 text-right font-medium">Status</th>
                </tr>
              </thead>
              <tbody>
                {detail.coinSummaries.map((c) => (
                  <CoinRow key={c.coinAddress} coin={c} />
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <button
        onClick={() => void load()}
        className="text-xs text-slate-500 hover:text-slate-300"
      >
        Refresh detail
      </button>
    </div>
  );
}

function FleetCard({ fleet, onDeleted }: { fleet: FleetDashboard; onDeleted: () => void }) {
  const [expanded, setExpanded] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);

  async function handleDelete() {
    if (!deleteConfirm) {
      setDeleteConfirm(true);
      return;
    }
    setIsDeleting(true);
    try {
      await deleteFleet(fleet.name);
      onDeleted();
    } catch {
      setIsDeleting(false);
      setDeleteConfirm(false);
    }
  }

  return (
    <div className="rounded-lg border border-slate-700 bg-slate-900 p-4">
      <div className="flex items-start gap-2">
        <button
          className="flex flex-1 items-start justify-between text-left"
          onClick={() => setExpanded((v) => !v)}
        >
          <div>
            <h3 className="font-semibold text-slate-100">{fleet.name}</h3>
            <p className="text-xs text-slate-400">
              {fleet.walletCount} wallets · cluster #{fleet.clusterId}
            </p>
          </div>
          <span className="ml-2 mt-0.5 text-slate-500">{expanded ? "▲" : "▼"}</span>
        </button>
        <button
          onClick={() => void handleDelete()}
          disabled={isDeleting}
          title={deleteConfirm ? "Click again to confirm deletion" : "Delete fleet"}
          className={`mt-0.5 shrink-0 rounded px-2 py-0.5 text-xs transition-colors disabled:opacity-50 ${
            deleteConfirm
              ? "bg-rose-700 text-white hover:bg-rose-600"
              : "text-slate-600 hover:text-rose-400"
          }`}
        >
          {isDeleting ? "…" : deleteConfirm ? "Confirm" : "✕"}
        </button>
      </div>
      {deleteConfirm && (
        <p className="mt-1 text-xs text-amber-400">
          Removes fleet tracking only — wallets and on-chain funds are unaffected.
        </p>
      )}

      <div className="mt-3 grid grid-cols-3 gap-3 text-sm">
        <div>
          <p className="text-xs text-slate-400">ETH balance</p>
          <p className="font-medium text-slate-200">{fleet.totalEth} ETH</p>
        </div>
        <div>
          <p className="text-xs text-slate-400">Realized P&L</p>
          <p className={`font-medium ${pnlColor(fleet.realizedPnlWei)}`}>
            {fmtPnl(fleet.realizedPnlWei)} ETH
          </p>
        </div>
        <div>
          <p className="text-xs text-slate-400">Positions</p>
          <p className="font-medium text-slate-200">{fleet.coinSummaries.length}</p>
        </div>
      </div>

      {expanded && <FleetDetail fleetName={fleet.name} />}
    </div>
  );
}

export function FleetsTab() {
  const { dashboard, isLoading, error, refresh } = useDashboard();

  if (isLoading && !dashboard) {
    return <p className="text-sm text-slate-400">Loading fleets…</p>;
  }

  if (error && !dashboard) {
    return (
      <div className="rounded bg-rose-900/40 p-3 text-sm text-rose-300">
        <p>{error}</p>
        <button onClick={() => void refresh()} className="mt-2 text-xs hover:underline">
          Retry
        </button>
      </div>
    );
  }

  if (!dashboard) return null;

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-300">
          {dashboard.fleets.length} Fleet(s)
        </h2>
        <button onClick={() => void refresh()} className="text-xs text-slate-500 hover:text-slate-300">
          Refresh
        </button>
      </div>

      {dashboard.fleets.length === 0 ? (
        <p className="text-sm text-slate-400">
          No fleets found. Create one via the Controls tab.
        </p>
      ) : (
        dashboard.fleets.map((fleet) => (
          <FleetCard key={fleet.name} fleet={fleet} onDeleted={() => void refresh()} />
        ))
      )}
    </div>
  );
}
