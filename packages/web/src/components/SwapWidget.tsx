import { useMemo, useState } from "react";

interface SwapWidgetProps {
  selectedWalletIds: number[];
  onSwap: (input: {
    walletIds: number[];
    fromToken: `0x${string}`;
    toToken: `0x${string}`;
    amountInWei: string;
    slippageBps: number;
  }) => Promise<void>;
  isSubmitting: boolean;
}

const WETH_BASE = "0x4200000000000000000000000000000000000006" as const;

export function SwapWidget({
  selectedWalletIds,
  onSwap,
  isSubmitting,
}: SwapWidgetProps) {
  const [fromToken, setFromToken] = useState<`0x${string}`>(WETH_BASE);
  const [toToken, setToToken] = useState<`0x${string}`>(WETH_BASE);
  const [amountInWei, setAmountInWei] = useState<string>("1000000000000000");
  const [slippageBps, setSlippageBps] = useState<number>(100);

  const canSubmit = useMemo(
    () =>
      selectedWalletIds.length > 0 &&
      amountInWei.length > 0 &&
      fromToken.length > 0 &&
      toToken.length > 0 &&
      !isSubmitting,
    [amountInWei.length, fromToken.length, isSubmitting, selectedWalletIds.length, toToken.length],
  );

  return (
    <section className="space-y-3 rounded-lg border border-slate-700 bg-slate-900 p-4">
      <h2 className="text-lg font-semibold text-slate-100">Coordinated Swap</h2>
      <p className="text-sm text-slate-300">
        Run the same swap across all selected smart accounts.
      </p>

      <label className="block text-sm text-slate-200">
        From token
        <input
          className="mt-1 w-full rounded border border-slate-600 bg-slate-950 px-2 py-1 text-slate-100"
          value={fromToken}
          onChange={(event) => setFromToken(event.target.value as `0x${string}`)}
        />
      </label>

      <label className="block text-sm text-slate-200">
        To token
        <input
          className="mt-1 w-full rounded border border-slate-600 bg-slate-950 px-2 py-1 text-slate-100"
          value={toToken}
          onChange={(event) => setToToken(event.target.value as `0x${string}`)}
        />
      </label>

      <label className="block text-sm text-slate-200">
        Amount in (wei)
        <input
          className="mt-1 w-full rounded border border-slate-600 bg-slate-950 px-2 py-1 text-slate-100"
          value={amountInWei}
          onChange={(event) => setAmountInWei(event.target.value)}
        />
      </label>

      <label className="block text-sm text-slate-200">
        Slippage (bps)
        <input
          type="number"
          className="mt-1 w-full rounded border border-slate-600 bg-slate-950 px-2 py-1 text-slate-100"
          value={slippageBps}
          onChange={(event) => setSlippageBps(Number(event.target.value))}
        />
      </label>

      <button
        type="button"
        disabled={!canSubmit}
        onClick={() =>
          void onSwap({
            walletIds: selectedWalletIds,
            fromToken,
            toToken,
            amountInWei,
            slippageBps,
          })
        }
        className="rounded bg-violet-600 px-3 py-1 text-sm font-medium text-white hover:bg-violet-500 disabled:opacity-60"
      >
        {isSubmitting ? "Submitting..." : "Execute Coordinated Swap"}
      </button>

      <p className="text-xs text-slate-400">Selected wallets: {selectedWalletIds.length}</p>
    </section>
  );
}

