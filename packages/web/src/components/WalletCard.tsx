import type { Wallet } from "../types";

interface WalletCardProps {
  wallet: Wallet;
  isSelected: boolean;
  onToggle: (walletId: number, selected: boolean) => void;
}

function shortenAddress(address: `0x${string}`): string {
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

export function WalletCard({ wallet, isSelected, onToggle }: WalletCardProps) {
  return (
    <div className="rounded-lg border border-slate-700 bg-slate-900 p-4">
      <label className="flex cursor-pointer items-start gap-3">
        <input
          type="checkbox"
          className="mt-1 h-4 w-4"
          checked={isSelected}
          onChange={(event) => onToggle(wallet.id, event.target.checked)}
          disabled={wallet.isMaster}
        />
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <span className="font-semibold text-slate-100">{wallet.name}</span>
            {wallet.isMaster ? (
              <span className="rounded bg-amber-700 px-2 py-0.5 text-xs text-amber-100">
                master
              </span>
            ) : null}
          </div>
          <p className="text-sm text-slate-300">{shortenAddress(wallet.address)}</p>
          <p className="text-xs text-slate-500">{wallet.address}</p>
        </div>
      </label>
    </div>
  );
}

