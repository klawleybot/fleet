import { useMemo, useState } from "react";
import { usePositions } from "../hooks/usePositions";
import { fmtEth, fmtPnl, pnlColor, shortAddr, baseScanAddr, relTime } from "../lib/format";
import type { PositionRecord } from "../types";

type SortKey = "pnl" | "cost" | "lastAction";
type SortDir = "asc" | "desc";

function PositionRow({ pos }: { pos: PositionRecord }) {
  const hasHoldings = BigInt(pos.holdingsRaw) > 0n;
  return (
    <tr className="border-t border-slate-800 hover:bg-slate-800/40">
      <td className="py-2 pr-3 text-xs text-slate-400">{pos.walletId}</td>
      <td className="py-2 pr-3 font-mono text-xs">
        <a
          href={baseScanAddr(pos.coinAddress)}
          target="_blank"
          rel="noreferrer"
          className="text-slate-300 hover:text-slate-100 hover:underline"
        >
          {shortAddr(pos.coinAddress)}
        </a>
      </td>
      <td className="py-2 pr-3 text-right text-xs text-slate-300">
        {fmtEth(pos.totalCostWei, 5)} ETH
      </td>
      <td className="py-2 pr-3 text-right text-xs text-slate-300">
        {fmtEth(pos.totalReceivedWei, 5)} ETH
      </td>
      <td className={`py-2 pr-3 text-right text-xs ${pnlColor(pos.realizedPnlWei)}`}>
        {fmtPnl(pos.realizedPnlWei)} ETH
      </td>
      <td className="py-2 pr-3 text-center text-xs text-slate-400">
        {pos.buyCount}/{pos.sellCount}
      </td>
      <td className="py-2 text-right text-xs text-slate-500">{relTime(pos.lastActionAt)}</td>
      <td className="py-2 pl-3 text-right text-xs">
        <span
          className={`rounded px-1.5 py-0.5 text-xs ${
            hasHoldings ? "bg-amber-900/40 text-amber-400" : "bg-slate-800 text-slate-500"
          }`}
        >
          {hasHoldings ? "open" : "closed"}
        </span>
      </td>
    </tr>
  );
}

export function PositionsTab() {
  const { positions, isLoading, error, refresh } = usePositions();
  const [sortKey, setSortKey] = useState<SortKey>("lastAction");
  const [sortDir, setSortDir] = useState<SortDir>("desc");
  const [showClosed, setShowClosed] = useState(false);

  const sorted = useMemo(() => {
    let list = showClosed ? positions : positions.filter((p) => BigInt(p.holdingsRaw) > 0n);

    list = [...list].sort((a, b) => {
      let cmp = 0;
      if (sortKey === "pnl") {
        cmp = Number(BigInt(a.realizedPnlWei) - BigInt(b.realizedPnlWei));
      } else if (sortKey === "cost") {
        cmp = Number(BigInt(a.totalCostWei) - BigInt(b.totalCostWei));
      } else {
        cmp = new Date(a.lastActionAt).getTime() - new Date(b.lastActionAt).getTime();
      }
      return sortDir === "asc" ? cmp : -cmp;
    });

    return list;
  }, [positions, sortKey, sortDir, showClosed]);

  function toggleSort(key: SortKey) {
    if (sortKey === key) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir("desc");
    }
  }

  const SortHeader = ({
    label,
    sortKeyValue,
  }: {
    label: string;
    sortKeyValue: SortKey;
  }) => (
    <th
      className="cursor-pointer select-none pb-1 pr-3 text-right text-xs font-medium text-slate-500 hover:text-slate-300"
      onClick={() => toggleSort(sortKeyValue)}
    >
      {label} {sortKey === sortKeyValue ? (sortDir === "asc" ? "↑" : "↓") : ""}
    </th>
  );

  if (isLoading && positions.length === 0) {
    return <p className="text-sm text-slate-400">Loading positions…</p>;
  }

  if (error && positions.length === 0) {
    return (
      <div className="rounded bg-rose-900/40 p-3 text-sm text-rose-300">
        <p>{error}</p>
        <button onClick={() => void refresh()} className="mt-2 text-xs hover:underline">
          Retry
        </button>
      </div>
    );
  }

  const openCount = positions.filter((p) => BigInt(p.holdingsRaw) > 0n).length;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-300">
          {positions.length} position(s) · {openCount} open
        </h2>
        <div className="flex items-center gap-3">
          <label className="flex cursor-pointer items-center gap-1.5 text-xs text-slate-400">
            <input
              type="checkbox"
              checked={showClosed}
              onChange={(e) => setShowClosed(e.target.checked)}
              className="rounded"
            />
            Show closed
          </label>
          <button onClick={() => void refresh()} className="text-xs text-slate-500 hover:text-slate-300">
            Refresh
          </button>
        </div>
      </div>

      {sorted.length === 0 ? (
        <p className="text-sm text-slate-400">No {showClosed ? "" : "open "}positions.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left">
                <th className="pb-1 pr-3 text-xs font-medium text-slate-500">Wallet</th>
                <th className="pb-1 pr-3 text-xs font-medium text-slate-500">Coin</th>
                <SortHeader label="Cost" sortKeyValue="cost" />
                <th className="pb-1 pr-3 text-right text-xs font-medium text-slate-500">
                  Received
                </th>
                <SortHeader label="P&L" sortKeyValue="pnl" />
                <th className="pb-1 pr-3 text-center text-xs font-medium text-slate-500">
                  Buys/Sells
                </th>
                <SortHeader label="Last action" sortKeyValue="lastAction" />
                <th className="pb-1 pl-3 text-right text-xs font-medium text-slate-500">
                  Status
                </th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((pos) => (
                <PositionRow key={pos.id} pos={pos} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
