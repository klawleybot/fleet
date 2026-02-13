import { useMemo, useState } from "react";
import { FundingPanel } from "./components/FundingPanel";
import { SwapWidget } from "./components/SwapWidget";
import { WalletDashboard } from "./components/WalletDashboard";
import { useTrades } from "./hooks/useTrades";
import { useWallets } from "./hooks/useWallets";
import type { FundingRecord } from "./types";

export default function App() {
  const { wallets, isLoading, error: walletError, createFleet, refresh, masterWallet } = useWallets();
  const { tradeHistory, fundingHistory, isSubmitting, error: tradeError, refreshHistory, runSwap } =
    useTrades();
  const [selectedWalletIds, setSelectedWalletIds] = useState<number[]>([]);

  const latestTrade = useMemo(() => tradeHistory[0] ?? null, [tradeHistory]);
  const latestFunding = useMemo(() => fundingHistory[0] ?? null, [fundingHistory]);

  const handleFundingComplete = (_records: FundingRecord[]) => {
    void refreshHistory();
    void refresh();
  };

  return (
    <main className="min-h-screen bg-slate-950 px-4 py-6 text-slate-100">
      <div className="mx-auto flex max-w-7xl flex-col gap-4">
        <header className="space-y-1">
          <h1 className="text-2xl font-bold">Pump It Up - Smart Account Fleet</h1>
          <p className="text-sm text-slate-300">
            Local control plane for Base smart wallets: create, fund, and execute swaps in unison.
          </p>
        </header>

        {walletError ? <p className="rounded bg-rose-900/60 p-2 text-sm">{walletError}</p> : null}
        {tradeError ? <p className="rounded bg-rose-900/60 p-2 text-sm">{tradeError}</p> : null}

        <WalletDashboard
          wallets={wallets}
          onSelectionChange={setSelectedWalletIds}
          onCreateFleet={createFleet}
          isBusy={isLoading}
        />

        <div className="grid gap-4 lg:grid-cols-2">
          <FundingPanel
            masterWallet={masterWallet}
            selectedWalletIds={selectedWalletIds}
            onFundingComplete={handleFundingComplete}
          />
          <SwapWidget
            selectedWalletIds={selectedWalletIds}
            onSwap={runSwap}
            isSubmitting={isSubmitting}
          />
        </div>

        <section className="grid gap-4 lg:grid-cols-2">
          <article className="rounded-lg border border-slate-700 bg-slate-900 p-4">
            <h2 className="text-lg font-semibold">Latest Funding</h2>
            {latestFunding ? (
              <div className="mt-2 space-y-1 text-sm text-slate-200">
                <p>Record #{latestFunding.id}</p>
                <p>Status: {latestFunding.status}</p>
                <p>Amount (wei): {latestFunding.amountWei}</p>
                <p>UserOp: {latestFunding.userOpHash ?? "n/a"}</p>
                <p>Tx: {latestFunding.txHash ?? "n/a"}</p>
              </div>
            ) : (
              <p className="mt-2 text-sm text-slate-400">No funding events yet.</p>
            )}
          </article>

          <article className="rounded-lg border border-slate-700 bg-slate-900 p-4">
            <h2 className="text-lg font-semibold">Latest Trade</h2>
            {latestTrade ? (
              <div className="mt-2 space-y-1 text-sm text-slate-200">
                <p>Record #{latestTrade.id}</p>
                <p>Status: {latestTrade.status}</p>
                <p>From: {latestTrade.fromToken}</p>
                <p>To: {latestTrade.toToken}</p>
                <p>Amount (wei): {latestTrade.amountIn}</p>
                <p>UserOp: {latestTrade.userOpHash ?? "n/a"}</p>
                <p>Tx: {latestTrade.txHash ?? "n/a"}</p>
              </div>
            ) : (
              <p className="mt-2 text-sm text-slate-400">No trades yet.</p>
            )}
          </article>
        </section>
      </div>
    </main>
  );
}

