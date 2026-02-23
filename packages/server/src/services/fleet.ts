/**
 * Fleet Service — Named Fleet Lifecycle
 *
 * A "fleet" is a named cluster of wallets that can be created, funded,
 * and operated as a unit.
 *
 * Funding is pre-validated: no transfers start until we've confirmed the
 * funding source has enough balance to cover all wallets + estimated gas.
 *
 * - `createFleet()` — create wallets + cluster + assign + optionally fund
 * - `sweepFleet()` — sweep all ETH from one fleet into another
 * - `getFleetByName()` — resolve fleet by name
 * - `listFleets()` — list all fleets with wallet counts
 */
import { createPublicClient, http, formatEther, type Address } from "viem";
import { db } from "../db/index.js";
import type { ClusterRecord, WalletRecord } from "../types.js";
import { transferFromSmartAccount } from "./cdp.js";
import { createFleetWallets, ensureMasterWallet } from "./wallet.js";
import {
  requestFundingOperation,
  approveAndExecuteOperation,
} from "./operations.js";
import { getFleetStatus, type FleetSummary } from "./monitor.js";
import { getChainConfig } from "./network.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Conservative per-transfer gas estimate in wei (UserOp overhead on L2). */
const GAS_PER_TRANSFER_WEI = 300_000_000_000_000n; // 0.0003 ETH

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface FleetInfo {
  clusterId: number;
  name: string;
  strategyMode: string;
  wallets: WalletRecord[];
  createdAt: string;
}

export interface FleetCreateResult {
  fleet: FleetInfo;
  fundingOperationId: number | null;
}

