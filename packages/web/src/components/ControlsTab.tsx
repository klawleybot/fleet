import { useState, useEffect } from "react";
import {
  fetchWallets,
  createFleet,
  deleteWallet,
  distributeFunding,
  executeSwap,
  buyFleetCoin,
  sellFleetCoin,
  importPosition,
} from "../api/client";
import { fmtEth, shortAddr, baseScanAddr } from "../lib/format";
import type { Wallet } from "../types";

// ============================================================
// Wallet list (select + delete)
// ============================================================

function WalletList({
  wallets,
  selected,
  onToggle,
  onDelete,
}: {
  wallets: Wallet[];
  selected: Set<number>;
  onToggle: (id: number) => void;
  onDelete: (id: number) => void;
}) {
  const nonMaster = wallets.filter((w) => !w.isMaster);
  return (
    <div className="max-h-52 overflow-y-auto rounded border border-slate-700 bg-slate-800/50">
      {nonMaster.length === 0 ? (
        <p className="p-3 text-xs text-slate-400">No wallets found. Create a fleet below.</p>
      ) : (
        nonMaster.map((w) => (
          <div
            key={w.id}
            className="flex items-center gap-2 px-3 py-1.5 hover:bg-slate-700/40"
          >
            <input
              type="checkbox"
              checked={selected.has(w.id)}
              onChange={() => onToggle(w.id)}
              className="shrink-0 rounded"
            />
            <span className="min-w-0 flex-1 truncate text-xs text-slate-300">{w.name}</span>
            <a
              href={baseScanAddr(w.address)}
              target="_blank"
              rel="noreferrer"
              className="shrink-0 font-mono text-xs text-slate-500 hover:text-slate-300 hover:underline"
            >
              {shortAddr(w.address)}
            </a>
            <button
              onClick={() => onDelete(w.id)}
              title="Remove wallet from tracking"
              className="shrink-0 text-slate-600 hover:text-rose-400"
            >
              ✕
            </button>
          </div>
        ))
      )}
    </div>
  );
}

// ============================================================
// Create fleet panel
// ============================================================

function CreateFleetPanel({ onCreated }: { onCreated: () => void }) {
  const [name, setName] = useState("");
  const [count, setCount] = useState(5);
  const [isBusy, setIsBusy] = useState(false);
  const [message, setMessage] = useState<{ type: "ok" | "err"; text: string } | null>(null);

  async function handleCreate() {
    const trimmed = name.trim();
    if (!trimmed) {
      setMessage({ type: "err", text: "Fleet name is required." });
      return;
    }
    setIsBusy(true);
    setMessage(null);
    try {
      await createFleet({ name: trimmed, wallets: count });
      setMessage({ type: "ok", text: `Fleet "${trimmed}" created with ${count} wallet(s).` });
      setName("");
      onCreated();
    } catch (err) {
      setMessage({ type: "err", text: err instanceof Error ? err.message : "Failed" });
    } finally {
      setIsBusy(false);
    }
  }

  return (
    <div className="rounded-lg border border-slate-700 bg-slate-900 p-4">
      <h3 className="mb-3 text-sm font-semibold text-slate-200">Create Fleet</h3>
      <div className="flex flex-wrap items-center gap-2">
        <input
          type="text"
          placeholder="Fleet name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && void handleCreate()}
          className="flex-1 rounded border border-slate-600 bg-slate-800 px-2 py-1 text-xs text-slate-200 placeholder-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500"
        />
        <label className="flex items-center gap-1 text-xs text-slate-400">
          Wallets
          <input
            type="number"
            min={1}
            max={50}
            value={count}
            onChange={(e) => setCount(Number(e.target.value))}
            className="ml-1 w-16 rounded border border-slate-600 bg-slate-800 px-2 py-1 text-xs text-slate-200 focus:outline-none focus:ring-1 focus:ring-slate-500"
          />
        </label>
        <button
          onClick={() => void handleCreate()}
          disabled={isBusy}
          className="rounded bg-slate-700 px-3 py-1 text-xs font-medium hover:bg-slate-600 disabled:opacity-50"
        >
          {isBusy ? "Creating…" : "Create"}
        </button>
      </div>
      {message && (
        <p className={`mt-2 text-xs ${message.type === "ok" ? "text-emerald-400" : "text-rose-400"}`}>
          {message.text}
        </p>
      )}
    </div>
  );
}

