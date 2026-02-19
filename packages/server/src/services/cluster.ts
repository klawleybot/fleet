import { db } from "../db/index.js";
import type { ClusterRecord, StrategyMode, WalletRecord } from "../types.js";

export function createCluster(input: { name: string; strategyMode?: StrategyMode }): ClusterRecord {
  const name = input.name.trim();
  if (!name) throw new Error("Cluster name is required");
  return db.createCluster({
    name,
    strategyMode: input.strategyMode ?? "sync",
  });
}

export function listClusters(): ClusterRecord[] {
  return db.listClusters();
}

export function getCluster(id: number): ClusterRecord {
  const cluster = db.getClusterById(id);
  if (!cluster) throw new Error(`Cluster ${id} not found`);
  return cluster;
}

export function setClusterWallets(clusterId: number, walletIds: number[]) {
  const cluster = db.getClusterById(clusterId);
  if (!cluster) throw new Error(`Cluster ${clusterId} not found`);
  if (!walletIds.length) throw new Error("At least one wallet id is required");

  for (const walletId of walletIds) {
    const wallet = db.getWalletById(walletId);
    if (!wallet) throw new Error(`Wallet ${walletId} not found`);
    if (wallet.isMaster) throw new Error("Master wallet cannot be assigned to a fleet cluster");
  }

  return db.setClusterWallets(clusterId, walletIds);
}

export function listClusterWallets(clusterId: number): WalletRecord[] {
  const cluster = db.getClusterById(clusterId);
  if (!cluster) throw new Error(`Cluster ${clusterId} not found`);
  return db.listClusterWalletDetails(clusterId);
}
