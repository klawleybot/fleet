import { useEffect, useMemo, useState } from "react";
import {
  approveAndExecuteOperation,
  fetchRoutePreview,
  fetchZoraSignalCandidates,
  requestSupportFromZoraSignal,
} from "../api/client";
import { useAutonomy } from "../hooks/useAutonomy";
import { useOperations } from "../hooks/useOperations";
import { fmtEth, relTime, shortAddr } from "../lib/format";
import { parseOperationPayload, parseOperationResult } from "../lib/operations";
import type {
  DeterministicRoute,
  FleetInfo,
  OperationRecord,
  ZoraSignalCandidate,
  ZoraSignalMode,
} from "../types";

const WETH_BASE = "0x4200000000000000000000000000000000000006" as const;

type AutomationSubview = "signals" | "queue" | "autonomy";

function toWeiString(value: string): string {
  const trimmed = value.trim();
  if (!trimmed || !/^\d*(\.\d*)?$/.test(trimmed)) {
    throw new Error("Enter a valid ETH amount");
  }

  const [wholePart, fractionalPart = ""] = trimmed.split(".");
  const whole = BigInt(wholePart || "0");
  const fraction = fractionalPart.slice(0, 18).padEnd(18, "0");
  return (whole * 10n ** 18n + BigInt(fraction || "0")).toString();
}

function fmtUsd(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  if (Math.abs(value) >= 1_000_000) return `$${(value / 1_000_000).toFixed(1)}M`;
  if (Math.abs(value) >= 1_000) return `$${(value / 1_000).toFixed(1)}K`;
  return `$${value.toFixed(0)}`;
}

function ClusterLabel({ fleets, clusterId }: { fleets: FleetInfo[]; clusterId: number }) {
  const fleet = fleets.find((entry) => entry.clusterId === clusterId);
  if (!fleet) {
    return <span className="text-slate-400">Cluster #{clusterId}</span>;
  }
  return (
    <span className="text-slate-300">
      {fleet.name}
      <span className="ml-1 text-slate-500">#{clusterId}</span>
    </span>
  );
}

function StatusBadge({ status }: { status: OperationRecord["status"] }) {
  const colors: Record<OperationRecord["status"], string> = {
    pending: "bg-amber-900/40 text-amber-300",
    approved: "bg-blue-900/40 text-blue-300",
    executing: "bg-indigo-900/40 text-indigo-300",
    complete: "bg-emerald-900/40 text-emerald-300",
    failed: "bg-rose-900/40 text-rose-300",
  };

  return (
    <span className={`rounded px-2 py-0.5 text-xs font-medium ${colors[status]}`}>
      {status}
    </span>
  );
}