// ============================================================
// Fund panel
// ============================================================

function FundPanel({
  masterWallet,
  selected,
}: {
  masterWallet: Wallet | null;
  selected: Set<number>;
}) {
  const [amountEth, setAmountEth] = useState("0.001");
  const [isBusy, setIsBusy] = useState(false);
  const [message, setMessage] = useState<{ type: "ok" | "err"; text: string } | null>(null);

  async function handleFund() {
    if (selected.size === 0) return;
    const amountWei = String(BigInt(Math.round(parseFloat(amountEth) * 1e18)));
    setIsBusy(true);
    setMessage(null);
    try {
      const records = await distributeFunding({ toWalletIds: Array.from(selected), amountWei });
      setMessage({ type: "ok", text: `Queued ${records.length} funding tx(s).` });
    } catch (err) {
      setMessage({ type: "err", text: err instanceof Error ? err.message : "Failed" });
    } finally {
      setIsBusy(false);
    }
  }

  return (
    <div className="rounded-lg border border-slate-700 bg-slate-900 p-4">
      <h3 className="mb-1 text-sm font-semibold text-slate-200">Fund Selected Wallets</h3>
      {masterWallet && (
        <p className="mb-3 text-xs text-slate-400">
          From master:{" "}
          <a
            href={baseScanAddr(masterWallet.address)}
            target="_blank"
            rel="noreferrer"
            className="font-mono hover:text-slate-200 hover:underline"
          >
            {shortAddr(masterWallet.address)}
          </a>
        </p>
      )}
      <div className="flex items-center gap-2">
        <label className="text-xs text-slate-400">ETH each</label>
        <input
          type="number"
          step="0.001"
          min="0"
          value={amountEth}
          onChange={(e) => setAmountEth(e.target.value)}
          className="w-28 rounded border border-slate-600 bg-slate-800 px-2 py-1 text-xs text-slate-200 focus:outline-none focus:ring-1 focus:ring-slate-500"
        />
        <button
          onClick={() => void handleFund()}
          disabled={isBusy || selected.size === 0}
          className="rounded bg-blue-700 px-3 py-1 text-xs font-medium hover:bg-blue-600 disabled:opacity-50"
        >
          {isBusy ? "Sending…" : `Fund ${selected.size} wallet(s)`}
        </button>
      </div>
      {message && (
        <p className={`mt-2 text-xs ${message.type === "ok" ? "text-emerald-400" : "text-rose-400"}`}>
          {message.text}
        </p>
      )}
    </div>
  );
}

// ============================================================
// Swap panel
// ============================================================

const WETH = "0x4200000000000000000000000000000000000006" as `0x${string}`;

