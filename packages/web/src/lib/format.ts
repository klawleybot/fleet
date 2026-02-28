const ETH_DECIMALS = 18n;
const ETH_SCALE = 10n ** ETH_DECIMALS;

/** Format a wei string/bigint as ETH with up to 6 decimal places */
export function fmtEth(wei: string | bigint | null | undefined, decimals = 6): string {
  if (wei === null || wei === undefined) return "—";
  try {
    const n = typeof wei === "bigint" ? wei : BigInt(wei);
    const whole = n / ETH_SCALE;
    const remainder = n % ETH_SCALE;
    // Handle negative
    if (n < 0n) {
      const absWhole = (-n) / ETH_SCALE;
      const absRem = (-n) % ETH_SCALE;
      const dec = absRem.toString().padStart(18, "0").slice(0, decimals);
      return `-${absWhole}.${dec}`;
    }
    const dec = remainder.toString().padStart(18, "0").slice(0, decimals);
    return `${whole}.${dec}`;
  } catch {
    return "?";
  }
}

/** Format P&L with sign prefix */
export function fmtPnl(wei: string | bigint | null | undefined): string {
  if (wei === null || wei === undefined) return "—";
  try {
    const n = typeof wei === "bigint" ? wei : BigInt(wei);
    const formatted = fmtEth(n < 0n ? -n : n, 6);
    return n >= 0n ? `+${formatted}` : `-${formatted}`;
  } catch {
    return "?";
  }
}

/** Whether a wei value is positive */
export function isPositive(wei: string | bigint | null | undefined): boolean {
  if (wei === null || wei === undefined) return false;
  try {
    return (typeof wei === "bigint" ? wei : BigInt(wei)) > 0n;
  } catch {
    return false;
  }
}

/** Whether a wei value is negative */
export function isNegative(wei: string | bigint | null | undefined): boolean {
  if (wei === null || wei === undefined) return false;
  try {
    return (typeof wei === "bigint" ? wei : BigInt(wei)) < 0n;
  } catch {
    return false;
  }
}

/** Shorten an 0x address to 0x1234…5678 */
export function shortAddr(addr: string): string {
  if (!addr || addr.length < 10) return addr;
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

/** Format a date string as relative time (e.g. "2m ago") */
export function relTime(dateStr: string | null | undefined): string {
  if (!dateStr) return "—";
  try {
    const diff = Date.now() - new Date(dateStr).getTime();
    if (diff < 0) return "just now";
    const s = Math.floor(diff / 1000);
    if (s < 60) return `${s}s ago`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m ago`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h ago`;
    return `${Math.floor(h / 24)}d ago`;
  } catch {
    return dateStr;
  }
}

/** Format a timestamp to HH:MM:SS local */
export function fmtTime(dateStr: string | null | undefined): string {
  if (!dateStr) return "—";
  try {
    return new Date(dateStr).toLocaleTimeString();
  } catch {
    return dateStr;
  }
}

/** Tailwind color class for a P&L value */
export function pnlColor(wei: string | bigint | null | undefined): string {
  if (isPositive(wei)) return "text-emerald-400";
  if (isNegative(wei)) return "text-rose-400";
  return "text-slate-400";
}

/** ETH address → BaseScan link */
export function baseScanAddr(addr: string): string {
  return `https://basescan.org/address/${addr}`;
}

/** Tx hash → BaseScan link */
export function baseScanTx(hash: string): string {
  return `https://basescan.org/tx/${hash}`;
}
