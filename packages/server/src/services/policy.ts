import { db } from "../db/index.js";
import { isCoinInWatchlist } from "./zoraSignals.js";

function parseBigIntEnv(name: string, fallback: bigint): bigint {
  const raw = process.env[name];
  if (!raw || !raw.trim()) return fallback;
  try {
    const value = BigInt(raw.trim());
    return value >= 0n ? value : fallback;
  } catch {
    return fallback;
  }
}

function parseIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw || !raw.trim()) return fallback;
  const value = Number.parseInt(raw, 10);
  if (Number.isNaN(value)) return fallback;
  return value;
}

function parseBoolEnv(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (!raw || !raw.trim()) return fallback;
  const normalized = raw.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}

function parseAllowList(name: string): Set<string> {
  const raw = process.env[name];
  if (!raw?.trim()) return new Set();
  return new Set(
    raw
      .split(",")
      .map((v) => v.trim().toLowerCase())
      .filter(Boolean),
  );
}

export function getPolicy() {
  return {
    killSwitch: parseBoolEnv("FLEET_KILL_SWITCH", false),
    maxFundingWei: parseBigIntEnv("MAX_FUNDING_WEI", 30_000_000_000_000_000n), // 0.03 ETH
    maxTradeWei: parseBigIntEnv("MAX_TRADE_WEI", 5_000_000_000_000_000n), // 0.005 ETH
    maxPerWalletWei: parseBigIntEnv("MAX_PER_WALLET_WEI", 3_000_000_000_000_000n), // 0.003 ETH
    maxSlippageBps: parseIntEnv("MAX_SLIPPAGE_BPS", 400),
    clusterCooldownSec: parseIntEnv("CLUSTER_COOLDOWN_SEC", 45),
    requireWatchlistCoin: parseBoolEnv("REQUIRE_WATCHLIST_COIN", true),
    requireWatchlistName: process.env.REQUIRE_WATCHLIST_NAME?.trim() || null,
    allowedCoins: parseAllowList("ALLOWED_COIN_ADDRESSES"),
  };
}

export function assertExecutionAllowed(input: { clusterId: number; excludeOperationId?: number }) {
  const policy = getPolicy();
  if (policy.killSwitch) {
    throw new Error("FLEET_KILL_SWITCH is enabled; execution is blocked");
  }

  const ageSec = db.getLatestClusterOperationAgeSec(input.clusterId, input.excludeOperationId);
  if (ageSec !== null && ageSec < policy.clusterCooldownSec) {
    throw new Error(
      `Cluster cooldown active (${ageSec}s elapsed, requires ${policy.clusterCooldownSec}s)`,
    );
  }
}

export function assertFundingRequestAllowed(input: { amountWei: bigint; walletCount: number }) {
  const policy = getPolicy();

  if (input.amountWei <= 0n) throw new Error("amountWei must be > 0");
  if (input.amountWei > policy.maxFundingWei) {
    throw new Error(`Funding amount exceeds MAX_FUNDING_WEI (${policy.maxFundingWei.toString()})`);
  }

  const perWallet = input.amountWei;
  if (perWallet > policy.maxPerWalletWei) {
    throw new Error(`Per-wallet funding exceeds MAX_PER_WALLET_WEI (${policy.maxPerWalletWei.toString()})`);
  }

  if (input.walletCount < 1) throw new Error("walletCount must be >= 1");
}

export function assertTradeRequestAllowed(input: {
  coinAddress: `0x${string}`;
  totalAmountWei: bigint;
  walletCount: number;
  slippageBps: number;
}) {
  const policy = getPolicy();

  if (input.totalAmountWei <= 0n) throw new Error("totalAmountWei must be > 0");
  if (input.totalAmountWei > policy.maxTradeWei) {
    throw new Error(`Trade amount exceeds MAX_TRADE_WEI (${policy.maxTradeWei.toString()})`);
  }

  if (input.walletCount < 1) throw new Error("walletCount must be >= 1");

  const perWallet = input.totalAmountWei / BigInt(input.walletCount);
  if (perWallet > policy.maxPerWalletWei) {
    throw new Error(`Per-wallet trade exceeds MAX_PER_WALLET_WEI (${policy.maxPerWalletWei.toString()})`);
  }

  if (!Number.isInteger(input.slippageBps) || input.slippageBps < 1 || input.slippageBps > policy.maxSlippageBps) {
    throw new Error(`slippageBps must be between 1 and MAX_SLIPPAGE_BPS (${policy.maxSlippageBps})`);
  }

  if (policy.allowedCoins.size > 0 && !policy.allowedCoins.has(input.coinAddress.toLowerCase())) {
    throw new Error("coinAddress is not in ALLOWED_COIN_ADDRESSES allowlist");
  }

  if (policy.requireWatchlistCoin) {
    const inWatchlist = isCoinInWatchlist(input.coinAddress, policy.requireWatchlistName ?? undefined);
    if (!inWatchlist) {
      throw new Error(
        policy.requireWatchlistName
          ? `coinAddress is not in required watchlist (${policy.requireWatchlistName})`
          : "coinAddress is not in enabled zora-intelligence watchlist",
      );
    }
  }
}
