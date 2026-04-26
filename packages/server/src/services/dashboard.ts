/**
 * Dashboard Service — Global and per-fleet P&L + available ETH
 */
import { type Address, formatEther } from "viem";
import { getFleetStatus, type FleetSummary } from "./monitor.js";
import { listFleets } from "./fleet.js";
import { ensureMasterWallet } from "./wallet.js";
import { getEthBalance } from "./balance.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface WalletBalance {
  name: string;
  address: Address;
  balanceWei: string;
}

export interface FleetDashboard {
  name: string;
  clusterId: number;
  walletCount: number;
  wallets: WalletBalance[];
  /** Total ETH across all wallets in this fleet */
  totalEthWei: string;
  totalEth: string;
  /** P&L from positions */
  totalCostWei: string;
  totalReceivedWei: string;
  realizedPnlWei: string;
  realizedPnl: string;
  /** Coins held */
  coinSummaries: FleetSummary["coinSummaries"];
}

export interface GlobalDashboard {
  /** Master SA balance */
  master: WalletBalance;
  /** Per-fleet dashboards */
  fleets: FleetDashboard[];
  /** Aggregate across all fleets + master */
  totalAvailableEthWei: string;
  totalAvailableEth: string;
  /** Global P&L across all fleets */
  globalCostWei: string;
  globalReceivedWei: string;
  globalRealizedPnlWei: string;
  globalRealizedPnl: string;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export async function getFleetDashboard(fleetName: string): Promise<FleetDashboard> {
  const fleets = listFleets();
  const fleet = fleets.find((f) => f.name === fleetName);
  if (!fleet) throw new Error(`Fleet "${fleetName}" not found`);

  // Query balances
  const walletBalances: WalletBalance[] = [];
  let totalEth = 0n;
  for (const w of fleet.wallets) {
    const bal = await getEthBalance(w.address);
    walletBalances.push({
      name: w.name,
      address: w.address,
      balanceWei: bal.toString(),
    });
    totalEth += bal;
  }

  // Get P&L from monitor
  const status = await getFleetStatus({ clusterId: fleet.clusterId });

  return {
    name: fleet.name,
    clusterId: fleet.clusterId,
    walletCount: fleet.wallets.length,
    wallets: walletBalances,
    totalEthWei: totalEth.toString(),
    totalEth: formatEther(totalEth),
    totalCostWei: status.totalCostWei,
    totalReceivedWei: status.totalReceivedWei,
    realizedPnlWei: status.totalRealizedPnlWei,
    realizedPnl: formatEther(BigInt(status.totalRealizedPnlWei)),
    coinSummaries: status.coinSummaries,
  };
}

export async function getGlobalDashboard(): Promise<GlobalDashboard> {
  // Master wallet balance
  const master = await ensureMasterWallet();
  const masterBal = await getEthBalance(master.address);
  const masterWallet: WalletBalance = {
    name: "master",
    address: master.address,
    balanceWei: masterBal.toString(),
  };

  // All fleets
  const fleetList = listFleets();
  const fleetDashboards: FleetDashboard[] = [];

  let totalEth = masterBal;
  let globalCost = 0n;
  let globalReceived = 0n;

  for (const fleet of fleetList) {
    const dashboard = await getFleetDashboard(fleet.name);
    fleetDashboards.push(dashboard);
    totalEth += BigInt(dashboard.totalEthWei);
    globalCost += BigInt(dashboard.totalCostWei);
    globalReceived += BigInt(dashboard.totalReceivedWei);
  }

  const globalPnl = globalReceived - globalCost;

  return {
    master: masterWallet,
    fleets: fleetDashboards,
    totalAvailableEthWei: totalEth.toString(),
    totalAvailableEth: formatEther(totalEth),
    globalCostWei: globalCost.toString(),
    globalReceivedWei: globalReceived.toString(),
    globalRealizedPnlWei: globalPnl.toString(),
    globalRealizedPnl: formatEther(globalPnl),
  };
}