function SwapPanel({ selected }: { selected: Set<number> }) {
  const [fromToken, setFromToken] = useState<string>(WETH);
  const [toToken, setToToken] = useState<string>("");
  const [amountEth, setAmountEth] = useState("0.001");
  const [slippageBps, setSlippageBps] = useState(300);
  const [isBusy, setIsBusy] = useState(false);
  const [message, setMessage] = useState<{ type: "ok" | "err"; text: string } | null>(null);

  async function handleSwap() {
    if (selected.size === 0 || !toToken) return;
    const amountInWei = String(BigInt(Math.round(parseFloat(amountEth) * 1e18)));
    setIsBusy(true);
    setMessage(null);
    try {
      const records = await executeSwap({
        walletIds: Array.from(selected),
        fromToken: fromToken as `0x${string}`,
        toToken: toToken as `0x${string}`,
        amountInWei,
        slippageBps,
      });
      setMessage({ type: "ok", text: `Submitted ${records.length} swap(s).` });
    } catch (err) {
      setMessage({ type: "err", text: err instanceof Error ? err.message : "Failed" });
    } finally {
      setIsBusy(false);
    }
  }

  return (
    <div className="rounded-lg border border-slate-700 bg-slate-900 p-4">
      <h3 className="mb-3 text-sm font-semibold text-slate-200">Coordinated Swap</h3>
      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <label className="w-24 shrink-0 text-xs text-slate-400">From token</label>
          <input
            type="text"
            placeholder="0x… (WETH default)"
            value={fromToken}
            onChange={(e) => setFromToken(e.target.value)}
            className="flex-1 rounded border border-slate-600 bg-slate-800 px-2 py-1 font-mono text-xs text-slate-200 focus:outline-none focus:ring-1 focus:ring-slate-500"
          />
        </div>
        <div className="flex items-center gap-2">
          <label className="w-24 shrink-0 text-xs text-slate-400">To token</label>
          <input
            type="text"
            placeholder="0x…"
            value={toToken}
            onChange={(e) => setToToken(e.target.value)}
            className="flex-1 rounded border border-slate-600 bg-slate-800 px-2 py-1 font-mono text-xs text-slate-200 focus:outline-none focus:ring-1 focus:ring-slate-500"
          />
        </div>
        <div className="flex items-center gap-2">
          <label className="w-24 shrink-0 text-xs text-slate-400">Amount (ETH)</label>
          <input
            type="number"
            step="0.001"
            min="0"
            value={amountEth}
            onChange={(e) => setAmountEth(e.target.value)}
            className="w-28 rounded border border-slate-600 bg-slate-800 px-2 py-1 text-xs text-slate-200 focus:outline-none focus:ring-1 focus:ring-slate-500"
          />
        </div>
        <div className="flex items-center gap-2">
          <label className="w-24 shrink-0 text-xs text-slate-400">Slippage (bps)</label>
          <input
            type="number"
            step="50"
            min="0"
            max="2000"
            value={slippageBps}
            onChange={(e) => setSlippageBps(Number(e.target.value))}
            className="w-20 rounded border border-slate-600 bg-slate-800 px-2 py-1 text-xs text-slate-200 focus:outline-none focus:ring-1 focus:ring-slate-500"
          />
        </div>
        <button
          onClick={() => void handleSwap()}
          disabled={isBusy || selected.size === 0 || !toToken}
          className="mt-1 rounded bg-purple-700 px-3 py-1.5 text-xs font-medium hover:bg-purple-600 disabled:opacity-50"
        >
          {isBusy ? "Executing…" : `Swap on ${selected.size} wallet(s)`}
        </button>
      </div>
      {message && (
        <p className={`mt-2 text-xs ${message.type === "ok" ? "text-emerald-400" : "text-rose-400"}`}>
          {message.text}
        </p>
      )}
    </div>
  );
}

// ============================================================
// Fleet buy/sell panel
// ============================================================

