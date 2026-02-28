/**
 * Bridge to the @fleet/intelligence engine for signal queries.
 * Delegates to the singleton IntelligenceEngine managed by ./intelligence.ts.
 *
 * All function signatures are preserved for backward compatibility with
 * autonomy.ts, operations.ts, and policy.ts.
 */

import { getIntelligenceEngine } from "./intelligence.js";
import type {
  ZoraSignalCoin,
  ZoraSignalMode,
  PumpSignal,
  DipSignal,
} from "@fleet/intelligence";

export type { ZoraSignalCoin, ZoraSignalMode, PumpSignal, DipSignal };

export function topMovers(input?: { limit?: number; minMomentum?: number }): ZoraSignalCoin[] {
  return getIntelligenceEngine().topMovers(input);
}

export function watchlistSignals(input?: { listName?: string; limit?: number }): ZoraSignalCoin[] {
  return getIntelligenceEngine().watchlistSignals(input);
}

export function detectPumpSignals(input: {
  coinAddresses: `0x${string}`[];
  accelerationThreshold?: number;
  netFlowMinUsdc?: number;
}): PumpSignal[] {
  return getIntelligenceEngine().detectPumpSignals(input);
}

export function detectDipSignals(input: {
  previouslyTradedAddresses?: `0x${string}`[];
  accelerationThreshold?: number;
  minSwapCount24h?: number;
  listName?: string;
}): DipSignal[] {
  return getIntelligenceEngine().detectDipSignals(input);
}

export function discountOwnActivity(
  coinAddress: `0x${string}`,
  clusterWalletAddresses: string[],
): number {
  return getIntelligenceEngine().discountOwnActivity(coinAddress, clusterWalletAddresses);
}

export function selectSignalCoin(input: {
  mode: ZoraSignalMode;
  listName?: string;
  minMomentum?: number;
}): ZoraSignalCoin {
  return getIntelligenceEngine().selectSignalCoin(input);
}

export function getFleetWatchlistName(): string {
  return getIntelligenceEngine().getFleetWatchlistName();
}

export function addToWatchlist(
  coinAddress: `0x${string}`,
  input?: { listName?: string; label?: string; notes?: string },
): void {
  return getIntelligenceEngine().addToWatchlist(coinAddress, input);
}

export function removeFromWatchlist(
  coinAddress: `0x${string}`,
  listName?: string,
): boolean {
  return getIntelligenceEngine().removeFromWatchlist(coinAddress, listName);
}

export function isCoinInWatchlist(coinAddress: `0x${string}`, listName?: string): boolean {
  return getIntelligenceEngine().isCoinInWatchlist(coinAddress, listName);
}