function SignalsPanel({ fleets }: { fleets: FleetInfo[] }) {
  const [fleetName, setFleetName] = useState(fleets[0]?.name ?? "");
  const [mode, setMode] = useState<ZoraSignalMode>("watchlist_top");
  const [watchlistName, setWatchlistName] = useState("default");
  const [minMomentum, setMinMomentum] = useState("");
  const [amountEth, setAmountEth] = useState("0.01");
  const [slippageBps, setSlippageBps] = useState("100");
  const [candidates, setCandidates] = useState<ZoraSignalCandidate[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isQueueing, setIsQueueing] = useState(false);
  const [previewingAddress, setPreviewingAddress] = useState<`0x${string}` | null>(null);
  const [previewedRoute, setPreviewedRoute] = useState<DeterministicRoute | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!fleetName && fleets[0]) {
      setFleetName(fleets[0].name);
    }
  }, [fleetName, fleets]);

  const selectedFleet = useMemo(
    () => fleets.find((fleet) => fleet.name === fleetName) ?? null,
    [fleetName, fleets],
  );

  const topCandidate = candidates[0] ?? null;

  async function loadCandidates() {
    setIsLoading(true);
    setError(null);
    setMessage(null);
    setPreviewedRoute(null);
    setPreviewError(null);
    setPreviewingAddress(null);

    try {
      const minMomentumValue = minMomentum.trim() ? Number(minMomentum.trim()) : undefined;
      const rows = await fetchZoraSignalCandidates({
        mode,
        ...(mode === "watchlist_top" && watchlistName.trim()
          ? { listName: watchlistName.trim() }
          : {}),
        ...(mode === "top_momentum" && minMomentumValue !== undefined && Number.isFinite(minMomentumValue)
          ? { minMomentum: minMomentumValue }
          : {}),
        limit: 8,
      });
      setCandidates(rows);
      if (rows.length === 0) {
        setMessage("No signal candidates matched the current filter.");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load signal candidates");
      setCandidates([]);
    } finally {
      setIsLoading(false);
    }
  }

  async function previewRoute(candidate: ZoraSignalCandidate) {
    setPreviewingAddress(candidate.coinAddress);
    setPreviewError(null);
    try {
      const route = await fetchRoutePreview({
        fromToken: WETH_BASE,
        toToken: candidate.coinAddress,
      });
      setPreviewedRoute(route);
    } catch (err) {
      setPreviewedRoute(null);
      setPreviewError(err instanceof Error ? err.message : "Failed to preview route");
    } finally {
      setPreviewingAddress(null);
    }
  }

  async function queueSignalBuy() {
    if (!selectedFleet) {
      setError("Select a fleet before queueing a signal buy.");
      return;
    }

    setIsQueueing(true);
    setError(null);
    setMessage(null);
    try {
      const totalAmountWei = toWeiString(amountEth);
      const slippage = Number.parseInt(slippageBps, 10);
      if (!Number.isInteger(slippage) || slippage < 1) {
        throw new Error("Enter a valid slippage in basis points");
      }

      const result = await requestSupportFromZoraSignal({
        clusterId: selectedFleet.clusterId,
        mode,
        ...(mode === "watchlist_top" && watchlistName.trim()
          ? { listName: watchlistName.trim() }
          : {}),
        ...(mode === "top_momentum" && minMomentum.trim()
          ? { minMomentum: Number(minMomentum.trim()) }
          : {}),
        totalAmountWei,
        slippageBps: slippage,
        requestedBy: "web-operator",
      });

      const candidateLabel = topCandidate?.symbol || topCandidate?.name || "top candidate";
      setMessage(`Queued operation #${result.operation.id} for ${candidateLabel}.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to queue signal buy");
    } finally {
      setIsQueueing(false);
    }
  }

  if (fleets.length === 0) {
    return <p className="text-sm text-slate-400">Create a fleet before using signal-driven automation.</p>;
  }

  return (
    <div className="space-y-4">
      <div className="grid gap-4 lg:grid-cols-[22rem,1fr]">
        <div className="rounded-lg border border-slate-700 bg-slate-900 p-4">
          <h3 className="text-sm font-semibold text-slate-100">Signal Filters</h3>
          <p className="mt-1 text-xs text-slate-500">
            Load ranked candidates, preview a deterministic route, then queue a buy against the current top signal.
          </p>

          <div className="mt-4 space-y-3">
            <label className="block">
              <span className="text-xs text-slate-400">Fleet</span>
              <select
                value={fleetName}
                onChange={(event) => setFleetName(event.target.value)}
                className="mt-1 w-full rounded border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-slate-100 focus:border-slate-500 focus:outline-none"
              >
                {fleets.map((fleet) => (
                  <option key={fleet.clusterId} value={fleet.name}>
                    {fleet.name} · cluster #{fleet.clusterId}
                  </option>
                ))}
              </select>
            </label>

            <label className="block">
              <span className="text-xs text-slate-400">Mode</span>
              <select
                value={mode}
                onChange={(event) => setMode(event.target.value as ZoraSignalMode)}
                className="mt-1 w-full rounded border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-slate-100 focus:border-slate-500 focus:outline-none"
              >
                <option value="watchlist_top">Watchlist top</option>
                <option value="top_momentum">Top momentum</option>
              </select>
            </label>

            {mode === "watchlist_top" ? (
              <label className="block">
                <span className="text-xs text-slate-400">Watchlist name</span>
                <input
                  value={watchlistName}
                  onChange={(event) => setWatchlistName(event.target.value)}
                  className="mt-1 w-full rounded border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-slate-100 placeholder:text-slate-600 focus:border-slate-500 focus:outline-none"
                  placeholder="default"
                />
              </label>
            ) : (
              <label className="block">
                <span className="text-xs text-slate-400">Minimum momentum</span>
                <input
                  value={minMomentum}
                  onChange={(event) => setMinMomentum(event.target.value)}
                  className="mt-1 w-full rounded border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-slate-100 placeholder:text-slate-600 focus:border-slate-500 focus:outline-none"
                  placeholder="0"
                />
              </label>
            )}

            <div className="grid gap-3 sm:grid-cols-2">
              <label className="block">
                <span className="text-xs text-slate-400">Buy amount (ETH)</span>
                <input
                  value={amountEth}
                  onChange={(event) => setAmountEth(event.target.value)}
                  className="mt-1 w-full rounded border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-slate-100 focus:border-slate-500 focus:outline-none"
                />
              </label>
              <label className="block">
                <span className="text-xs text-slate-400">Slippage (bps)</span>
                <input
                  value={slippageBps}
                  onChange={(event) => setSlippageBps(event.target.value)}
                  className="mt-1 w-full rounded border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-slate-100 focus:border-slate-500 focus:outline-none"
                />
              </label>
            </div>

            <div className="flex flex-wrap gap-2 pt-1">
              <button
                onClick={() => void loadCandidates()}
                disabled={isLoading}
                className="rounded bg-slate-700 px-3 py-2 text-sm font-medium text-slate-100 hover:bg-slate-600 disabled:opacity-50"
              >
                {isLoading ? "Loading…" : "Load candidates"}
              </button>
              <button
                onClick={() => void queueSignalBuy()}
                disabled={isQueueing || !selectedFleet}
                className="rounded bg-emerald-700 px-3 py-2 text-sm font-medium text-white hover:bg-emerald-600 disabled:opacity-50"
              >
                {isQueueing ? "Queueing…" : "Queue top candidate"}
              </button>
            </div>
          </div>

          <div className="mt-4 space-y-1 text-xs">
            <p className="text-slate-500">
              The current backend endpoint queues the highest-ranked candidate for the active filter, not an arbitrary row from the list.
            </p>
            {topCandidate && (
              <p className="text-slate-400">
                Current top candidate: {topCandidate.symbol || topCandidate.name || shortAddr(topCandidate.coinAddress)}
              </p>
            )}
            {message && <p className="text-emerald-400">{message}</p>}
            {error && <p className="text-rose-400">{error}</p>}
          </div>
        </div>

        <div className="space-y-4">
          <div className="rounded-lg border border-slate-700 bg-slate-900 p-4">
            <div className="flex items-center justify-between">
              <div>
                <h3 className="text-sm font-semibold text-slate-100">Candidates</h3>
                <p className="mt-1 text-xs text-slate-500">
                  Ranked from the live signal selector exposed by the server.
                </p>
              </div>
              {selectedFleet && (
                <p className="text-xs text-slate-500">
                  Target fleet: {selectedFleet.name} · cluster #{selectedFleet.clusterId}
                </p>
              )}
            </div>

            {candidates.length === 0 ? (
              <p className="mt-4 text-sm text-slate-400">Load candidates to inspect the current signal set.</p>
            ) : (
              <div className="mt-4 grid gap-3 md:grid-cols-2">
                {candidates.map((candidate, index) => (
                  <div
                    key={candidate.coinAddress}
                    className={`rounded-lg border px-4 py-3 ${
                      index === 0
                        ? "border-emerald-700 bg-emerald-950/20"
                        : "border-slate-800 bg-slate-950/40"
                    }`}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <div className="flex items-center gap-2">
                          <a
                            href={candidate.coinUrl}
                            target="_blank"
                            rel="noreferrer"
                            className="text-sm font-semibold text-slate-100 hover:text-white hover:underline"
                          >
                            {candidate.symbol || candidate.name || shortAddr(candidate.coinAddress)}
                          </a>
                          {index === 0 && (
                            <span className="rounded bg-emerald-900/40 px-2 py-0.5 text-[11px] font-medium text-emerald-300">
                              Top match
                            </span>
                          )}
                        </div>
                        <p className="mt-1 font-mono text-xs text-slate-500">
                          {candidate.coinAddress}
                        </p>
                      </div>
                      <button
                        onClick={() => void previewRoute(candidate)}
                        disabled={previewingAddress === candidate.coinAddress}
                        className="rounded bg-slate-800 px-2.5 py-1 text-xs text-slate-200 hover:bg-slate-700 disabled:opacity-50"
                      >
                        {previewingAddress === candidate.coinAddress ? "Previewing…" : "Preview route"}
                      </button>
                    </div>

                    <div className="mt-3 grid grid-cols-2 gap-3 text-xs">
                      <div>
                        <p className="text-slate-500">Momentum</p>
                        <p className="text-slate-200">{candidate.momentumScore.toFixed(0)}</p>
                      </div>
                      <div>
                        <p className="text-slate-500">Swaps 24h</p>
                        <p className="text-slate-200">{candidate.swaps24h}</p>
                      </div>
                      <div>
                        <p className="text-slate-500">Net flow 24h</p>
                        <p className="text-slate-200">{fmtUsd(candidate.netFlowUsd24h)}</p>
                      </div>
                      <div>
                        <p className="text-slate-500">Volume 24h</p>
                        <p className="text-slate-200">{fmtUsd(candidate.volume24h)}</p>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="rounded-lg border border-slate-700 bg-slate-900 p-4">
            <h3 className="text-sm font-semibold text-slate-100">Route Preview</h3>
            <p className="mt-1 text-xs text-slate-500">
              Deterministic buy route from WETH to the selected candidate.
            </p>

            {previewError && <p className="mt-3 text-sm text-rose-400">{previewError}</p>}

            {!previewedRoute && !previewError ? (
              <p className="mt-3 text-sm text-slate-400">Select “Preview route” on a candidate to inspect its path.</p>
            ) : null}

            {previewedRoute && (
              <div className="mt-4 space-y-3">
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="rounded border border-slate-800 bg-slate-950/40 px-3 py-2">
                    <p className="text-xs text-slate-500">Hops</p>
                    <p className="mt-1 text-sm font-medium text-slate-100">{previewedRoute.hops}</p>
                  </div>
                  <div className="rounded border border-slate-800 bg-slate-950/40 px-3 py-2">
                    <p className="text-xs text-slate-500">Path length</p>
                    <p className="mt-1 text-sm font-medium text-slate-100">{previewedRoute.path.length} token(s)</p>
                  </div>
                </div>

                <div className="rounded border border-slate-800 bg-slate-950/40 p-3">
                  <p className="text-xs text-slate-500">Token path</p>
                  <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-slate-300">
                    {previewedRoute.path.map((address, index) => (
                      <div key={`${address}-${index}`} className="flex items-center gap-2">
                        <span className="rounded bg-slate-800 px-2 py-1 font-mono">{shortAddr(address)}</span>
                        {index < previewedRoute.path.length - 1 && <span className="text-slate-600">→</span>}
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function QueuePanel({ fleets }: { fleets: FleetInfo[] }) {
  const { operations, isLoading, error, refresh } = useOperations(120);
  const [filter, setFilter] = useState<"all" | "open" | "pending" | "failed">("open");
  const [busyId, setBusyId] = useState<number | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const counts = useMemo(() => ({
    all: operations.length,
    open: operations.filter((operation) => operation.status === "pending" || operation.status === "approved" || operation.status === "executing").length,
    pending: operations.filter((operation) => operation.status === "pending").length,
    failed: operations.filter((operation) => operation.status === "failed").length,
  }), [operations]);

  const filteredOperations = useMemo(() => {
    if (filter === "all") return operations;
    if (filter === "open") {
      return operations.filter((operation) =>
        operation.status === "pending" || operation.status === "approved" || operation.status === "executing",
      );
    }
    return operations.filter((operation) => operation.status === filter);
  }, [filter, operations]);

  async function approveOperation(operationId: number) {
    setBusyId(operationId);
    setMessage(null);
    try {
      const result = await approveAndExecuteOperation(operationId, "web-operator");
      setMessage(`Operation #${result.id} is now ${result.status}.`);
      await refresh();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Failed to approve operation");
    } finally {
      setBusyId(null);
    }
  }

  const filters: Array<{ id: "all" | "open" | "pending" | "failed"; label: string; count: number }> = [
    { id: "open", label: "Open", count: counts.open },
    { id: "pending", label: "Pending", count: counts.pending },
    { id: "failed", label: "Failed", count: counts.failed },
    { id: "all", label: "All", count: counts.all },
  ];

  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-slate-700 bg-slate-900 p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h3 className="text-sm font-semibold text-slate-100">Operation Queue</h3>
            <p className="mt-1 text-xs text-slate-500">
              Review queued work, inspect parsed payloads, and approve pending operations from one place.
            </p>
          </div>
          <button
            onClick={() => void refresh()}
            disabled={isLoading}
            className="rounded bg-slate-800 px-3 py-2 text-sm text-slate-200 hover:bg-slate-700 disabled:opacity-50"
          >
            Refresh
          </button>
        </div>

        <div className="mt-4 flex flex-wrap gap-2">
          {filters.map((entry) => (
            <button
              key={entry.id}
              onClick={() => setFilter(entry.id)}
              className={`rounded px-3 py-1.5 text-xs font-medium ${
                filter === entry.id
                  ? "bg-slate-700 text-slate-100"
                  : "bg-slate-900 text-slate-400 hover:text-slate-200"
              }`}
            >
              {entry.label}
              <span className="ml-1 rounded-full bg-slate-800 px-1.5 py-0.5 text-[11px] text-slate-400">
                {entry.count}
              </span>
            </button>
          ))}
        </div>

        {message && (
          <p className={`mt-4 text-sm ${message.startsWith("Operation #") ? "text-emerald-400" : "text-rose-400"}`}>
            {message}
          </p>
        )}
        {error && <p className="mt-4 text-sm text-rose-400">{error}</p>}
      </div>

      {filteredOperations.length === 0 ? (
        <p className="text-sm text-slate-400">No operations match the current filter.</p>
      ) : (
        <div className="space-y-3">
          {filteredOperations.map((operation) => {
            const payload = parseOperationPayload(operation);
            const result = parseOperationResult(operation);
            const tradeFailures = result.kind === "trade"
              ? result.trades.filter((trade) => trade.status !== "complete").length
              : 0;
            const fundingFailures = result.kind === "funding"
              ? result.fundingRecords.filter((record) => record.status !== "complete").length
              : 0;

            return (
              <div key={operation.id} className="rounded-lg border border-slate-800 bg-slate-900/70 p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <div className="flex flex-wrap items-center gap-2">
                      <StatusBadge status={operation.status} />
                      <span className="text-sm font-semibold text-slate-100">#{operation.id}</span>
                      <span className="text-sm text-slate-400">{operation.type}</span>
                      <ClusterLabel fleets={fleets} clusterId={operation.clusterId} />
                    </div>
                    <div className="mt-1 flex flex-wrap gap-3 text-xs text-slate-500">
                      <span>Requested by {operation.requestedBy ?? "unknown"}</span>
                      <span>Created {relTime(operation.createdAt)}</span>
                      <span>Updated {relTime(operation.updatedAt)}</span>
                      {operation.approvedBy && <span>Approved by {operation.approvedBy}</span>}
                    </div>
                  </div>

                  {operation.status === "pending" && (
                    <button
                      onClick={() => void approveOperation(operation.id)}
                      disabled={busyId === operation.id}
                      className="rounded bg-emerald-700 px-3 py-2 text-sm font-medium text-white hover:bg-emerald-600 disabled:opacity-50"
                    >
                      {busyId === operation.id ? "Approving…" : "Approve & execute"}
                    </button>
                  )}
                </div>

                <div className="mt-4 grid gap-4 lg:grid-cols-2">
                  <div className="rounded border border-slate-800 bg-slate-950/40 p-3">
                    <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Payload</p>
                    {payload.kind === "funding" && (
                      <div className="mt-3 space-y-1 text-sm text-slate-300">
                        <p>Funding amount: {fmtEth(payload.amountWei, 6)} ETH</p>
                      </div>
                    )}
                    {payload.kind === "trade" && (
                      <div className="mt-3 space-y-1 text-sm text-slate-300">
                        <p>
                          Coin: <span className="font-mono">{shortAddr(payload.coinAddress)}</span>
                        </p>
                        <p>Total amount: {fmtEth(payload.totalAmountWei, 6)} ETH</p>
                        <p>Slippage: {payload.slippageBps} bps</p>
                        <p>Strategy: {payload.strategyMode}</p>
                        {payload.signal && (
                          <p>
                            Signal: {payload.signal.mode} · score {payload.signal.momentumScore.toFixed(0)}
                          </p>
                        )}
                      </div>
                    )}
                    {payload.kind === "unknown" && (
                      <p className="mt-3 text-sm text-slate-400">Payload could not be parsed cleanly.</p>
                    )}
                  </div>

                  <div className="rounded border border-slate-800 bg-slate-950/40 p-3">
                    <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Result</p>
                    {result.kind === "funding" && (
                      <div className="mt-3 space-y-1 text-sm text-slate-300">
                        <p>Funding txs: {result.fundingCount}</p>
                        <p>Failures: {fundingFailures}</p>
                      </div>
                    )}
                    {result.kind === "trade" && (
                      <div className="mt-3 space-y-1 text-sm text-slate-300">
                        <p>Trades: {result.tradeCount}</p>
                        <p>Failures: {tradeFailures}</p>
                      </div>
                    )}
                    {result.kind === "unknown" && (
                      <p className="mt-3 text-sm text-slate-400">
                        {operation.resultJson ? "No structured result available yet." : "Operation has not produced a result yet."}
                      </p>
                    )}
                    {operation.errorMessage && (
                      <p className="mt-3 text-sm text-rose-400">{operation.errorMessage}</p>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function AutonomyPanel({ fleets }: { fleets: FleetInfo[] }) {
  const { status, isBusy, isLoading, error, start, stop, tick, refresh } = useAutonomy();

  const clusterLabels = useMemo(() => {
    if (!status) return [];
    return status.config.clusterIds.map((clusterId) => {
      const fleet = fleets.find((entry) => entry.clusterId === clusterId);
      return fleet ? `${fleet.name} (#${clusterId})` : `Cluster #${clusterId}`;
    });
  }, [fleets, status]);

  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-slate-700 bg-slate-900 p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h3 className="text-sm font-semibold text-slate-100">Autonomy Control</h3>
            <p className="mt-1 text-xs text-slate-500">
              Runtime loop controls plus the current read-only server config snapshot.
            </p>
          </div>
          <div className="flex items-center gap-2 text-sm">
            <span className={`h-2.5 w-2.5 rounded-full ${status?.running ? "bg-emerald-500" : "bg-slate-600"}`} />
            <span className="text-slate-300">
              {status?.running ? "Running" : "Stopped"}
              {status?.running ? ` · ${status.intervalSec}s` : ""}
            </span>
          </div>
        </div>

        <div className="mt-4 flex flex-wrap gap-2">
          {status?.running ? (
            <button
              onClick={() => void stop()}
              disabled={isBusy}
              className="rounded bg-rose-700 px-3 py-2 text-sm font-medium text-white hover:bg-rose-600 disabled:opacity-50"
            >
              Stop
            </button>
          ) : (
            <button
              onClick={() => void start()}
              disabled={isBusy}
              className="rounded bg-emerald-700 px-3 py-2 text-sm font-medium text-white hover:bg-emerald-600 disabled:opacity-50"
            >
              Start
            </button>
          )}
          <button
            onClick={() => void tick()}
            disabled={isBusy || status?.isTicking}
            className="rounded bg-slate-700 px-3 py-2 text-sm font-medium text-slate-100 hover:bg-slate-600 disabled:opacity-50"
          >
            {status?.isTicking ? "Ticking…" : "Tick now"}
          </button>
          <button
            onClick={() => void refresh()}
            disabled={isBusy || isLoading}
            className="rounded bg-slate-800 px-3 py-2 text-sm text-slate-200 hover:bg-slate-700 disabled:opacity-50"
          >
            Refresh
          </button>
        </div>

        {error && <p className="mt-4 text-sm text-rose-400">{error}</p>}
      </div>

      {status && (
        <div className="grid gap-4 xl:grid-cols-[1.1fr,1fr]">
          <div className="rounded-lg border border-slate-700 bg-slate-900 p-4">
            <h3 className="text-sm font-semibold text-slate-100">Config Snapshot</h3>
            <div className="mt-4 grid gap-3 sm:grid-cols-2">
              <div className="rounded border border-slate-800 bg-slate-950/40 p-3">
                <p className="text-xs text-slate-500">Managed fleets</p>
                <p className="mt-1 text-sm text-slate-100">
                  {clusterLabels.length > 0 ? clusterLabels.join(", ") : "None configured"}
                </p>
              </div>
              <div className="rounded border border-slate-800 bg-slate-950/40 p-3">
                <p className="text-xs text-slate-500">Signal mode</p>
                <p className="mt-1 text-sm text-slate-100">{status.config.signalMode}</p>
              </div>
              <div className="rounded border border-slate-800 bg-slate-950/40 p-3">
                <p className="text-xs text-slate-500">Watchlist</p>
                <p className="mt-1 text-sm text-slate-100">{status.config.watchlistName ?? "—"}</p>
              </div>
              <div className="rounded border border-slate-800 bg-slate-950/40 p-3">
                <p className="text-xs text-slate-500">Minimum momentum</p>
                <p className="mt-1 text-sm text-slate-100">{status.config.minMomentum ?? "—"}</p>
              </div>
              <div className="rounded border border-slate-800 bg-slate-950/40 p-3">
                <p className="text-xs text-slate-500">Trade amount</p>
                <p className="mt-1 text-sm text-slate-100">{fmtEth(status.config.totalAmountWei, 6)} ETH</p>
              </div>
              <div className="rounded border border-slate-800 bg-slate-950/40 p-3">
                <p className="text-xs text-slate-500">Slippage</p>
                <p className="mt-1 text-sm text-slate-100">{status.config.slippageBps} bps</p>
              </div>
              <div className="rounded border border-slate-800 bg-slate-950/40 p-3">
                <p className="text-xs text-slate-500">Strategy override</p>
                <p className="mt-1 text-sm text-slate-100">{status.config.strategyMode ?? "Use fleet default"}</p>
              </div>
              <div className="rounded border border-slate-800 bg-slate-950/40 p-3">
                <p className="text-xs text-slate-500">Requester tag</p>
                <p className="mt-1 text-sm text-slate-100">{status.config.requestedBy}</p>
              </div>
              <div className="rounded border border-slate-800 bg-slate-950/40 p-3">
                <p className="text-xs text-slate-500">Create requests</p>
                <p className="mt-1 text-sm text-slate-100">{status.config.createRequests ? "Enabled" : "Disabled"}</p>
              </div>
              <div className="rounded border border-slate-800 bg-slate-950/40 p-3">
                <p className="text-xs text-slate-500">Auto-approve pending</p>
                <p className="mt-1 text-sm text-slate-100">{status.config.autoApprovePending ? "Enabled" : "Disabled"}</p>
              </div>
              <div className="rounded border border-slate-800 bg-slate-950/40 p-3">
                <p className="text-xs text-slate-500">Pump / dip thresholds</p>
                <p className="mt-1 text-sm text-slate-100">
                  {status.config.pumpThreshold} / {status.config.dipThreshold}
                </p>
              </div>
              <div className="rounded border border-slate-800 bg-slate-950/40 p-3">
                <p className="text-xs text-slate-500">Own activity discount</p>
                <p className="mt-1 text-sm text-slate-100">{status.config.ownDiscountEnabled ? "Enabled" : "Disabled"}</p>
              </div>
            </div>
          </div>

          <div className="rounded-lg border border-slate-700 bg-slate-900 p-4">
            <h3 className="text-sm font-semibold text-slate-100">Last Tick</h3>
            {!status.lastTick ? (
              <p className="mt-4 text-sm text-slate-400">No autonomy tick has completed yet.</p>
            ) : (
              <div className="mt-4 space-y-4">
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="rounded border border-slate-800 bg-slate-950/40 p-3">
                    <p className="text-xs text-slate-500">Finished</p>
                    <p className="mt-1 text-sm text-slate-100">{relTime(status.lastTick.finishedAt)}</p>
                  </div>
                  <div className="rounded border border-slate-800 bg-slate-950/40 p-3">
                    <p className="text-xs text-slate-500">Created / executed</p>
                    <p className="mt-1 text-sm text-slate-100">
                      {status.lastTick.createdOperationIds.length} / {status.lastTick.executedOperationIds.length}
                    </p>
                  </div>
                </div>

                <div className="rounded border border-slate-800 bg-slate-950/40 p-3">
                  <p className="text-xs text-slate-500">Created operation IDs</p>
                  <p className="mt-1 text-sm text-slate-100">
                    {status.lastTick.createdOperationIds.length > 0
                      ? status.lastTick.createdOperationIds.join(", ")
                      : "None"}
                  </p>
                </div>

                <div className="rounded border border-slate-800 bg-slate-950/40 p-3">
                  <p className="text-xs text-slate-500">Executed operation IDs</p>
                  <p className="mt-1 text-sm text-slate-100">
                    {status.lastTick.executedOperationIds.length > 0
                      ? status.lastTick.executedOperationIds.join(", ")
                      : "None"}
                  </p>
                </div>

                <div className="rounded border border-slate-800 bg-slate-950/40 p-3">
                  <p className="text-xs text-slate-500">Skipped reasons</p>
                  {status.lastTick.skipped.length === 0 ? (
                    <p className="mt-1 text-sm text-slate-100">None</p>
                  ) : (
                    <ul className="mt-2 space-y-1 text-sm text-slate-300">
                      {status.lastTick.skipped.map((entry, index) => (
                        <li key={`${entry.reason}-${index}`}>
                          {entry.operationId ? `#${entry.operationId} · ` : ""}
                          {entry.reason}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>

                <div className="rounded border border-slate-800 bg-slate-950/40 p-3">
                  <p className="text-xs text-slate-500">Errors</p>
                  {status.lastTick.errors.length === 0 ? (
                    <p className="mt-1 text-sm text-slate-100">None</p>
                  ) : (
                    <ul className="mt-2 space-y-1 text-sm text-rose-400">
                      {status.lastTick.errors.map((entry, index) => (
                        <li key={`${entry}-${index}`}>{entry}</li>
                      ))}
                    </ul>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export function AutomationTab({ fleets }: { fleets: FleetInfo[] }) {
  const [activeView, setActiveView] = useState<AutomationSubview>("signals");

  const tabs: Array<{ id: AutomationSubview; label: string }> = [
    { id: "signals", label: "Signals" },
    { id: "queue", label: "Queue" },
    { id: "autonomy", label: "Autonomy" },
  ];

  return (
    <div className="space-y-4">
      <div className="flex gap-1">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveView(tab.id)}
            className={`rounded px-3 py-1.5 text-xs font-medium transition-colors ${
              activeView === tab.id
                ? "bg-slate-700 text-slate-100"
                : "text-slate-400 hover:text-slate-200"
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {activeView === "signals" && <SignalsPanel fleets={fleets} />}
      {activeView === "queue" && <QueuePanel fleets={fleets} />}
      {activeView === "autonomy" && <AutonomyPanel fleets={fleets} />}
    </div>
  );
}
