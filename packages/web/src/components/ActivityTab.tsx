import { useState } from "react";
import { useActivity } from "../hooks/useActivity";
import { useOperations } from "../hooks/useOperations";
import { fmtEth, shortAddr, baseScanAddr, baseScanTx, relTime } from "../lib/format";
import type { TradeRecord, FundingRecord, OperationRecord } from "../types";

function StatusBadge({ status }: { status: string }) {
  const colors: Record<string, string> = {
    complete: "bg-emerald-900/40 text-emerald-400",
    failed: "bg-rose-900/40 text-rose-400",
    pending: "bg-amber-900/40 text-amber-400",
    approved: "bg-blue-900/40 text-blue-400",
    executing: "bg-purple-900/40 text-purple-400",
  };
  return (
    <span className={`rounded px-1.5 py-0.5 text-xs ${colors[status] ?? "bg-slate-800 text-slate-400"}`}>
      {status}
    </span>
  );
}

function TxLink({ hash }: { hash: `0x${string}` | null | undefined }) {
  if (!hash) return <span className="text-slate-600">—</span>;
  return (
    <a
      href={baseScanTx(hash)}
      target="_blank"
      rel="noreferrer"
      className="font-mono text-xs text-slate-400 hover:text-slate-200 hover:underline"
    >
      {shortAddr(hash)}
    </a>
  );
}

