import { useMemo, useState } from "react";
import type { Wallet } from "../types";
import { WalletCard } from "./WalletCard";

interface WalletDashboardProps {
  wallets: Wallet[];
  onSelectionChange: (ids: number[]) => void;
  onCreateFleet: (count: number) => Promise<void>;
  isBusy: boolean;
}

export function WalletDashboard({
  wallets,
  onSelectionChange,
  onCreateFleet,
  isBusy,
}: WalletDashboardProps) {
  const [fleetCount, setFleetCount] = useState<number>(5);
  const [selectedIds, setSelectedIds] = useState<number[]>([]);

  const selectableWallets = useMemo(
    () => wallets.filter((wallet) => !wallet.isMaster),
    [wallets],
  );

  const handleToggle = (walletId: number, selected: boolean) => {
    const next = selected
      ? [...selectedIds, walletId]
      : selectedIds.filter((id) => id !== walletId);
    setSelectedIds(next);
    onSelectionChange(next);
  };

  const selectAll = () => {
    const all = selectableWallets.map((wallet) => wallet.id);
    setSelectedIds(all);
    onSelectionChange(all);
  };

  const clearSelection = () => {
    setSelectedIds([]);
    onSelectionChange([]);
  };

  return (
    <section className="space-y-4 rounded-lg border border-slate-700 bg-slate-900 p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-lg font-semibold text-slate-100">Wallet Fleet</h2>
        <div className="flex items-center gap-2">
          <input
            type="number"
            min={1}
            max={500}
            value={fleetCount}
            onChange={(event) => setFleetCount(Number(event.target.value))}
            className="w-28 rounded border border-slate-600 bg-slate-950 px-2 py-1 text-sm text-slate-100"
          />
          <button
            type="button"
            onClick={() => void onCreateFleet(fleetCount)}
            disabled={isBusy}
            className="rounded bg-indigo-600 px-3 py-1 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-60"
          >
            Create Fleet
          </button>
        </div>
      </div>

      <div className="flex gap-2">
        <button
          type="button"
          className="rounded border border-slate-600 px-3 py-1 text-sm text-slate-100 hover:bg-slate-800"
          onClick={selectAll}
        >
          Select All
        </button>
        <button
          type="button"
          className="rounded border border-slate-600 px-3 py-1 text-sm text-slate-100 hover:bg-slate-800"
          onClick={clearSelection}
        >
          Clear Selection
        </button>
        <p className="ml-auto text-sm text-slate-400">
          Selected: {selectedIds.length} / {selectableWallets.length}
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {wallets.map((wallet) => (
          <WalletCard
            key={wallet.id}
            wallet={wallet}
            isSelected={selectedIds.includes(wallet.id)}
            onToggle={handleToggle}
          />
        ))}
      </div>
    </section>
  );
}

