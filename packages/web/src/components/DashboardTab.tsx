import { useDashboard } from "../hooks/useDashboard";
import { useAutonomy } from "../hooks/useAutonomy";
import { fmtEth, fmtPnl, pnlColor, shortAddr, baseScanAddr, relTime } from "../lib/format";

function StatCard({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-lg border border-slate-700 bg-slate-900 p-4">
      <p className="text-xs font-medium uppercase tracking-wide text-slate-400">{label}</p>
      <p className="mt-1 text-2xl font-bold text-slate-100">{value}</p>
      {sub && <p className="mt-0.5 text-sm text-slate-400">{sub}</p>}
    </div>
  );
}

function AutonomyPanel() {
  const { status, isBusy, error, start, stop, tick } = useAutonomy();

  return (
    <div className="rounded-lg border border-slate-700 bg-slate-900 p-4">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-300">Autonomy</h2>
        <div className="flex items-center gap-2">
          <span
            className={`inline-block h-2 w-2 rounded-full ${
              status?.running ? "bg-emerald-400" : "bg-slate-500"
            }`}
          />
          <span className="text-sm text-slate-400">
            {status?.running
              ? status.isTicking
                ? "ticking…"
                : `running · ${status.intervalSec}s interval`
              : "stopped"}
          </span>
        </div>
      </div>

      {error && <p className="mt-2 text-xs text-rose-400">{error}</p>}

      <div className="mt-3 flex flex-wrap gap-2">
        {status?.running ? (
          <button
            onClick={() => void stop()}
            disabled={isBusy}
            className="rounded bg-rose-700 px-3 py-1 text-xs font-medium hover:bg-rose-600 disabled:opacity-50"
          >
            Stop
          </button>
        ) : (
          <button
            onClick={() => void start()}
            disabled={isBusy}
            className="rounded bg-emerald-700 px-3 py-1 text-xs font-medium hover:bg-emerald-600 disabled:opacity-50"
          >
            Start
          </button>
        )}
        <button
          onClick={() => void tick()}
          disabled={isBusy || status?.isTicking}
          className="rounded bg-slate-700 px-3 py-1 text-xs font-medium hover:bg-slate-600 disabled:opacity-50"
        >
          Tick now
        </button>
      </div>

      {status?.lastTick && (
        <div className="mt-3 space-y-0.5 text-xs text-slate-400">
          <p>Last tick: {relTime(status.lastTick.finishedAt)}</p>
          <p>
            Created {status.lastTick.createdOperationIds.length} op(s) · Executed{" "}
            {status.lastTick.executedOperationIds.length} op(s)
          </p>
          {status.lastTick.errors.length > 0 && (
            <p className="text-rose-400">{status.lastTick.errors.length} error(s)</p>
          )}
        </div>
      )}
    </div>
  );
}

export function DashboardTab() {
  const { dashboard, isLoading, error, lastUpdated, refresh } = useDashboard();

  if (isLoading && !dashboard) {
    return <p className="text-sm text-slate-400">Loading dashboard…</p>;
  }

  if (error && !dashboard) {
    return (
      <div className="rounded bg-rose-900/40 p-3 text-sm text-rose-300">
        <p className="font-medium">Could not reach server</p>
        <p className="mt-0.5 text-xs">{error}</p>
        <button
          onClick={() => void refresh()}
          className="mt-2 rounded bg-rose-800 px-2 py-1 text-xs hover:bg-rose-700"
        >
          Retry
        </button>
      </div>
    );
  }

  if (!dashboard) return null;

  const globalPnlWei = dashboard.globalRealizedPnlWei;

  return (
    <div className="space-y-4">
      {/* Top-line stats */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatCard
          label="Total ETH"
          value={`${fmtEth(dashboard.totalAvailableEthWei, 4)} ETH`}
          sub={`${dashboard.fleets.length} fleet(s) + master`}
        />
        <StatCard
          label="Realized P&L"
          value={`${fmtPnl(globalPnlWei)} ETH`}
          sub={`cost ${fmtEth(dashboard.globalCostWei, 4)} · rcvd ${fmtEth(dashboard.globalReceivedWei, 4)}`}
        />
        <StatCard
          label="Master Balance"
          value={`${fmtEth(dashboard.master.balanceWei, 4)} ETH`}
          sub={shortAddr(dashboard.master.address)}
        />
        <StatCard label="Fleets" value={String(dashboard.fleets.length)} />
      </div>

      {/* Autonomy */}
      <AutonomyPanel />

      {/* Master wallet link */}
      <div className="rounded-lg border border-slate-700 bg-slate-900 p-4">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-300">
          Master Wallet
        </h2>
        <div className="mt-2 flex items-center gap-2 text-sm">
          <a
            href={baseScanAddr(dashboard.master.address)}
            target="_blank"
            rel="noreferrer"
            className="font-mono text-slate-300 hover:text-slate-100 hover:underline"
          >
            {dashboard.master.address}
          </a>
          <span className="text-slate-400">
            {fmtEth(dashboard.master.balanceWei, 6)} ETH
          </span>
        </div>
      </div>

      {/* Fleet summary cards */}
      <div>
        <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-slate-300">
          Fleets
        </h2>
        {dashboard.fleets.length === 0 ? (
          <p className="text-sm text-slate-400">No fleets yet.</p>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {dashboard.fleets.map((fleet) => (
              <div
                key={fleet.name}
                className="rounded-lg border border-slate-700 bg-slate-900 p-4"
              >
                <div className="flex items-baseline justify-between">
                  <h3 className="font-semibold text-slate-100">{fleet.name}</h3>
                  <span className="text-xs text-slate-400">{fleet.walletCount} wallets</span>
                </div>
                <div className="mt-2 space-y-1 text-sm">
                  <div className="flex justify-between">
                    <span className="text-slate-400">ETH balance</span>
                    <span className="text-slate-200">{fleet.totalEth} ETH</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-slate-400">Realized P&L</span>
                    <span className={pnlColor(fleet.realizedPnlWei)}>
                      {fmtPnl(fleet.realizedPnlWei)} ETH
                    </span>
                  </div>
                  {fleet.coinSummaries.length > 0 && (
                    <div className="flex justify-between">
                      <span className="text-slate-400">Open positions</span>
                      <span className="text-slate-200">{fleet.coinSummaries.length}</span>
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {lastUpdated && (
        <p className="text-right text-xs text-slate-600">
          Updated {relTime(lastUpdated.toISOString())} ·{" "}
          <button onClick={() => void refresh()} className="hover:text-slate-400">
            Refresh
          </button>
        </p>
      )}
    </div>
  );
}