/** Returned when funding source has insufficient balance. */
export interface FundingShortfall {
  fundingAddress: Address;
  currentBalance: bigint;
  requiredBalance: bigint;
  perWalletAmount: bigint;
  walletCount: number;
  estimatedGas: bigint;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Check that a funding source has enough balance to cover all transfers + gas.
 * Returns null if sufficient, or a FundingShortfall describing the gap.
 */
async function checkFundingBalance(params: {
  fundingAddress: Address;
  perWalletWei: bigint;
  walletCount: number;
  rpcUrl?: string;
}): Promise<FundingShortfall | null> {
  const chainCfg = getChainConfig();
  const client = createPublicClient({
    chain: chainCfg.chain,
    transport: http(params.rpcUrl ?? chainCfg.rpcUrl),
  });

  const balance = await client.getBalance({ address: params.fundingAddress });
  const totalTransfers = params.perWalletWei * BigInt(params.walletCount);
  const totalGas = GAS_PER_TRANSFER_WEI * BigInt(params.walletCount);
  const required = totalTransfers + totalGas;

  if (balance >= required) return null;

  return {
    fundingAddress: params.fundingAddress,
    currentBalance: balance,
    requiredBalance: required,
    perWalletAmount: params.perWalletWei,
    walletCount: params.walletCount,
    estimatedGas: totalGas,
  };
}

export function formatShortfall(s: FundingShortfall): string {
  const deficit = s.requiredBalance - s.currentBalance;
  return (
    `Funding source ${s.fundingAddress} has insufficient balance.\n` +
    `  Balance:  ${formatEther(s.currentBalance)} ETH\n` +
    `  Required: ${formatEther(s.requiredBalance)} ETH ` +
    `(${s.walletCount} × ${formatEther(s.perWalletAmount)} ETH + ~${formatEther(s.estimatedGas)} gas)\n` +
    `  Deficit:  ${formatEther(deficit)} ETH\n` +
    `Please fund ${s.fundingAddress} with at least ${formatEther(deficit)} ETH before creating this fleet.`
  );
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

/**
 * Create a named fleet: wallets + cluster + assign + optional fund.
 *
 * Funding is pre-validated — if `fundAmountWei` is set, we verify the
 * funding source (master SA or `sourceFleetName`) has enough balance
 * to cover all transfers + gas BEFORE creating any wallets or starting
 * any transfers. If funds are insufficient, throws with a FundingShortfall
 * describing exactly how much is needed and where to send it.
 */
export async function createFleet(params: {
  name: string;
  walletCount: number;
  fundAmountWei?: string;
  sourceFleetName?: string;
  strategyMode?: "sync" | "staggered" | "momentum";
}): Promise<FleetCreateResult> {
  const { name, walletCount, fundAmountWei, sourceFleetName, strategyMode = "sync" } = params;

  if (walletCount < 1 || walletCount > 100) {
    throw new Error("walletCount must be between 1 and 100");
  }

  // Check name isn't taken
  const existing = db.getClusterByName(name);
  if (existing) {
    throw new Error(`Fleet "${name}" already exists (cluster id ${existing.id})`);
  }

  // --- Pre-validate funding BEFORE creating anything ---
  if (fundAmountWei && BigInt(fundAmountWei) > 0n && process.env.CDP_MOCK_MODE !== "1") {
    const perWalletWei = BigInt(fundAmountWei);
    let fundingAddress: Address;

    if (sourceFleetName) {
      // Funding from another fleet — sum all wallet balances
      const sourceFleet = getFleetByName(sourceFleetName);
      if (!sourceFleet) throw new Error(`Source fleet "${sourceFleetName}" not found`);
      if (sourceFleet.wallets.length === 0) throw new Error(`Source fleet "${sourceFleetName}" has no wallets`);

      // For fleet-to-fleet funding, we check aggregate balance of source fleet
      const chainCfg = getChainConfig();
      const client = createPublicClient({ chain: chainCfg.chain, transport: http(chainCfg.rpcUrl) });
      let totalSourceBalance = 0n;
      for (const w of sourceFleet.wallets) {
        totalSourceBalance += await client.getBalance({ address: w.address as Address });
      }
      const totalRequired = perWalletWei * BigInt(walletCount) + GAS_PER_TRANSFER_WEI * BigInt(walletCount);
      if (totalSourceBalance < totalRequired) {
        throw new Error(
          `Source fleet "${sourceFleetName}" has insufficient aggregate balance.\n` +
            `  Balance:  ${formatEther(totalSourceBalance)} ETH (across ${sourceFleet.wallets.length} wallets)\n` +
            `  Required: ${formatEther(totalRequired)} ETH ` +
            `(${walletCount} × ${formatEther(perWalletWei)} ETH + ~${formatEther(GAS_PER_TRANSFER_WEI * BigInt(walletCount))} gas)\n` +
            `  Deficit:  ${formatEther(totalRequired - totalSourceBalance)} ETH`,
        );
      }
    } else {
      // Funding from master SA
      const master = await ensureMasterWallet();
      fundingAddress = master.address as Address;
      const shortfall = await checkFundingBalance({
        fundingAddress,
        perWalletWei,
        walletCount,
      });
      if (shortfall) {
        throw new Error(formatShortfall(shortfall));
      }
    }
  }

  // --- Funding secured — safe to create wallets and transfer ---
  const wallets = await createFleetWallets(walletCount, name);
  const walletIds = wallets.map((w) => w.id);

  const cluster = db.createCluster({ name, strategyMode });
  db.setClusterWallets(cluster.id, walletIds);

  let fundingOperationId: number | null = null;
  if (fundAmountWei && BigInt(fundAmountWei) > 0n) {
    const op = requestFundingOperation({
      clusterId: cluster.id,
      amountWei: fundAmountWei,
      requestedBy: "fleet-create",
    });
    const executed = await approveAndExecuteOperation({
      operationId: op.id,
      approvedBy: "fleet-create",
    });
    fundingOperationId = executed.id;

    if (executed.status !== "complete") {
      throw new Error(
        `Fleet funding failed (operation #${executed.id}, status: ${executed.status}). ` +
          `Error: ${executed.errorMessage ?? "unknown"}. Fleet wallets may be partially funded.`,
      );
    }

    // Post-transfer verification (skip in mock mode)
    if (process.env.CDP_MOCK_MODE !== "1") {
      const chainCfg = getChainConfig();
      const client = createPublicClient({ chain: chainCfg.chain, transport: http(chainCfg.rpcUrl) });
      const expectedMin = BigInt(fundAmountWei) / 2n;
      const unfunded: string[] = [];
      for (const w of wallets) {
        const bal = await client.getBalance({ address: w.address as Address });
        if (bal < expectedMin) {
          unfunded.push(`${w.name} (${w.address}): ${formatEther(bal)} ETH`);
        }
      }
      if (unfunded.length > 0) {
        throw new Error(
          `Fleet funding incomplete — ${unfunded.length}/${wallets.length} wallets underfunded:\n` +
            unfunded.join("\n") +
            `\nFleet "${name}" created but NOT ready for trading.`,
        );
      }
    }
  }

  return {
    fleet: {
      clusterId: cluster.id,
      name: cluster.name,
      strategyMode: cluster.strategyMode,
      wallets,
      createdAt: cluster.createdAt,
    },
    fundingOperationId,
  };
}

// ---------------------------------------------------------------------------
// Query
// ---------------------------------------------------------------------------

export function getFleetByName(name: string): FleetInfo | null {
  const cluster = db.getClusterByName(name);
  if (!cluster) return null;

  const wallets = db.listClusterWalletDetails(cluster.id);
  return {
    clusterId: cluster.id,
    name: cluster.name,
    strategyMode: cluster.strategyMode,
    wallets,
    createdAt: cluster.createdAt,
  };
}

export function listFleets(): FleetInfo[] {
  const clusters = db.listClusters();
  return clusters.map((c) => {
    const wallets = db.listClusterWalletDetails(c.id);
    return {
      clusterId: c.id,
      name: c.name,
      strategyMode: c.strategyMode,
      wallets,
      createdAt: c.createdAt,
    };
  });
}

// ---------------------------------------------------------------------------
// Sweep — consolidate ETH from fleet wallets to a target address
// ---------------------------------------------------------------------------

export interface SweepResult {
  sourceFleet: string;
  targetAddress: Address;
  transfers: Array<{
    wallet: string;
    address: Address;
    balanceBefore: bigint;
    amountSent: bigint;
    txHash: string | null;
    status: string;
    error?: string;
  }>;
  totalSwept: bigint;
  totalFailed: bigint;
}

/**
 * Sweep ETH from all wallets in a fleet to a target address.
 *
 * Target can be:
 * - Another fleet's wallets (splits evenly across them)
 * - Master SA (consolidate back)
 * - Any arbitrary address
 *
 * Each wallet sends (balance - reserveWei) to avoid draining gas money
 * for the transfer itself.
 */
export async function sweepFleet(params: {
  sourceFleetName: string;
  targetAddress?: Address;
  targetFleetName?: string;
  /** Wei to reserve in each source wallet for gas (default: 0.0005 ETH) */
  reserveWei?: bigint;
}): Promise<SweepResult> {
  const source = getFleetByName(params.sourceFleetName);
  if (!source) throw new Error(`Source fleet "${params.sourceFleetName}" not found`);
  if (source.wallets.length === 0) throw new Error(`Source fleet "${params.sourceFleetName}" has no wallets`);

  // Resolve target
  let targetAddress: Address;
  if (params.targetFleetName) {
    // Sweep to another fleet — send to that fleet's first wallet for now.
    // A more sophisticated version would distribute across target wallets.
    const target = getFleetByName(params.targetFleetName);
    if (!target) throw new Error(`Target fleet "${params.targetFleetName}" not found`);
    if (target.wallets.length === 0) throw new Error(`Target fleet "${params.targetFleetName}" has no wallets`);
    if (source.clusterId === target.clusterId) throw new Error("Source and target fleet cannot be the same");
    targetAddress = target.wallets[0]!.address as Address;
  } else if (params.targetAddress) {
    targetAddress = params.targetAddress;
  } else {
    // Default: sweep back to master SA
    const master = await ensureMasterWallet();
    targetAddress = master.address as Address;
  }

  const reserveWei = params.reserveWei ?? 500_000_000_000_000n; // 0.0005 ETH default

  // Query balances
  const chainCfg = getChainConfig();
  const client = createPublicClient({ chain: chainCfg.chain, transport: http(chainCfg.rpcUrl) });

  const transfers: SweepResult["transfers"] = [];
  let totalSwept = 0n;
  let totalFailed = 0n;

  for (const wallet of source.wallets) {
    const balance = await client.getBalance({ address: wallet.address as Address });
    const sendable = balance > reserveWei ? balance - reserveWei : 0n;

    if (sendable <= 0n) {
      transfers.push({
        wallet: wallet.name,
        address: wallet.address as Address,
        balanceBefore: balance,
        amountSent: 0n,
        txHash: null,
        status: "skipped",
      });
      continue;
    }

    try {
      const result = await transferFromSmartAccount({
        smartAccountName: wallet.cdpAccountName,
        to: targetAddress,
        amountWei: sendable,
      });
      transfers.push({
        wallet: wallet.name,
        address: wallet.address as Address,
        balanceBefore: balance,
        amountSent: sendable,
        txHash: result.txHash,
        status: result.status,
      });
      if (result.status === "complete") {
        totalSwept += sendable;
      } else {
        totalFailed += sendable;
      }
    } catch (err) {
      transfers.push({
        wallet: wallet.name,
        address: wallet.address as Address,
        balanceBefore: balance,
        amountSent: 0n,
        txHash: null,
        status: "error",
        error: err instanceof Error ? err.message : String(err),
      });
      totalFailed += sendable;
    }
  }

  return {
    sourceFleet: params.sourceFleetName,
    targetAddress,
    transfers,
    totalSwept,
    totalFailed,
  };
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

export async function getFleetStatusByName(
  fleetName: string,
  refreshBalances = false,
): Promise<FleetSummary> {
  const fleet = getFleetByName(fleetName);
  if (!fleet) throw new Error(`Fleet "${fleetName}" not found`);

  return getFleetStatus({ clusterId: fleet.clusterId, refreshBalances });
}
