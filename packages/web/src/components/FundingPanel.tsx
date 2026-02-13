import { useMemo, useState } from "react";
import { distributeFunding } from "../api/client";
import type { FundingRecord, Wallet } from "../types";

interface FundingPanelProps {
  masterWallet: Wallet | null;
  selectedWalletIds: number[];
  onFundingComplete: (records: FundingRecord[]) => void;
}

export function FundingPanel({
  masterWallet,
  selectedWalletIds,
  onFundingComplete,
}: FundingPanelProps) {
  const [amountWei, setAmountWei] = useState<string>("1000000000000000");
  const [isSubmitting, setIsSubmitting] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  const canSubmit = useMemo(
    () => selectedWalletIds.length > 0 && amountWei.length > 0 && !isSubmitting,
    [amountWei.length, isSubmitting, selectedWalletIds.length],
  );

  const handleSubmit = async () => {
    setError(null);
    setIsSubmitting(true);
    try {
      const records = await distributeFunding({
        toWalletIds: selectedWalletIds,
        amountWei,
      });
      onFundingComplete(records);
    } catch (requestError) {
      const message =
        requestError instanceof Error ? requestError.message : "Funding request failed";
      setError(message);
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <section className="space-y-3 rounded-lg border border-slate-700 bg-slate-900 p-4">
      <h2 className="text-lg font-semibold text-slate-100">Funding</h2>
      <p className="text-sm text-slate-300">
        Fund this master smart account externally, then distribute from here:
      </p>
      <code className="block overflow-auto rounded bg-slate-950 p-2 text-xs text-slate-200">
        {masterWallet?.address ?? "master wallet is initializing..."}
      </code>
      <label className="block text-sm text-slate-200">
        Amount per selected wallet (wei)
        <input
          className="mt-1 w-full rounded border border-slate-600 bg-slate-950 px-2 py-1 text-slate-100"
          value={amountWei}
          onChange={(event) => setAmountWei(event.target.value)}
        />
      </label>
      <button
        type="button"
        onClick={() => void handleSubmit()}
        disabled={!canSubmit}
        className="rounded bg-emerald-600 px-3 py-1 text-sm font-medium text-white hover:bg-emerald-500 disabled:opacity-60"
      >
        {isSubmitting ? "Distributing..." : "Distribute Funding"}
      </button>
      <p className="text-xs text-slate-400">Selected wallets: {selectedWalletIds.length}</p>
      {error ? <p className="text-sm text-rose-300">{error}</p> : null}
    </section>
  );
}