function FleetTradePanel({ fleetNames }: { fleetNames: string[] }) {
  const [fleetName, setFleetName] = useState(fleetNames[0] ?? "");
  const [coinAddress, setCoinAddress] = useState("");
  const [amountEth, setAmountEth] = useState("0.01");
  const [slippageBps, setSlippageBps] = useState(300);
  const [side, setSide] = useState<"buy" | "sell">("buy");
  const [isBusy, setIsBusy] = useState(false);
  const [message, setMessage] = useState<{ type: "ok" | "err"; text: string } | null>(null);

  useEffect(() => {
    if (!fleetName && fleetNames[0]) setFleetName(fleetNames[0]);
  }, [fleetNames, fleetName]);

  async function handleTrade() {
    if (!fleetName || !coinAddress) return;
    const totalAmountWei = String(BigInt(Math.round(parseFloat(amountEth) * 1e18)));
    setIsBusy(true);
    setMessage(null);
    try {
      if (side === "buy") {
        await buyFleetCoin(fleetName, {
          coinAddress: coinAddress as `0x${string}`,
          totalAmountWei,
          slippageBps,
        });
      } else {
        await sellFleetCoin(fleetName, {
          coinAddress: coinAddress as `0x${string}`,
          totalAmountWei,
          slippageBps,
        });
      }
      setMessage({ type: "ok", text: `${side === "buy" ? "Buy" : "Sell"} submitted.` });
    } catch (err) {
      setMessage({ type: "err", text: err instanceof Error ? err.message : "Failed" });
    } finally {
      setIsBusy(false);
    }
  }

  if (fleetNames.length === 0) return null;

  return (
    <div className="rounded-lg border border-slate-700 bg-slate-900 p-4">
      <h3 className="mb-3 text-sm font-semibold text-slate-200">Fleet Buy / Sell</h3>
      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <label className="w-24 shrink-0 text-xs text-slate-400">Fleet</label>
          <select
            value={fleetName}
            onChange={(e) => setFleetName(e.target.value)}
            className="flex-1 rounded border border-slate-600 bg-slate-800 px-2 py-1 text-xs text-slate-200 focus:outline-none focus:ring-1 focus:ring-slate-500"
          >
            {fleetNames.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </div>
        <div className="flex items-center gap-2">
          <label className="w-24 shrink-0 text-xs text-slate-400">Coin</label>
          <input
            type="text"
            placeholder="0x…"
            value={coinAddress}
            onChange={(e) => setCoinAddress(e.target.value)}
            className="flex-1 rounded border border-slate-600 bg-slate-800 px-2 py-1 font-mono text-xs text-slate-200 focus:outline-none focus:ring-1 focus:ring-slate-500"
          />
        </div>
        <div className="flex items-center gap-2">
          <label className="w-24 shrink-0 text-xs text-slate-400">Amount (ETH)</label>
          <input
            type="number"
            step="0.001"
            min="0"
            value={amountEth}
            onChange={(e) => setAmountEth(e.target.value)}
            className="w-28 rounded border border-slate-600 bg-slate-800 px-2 py-1 text-xs text-slate-200 focus:outline-none focus:ring-1 focus:ring-slate-500"
          />
        </div>
        <div className="flex items-center gap-2">
          <label className="w-24 shrink-0 text-xs text-slate-400">Slippage (bps)</label>
          <input
            type="number"
            step="50"
            min="0"
            max="2000"
            value={slippageBps}
            onChange={(e) => setSlippageBps(Number(e.target.value))}
            className="w-20 rounded border border-slate-600 bg-slate-800 px-2 py-1 text-xs text-slate-200 focus:outline-none focus:ring-1 focus:ring-slate-500"
          />
        </div>
        <div className="flex items-center gap-2">
          <label className="w-24 shrink-0 text-xs text-slate-400">Side</label>
          <div className="flex gap-3">
            <label className="flex cursor-pointer items-center gap-1 text-xs text-slate-300">
              <input
                type="radio"
                value="buy"
                checked={side === "buy"}
                onChange={() => setSide("buy")}
              />
              Buy
            </label>
            <label className="flex cursor-pointer items-center gap-1 text-xs text-slate-300">
              <input
                type="radio"
                value="sell"
                checked={side === "sell"}
                onChange={() => setSide("sell")}
              />
              Sell
            </label>
          </div>
        </div>
        <button
          onClick={() => void handleTrade()}
          disabled={isBusy || !fleetName || !coinAddress}
          className={`mt-1 rounded px-3 py-1.5 text-xs font-medium disabled:opacity-50 ${
            side === "buy"
              ? "bg-emerald-700 hover:bg-emerald-600"
              : "bg-rose-700 hover:bg-rose-600"
          }`}
        >
          {isBusy ? "Submitting…" : `${side === "buy" ? "Buy" : "Sell"} on ${fleetName}`}
        </button>
      </div>
      {message && (
        <p className={`mt-2 text-xs ${message.type === "ok" ? "text-emerald-400" : "text-rose-400"}`}>
          {message.text}
        </p>
      )}
    </div>
  );
}

// ============================================================
// Import position panel
// ============================================================

function ImportPositionPanel() {
  const [coinAddress, setCoinAddress] = useState("");
  const [isBusy, setIsBusy] = useState(false);
  const [message, setMessage] = useState<{ type: "ok" | "err"; text: string } | null>(null);

  async function handleImport() {
    const addr = coinAddress.trim();
    if (!addr) return;
    setIsBusy(true);
    setMessage(null);
    try {
      const result = await importPosition(addr);
      const parts: string[] = [];
      if (result.imported.length > 0) parts.push(`${result.imported.length} position(s) imported`);
      if (result.skippedCount > 0) parts.push(`${result.skippedCount} already tracked`);
      if (result.noBalanceCount > 0) parts.push(`${result.noBalanceCount} wallet(s) had no balance`);
      setMessage({ type: "ok", text: parts.join(" · ") || "No new positions found." });
      if (result.imported.length > 0) setCoinAddress("");
    } catch (err) {
      setMessage({ type: "err", text: err instanceof Error ? err.message : "Failed" });
    } finally {
      setIsBusy(false);
    }
  }

  return (
    <div className="rounded-lg border border-slate-700 bg-slate-900 p-4">
      <h3 className="mb-1 text-sm font-semibold text-slate-200">Import Position</h3>
      <p className="mb-3 text-xs text-slate-400">
        Scan all fleet wallets for an existing on-chain token balance and begin tracking it.
      </p>
      <div className="flex items-center gap-2">
        <input
          type="text"
          placeholder="0x… token address"
          value={coinAddress}
          onChange={(e) => setCoinAddress(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && void handleImport()}
          className="flex-1 rounded border border-slate-600 bg-slate-800 px-2 py-1 font-mono text-xs text-slate-200 placeholder-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500"
        />
        <button
          onClick={() => void handleImport()}
          disabled={isBusy || !coinAddress.trim()}
          className="rounded bg-indigo-700 px-3 py-1 text-xs font-medium hover:bg-indigo-600 disabled:opacity-50"
        >
          {isBusy ? "Scanning…" : "Import"}
        </button>
      </div>
      {message && (
        <p className={`mt-2 text-xs ${message.type === "ok" ? "text-emerald-400" : "text-rose-400"}`}>
          {message.text}
        </p>
      )}
    </div>
  );
}

// ============================================================
// Controls tab root
// ============================================================

export function ControlsTab({ fleetNames, onFleetsChanged }: { fleetNames: string[]; onFleetsChanged: () => void }) {
  const [wallets, setWallets] = useState<Wallet[]>([]);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [isLoading, setIsLoading] = useState(true);
  const [deleteConfirm, setDeleteConfirm] = useState<number | null>(null);

  const masterWallet = wallets.find((w) => w.isMaster) ?? null;

  async function loadWallets() {
    try {
      const data = await fetchWallets();
      setWallets(data);
    } catch {
      // ignore
    } finally {
      setIsLoading(false);
    }
  }

  useEffect(() => {
    void loadWallets();
  }, []);

  function toggleWallet(id: number) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function selectAll() {
    setSelected(new Set(wallets.filter((w) => !w.isMaster).map((w) => w.id)));
  }

  function selectNone() {
    setSelected(new Set());
  }

  async function handleDeleteWallet(id: number) {
    if (deleteConfirm !== id) {
      // First click: ask for confirmation
      setDeleteConfirm(id);
      return;
    }
    // Second click: confirmed
    setDeleteConfirm(null);
    try {
      await deleteWallet(id);
      setSelected((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
      await loadWallets();
    } catch (err) {
      // Could surface an error here, but keep it simple
      console.error("Delete wallet failed:", err);
    }
  }

  const nonMasterCount = wallets.filter((w) => !w.isMaster).length;

  return (
    <div className="space-y-4">
      {/* Wallet selector */}
      <div className="rounded-lg border border-slate-700 bg-slate-900 p-4">
        <div className="mb-2 flex items-center justify-between">
          <h3 className="text-sm font-semibold text-slate-200">
            Wallets ({selected.size}/{nonMasterCount} selected)
          </h3>
          <div className="flex gap-3">
            <button onClick={selectAll} className="text-xs text-slate-400 hover:text-slate-200">
              All
            </button>
            <button onClick={selectNone} className="text-xs text-slate-400 hover:text-slate-200">
              None
            </button>
            <button
              onClick={() => {
                setDeleteConfirm(null);
                void loadWallets();
              }}
              disabled={isLoading}
              className="text-xs text-slate-500 hover:text-slate-300 disabled:opacity-50"
            >
              Refresh
            </button>
          </div>
        </div>
        {deleteConfirm !== null && (
          <p className="mb-2 text-xs text-amber-400">
            Click ✕ again on wallet #{deleteConfirm} to confirm removal. This only removes
            tracking — the on-chain account is unaffected.
          </p>
        )}
        {isLoading ? (
          <p className="text-xs text-slate-400">Loading…</p>
        ) : (
          <WalletList
            wallets={wallets}
            selected={selected}
            onToggle={toggleWallet}
            onDelete={(id) => void handleDeleteWallet(id)}
          />
        )}
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <FundPanel masterWallet={masterWallet} selected={selected} />
        <SwapPanel selected={selected} />
      </div>

      {fleetNames.length > 0 && <FleetTradePanel fleetNames={fleetNames} />}

      <CreateFleetPanel
        onCreated={() => {
          void loadWallets();
          onFleetsChanged();
        }}
      />

      <ImportPositionPanel />
    </div>
  );
}