function TradeTable({ trades }: { trades: TradeRecord[] }) {
  if (trades.length === 0) return <p className="text-sm text-slate-400">No trades yet.</p>;

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-xs text-slate-500">
            <th className="pb-1 pr-3 font-medium">ID</th>
            <th className="pb-1 pr-3 font-medium">Wallet</th>
            <th className="pb-1 pr-3 font-medium">From</th>
            <th className="pb-1 pr-3 font-medium">To</th>
            <th className="pb-1 pr-3 text-right font-medium">Amount In</th>
            <th className="pb-1 pr-3 font-medium">Status</th>
            <th className="pb-1 pr-3 font-medium">Tx</th>
            <th className="pb-1 text-right font-medium">Age</th>
          </tr>
        </thead>
        <tbody>
          {trades.slice(0, 100).map((t) => (
            <tr key={t.id} className="border-t border-slate-800 hover:bg-slate-800/30">
              <td className="py-1.5 pr-3 text-xs text-slate-500">#{t.id}</td>
              <td className="py-1.5 pr-3 text-xs text-slate-400">{t.walletId}</td>
              <td className="py-1.5 pr-3 font-mono text-xs">
                <a
                  href={baseScanAddr(t.fromToken)}
                  target="_blank"
                  rel="noreferrer"
                  className="text-slate-300 hover:underline"
                >
                  {shortAddr(t.fromToken)}
                </a>
              </td>
              <td className="py-1.5 pr-3 font-mono text-xs">
                <a
                  href={baseScanAddr(t.toToken)}
                  target="_blank"
                  rel="noreferrer"
                  className="text-slate-300 hover:underline"
                >
                  {shortAddr(t.toToken)}
                </a>
              </td>
              <td className="py-1.5 pr-3 text-right text-xs text-slate-300">
                {fmtEth(t.amountIn, 5)} ETH
              </td>
              <td className="py-1.5 pr-3">
                <StatusBadge status={t.status} />
              </td>
              <td className="py-1.5 pr-3">
                <TxLink hash={t.txHash} />
              </td>
              <td className="py-1.5 text-right text-xs text-slate-500">{relTime(t.createdAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function FundingTable({ records }: { records: FundingRecord[] }) {
  if (records.length === 0) return <p className="text-sm text-slate-400">No funding events yet.</p>;

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-xs text-slate-500">
            <th className="pb-1 pr-3 font-medium">ID</th>
            <th className="pb-1 pr-3 font-medium">From</th>
            <th className="pb-1 pr-3 font-medium">To</th>
            <th className="pb-1 pr-3 text-right font-medium">Amount</th>
            <th className="pb-1 pr-3 font-medium">Status</th>
            <th className="pb-1 pr-3 font-medium">Tx</th>
            <th className="pb-1 text-right font-medium">Age</th>
          </tr>
        </thead>
        <tbody>
          {records.slice(0, 100).map((f) => (
            <tr key={f.id} className="border-t border-slate-800 hover:bg-slate-800/30">
              <td className="py-1.5 pr-3 text-xs text-slate-500">#{f.id}</td>
              <td className="py-1.5 pr-3 text-xs text-slate-400">{f.fromWalletId}</td>
              <td className="py-1.5 pr-3 text-xs text-slate-400">{f.toWalletId}</td>
              <td className="py-1.5 pr-3 text-right text-xs text-slate-300">
                {fmtEth(f.amountWei, 6)} ETH
              </td>
              <td className="py-1.5 pr-3">
                <StatusBadge status={f.status} />
              </td>
              <td className="py-1.5 pr-3">
                <TxLink hash={f.txHash} />
              </td>
              <td className="py-1.5 text-right text-xs text-slate-500">{relTime(f.createdAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function OperationsTable({ ops }: { ops: OperationRecord[] }) {
  if (ops.length === 0) return <p className="text-sm text-slate-400">No operations yet.</p>;

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-xs text-slate-500">
            <th className="pb-1 pr-3 font-medium">ID</th>
            <th className="pb-1 pr-3 font-medium">Type</th>
            <th className="pb-1 pr-3 font-medium">Cluster</th>
            <th className="pb-1 pr-3 font-medium">Status</th>
            <th className="pb-1 pr-3 font-medium">Requested by</th>
            <th className="pb-1 text-right font-medium">Age</th>
          </tr>
        </thead>
        <tbody>
          {ops.slice(0, 100).map((op) => (
            <tr key={op.id} className="border-t border-slate-800 hover:bg-slate-800/30">
              <td className="py-1.5 pr-3 text-xs text-slate-500">#{op.id}</td>
              <td className="py-1.5 pr-3 text-xs text-slate-300">{op.type}</td>
              <td className="py-1.5 pr-3 text-xs text-slate-400">{op.clusterId}</td>
              <td className="py-1.5 pr-3">
                <StatusBadge status={op.status} />
              </td>
              <td className="py-1.5 pr-3 text-xs text-slate-400">{op.requestedBy}</td>
              <td className="py-1.5 text-right text-xs text-slate-500">
                {relTime(op.createdAt)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

type Tab = "operations" | "trades" | "funding";

export function ActivityTab() {
  const { trades, funding, isLoading: activityLoading, error: activityError, refresh: refreshActivity } = useActivity();
  const { operations, isLoading: opsLoading, error: opsError, refresh: refreshOps } = useOperations();
  const [activeTab, setActiveTab] = useState<Tab>("operations");

  const isLoading = activityLoading || opsLoading;
  const error = activityError ?? opsError;

  const tabs: { id: Tab; label: string; count: number }[] = [
    { id: "operations", label: "Operations", count: operations.length },
    { id: "trades", label: "Trades", count: trades.length },
    { id: "funding", label: "Funding", count: funding.length },
  ];

  function refresh() {
    void refreshActivity();
    void refreshOps();
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
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
              <span className="ml-1.5 rounded-full bg-slate-800 px-1.5 py-0.5 text-xs text-slate-400">
                {t.count}
              </span>
            </button>
          ))}
        </div>
        <button
          onClick={refresh}
          disabled={isLoading}
          className="text-xs text-slate-500 hover:text-slate-300 disabled:opacity-50"
        >
          Refresh
        </button>
      </div>

      {error && <p className="text-xs text-rose-400">{error}</p>}

      {activeTab === "operations" && <OperationsTable ops={operations} />}
      {activeTab === "trades" && <TradeTable trades={trades} />}
      {activeTab === "funding" && <FundingTable records={funding} />}
    </div>
  );
}

