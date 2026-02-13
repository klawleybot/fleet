import { db } from "../db/index.js";
import {
  createSmartAccount,
  getOrCreateMasterSmartAccount,
  getOrCreateOwnerAccount,
} from "./cdp.js";
import type { WalletRecord } from "../types.js";
import { getEthBalance } from "./balance.js";

export async function ensureMasterWallet(): Promise<WalletRecord> {
  const existingMaster = db.getMasterWallet();
  if (existingMaster) {
    return existingMaster;
  }

  const { owner, smartAccount } = await getOrCreateMasterSmartAccount();
  return db.createWallet({
    name: "master",
    address: smartAccount.address,
    cdpAccountName: "master",
    ownerAddress: owner.address,
    type: "smart",
    isMaster: true,
  });
}

export async function createFleetWallets(count: number): Promise<WalletRecord[]> {
  if (count < 1) {
    throw new Error("count must be at least 1");
  }

  await getOrCreateOwnerAccount();
  await ensureMasterWallet();

  const created: WalletRecord[] = [];
  const currentWallets = db.listWallets();
  let fleetIndex = currentWallets.filter((wallet) => !wallet.isMaster).length + 1;

  for (let index = 0; index < count; index += 1) {
    const walletName = `fleet-${fleetIndex}`;
    fleetIndex += 1;

    const { owner, smartAccount } = await createSmartAccount(walletName);
    created.push(
      db.createWallet({
        name: walletName,
        address: smartAccount.address,
        cdpAccountName: walletName,
        ownerAddress: owner.address,
        type: "smart",
        isMaster: false,
      }),
    );
  }

  return created;
}

export function listWallets(): WalletRecord[] {
  return db.listWallets();
}

export function getWalletById(id: number): WalletRecord | null {
  return db.getWalletById(id);
}

export async function getWalletEthBalance(id: number): Promise<{
  wallet: WalletRecord;
  balanceWei: string;
}> {
  const wallet = db.getWalletById(id);
  if (!wallet) {
    throw new Error(`wallet ${id} was not found`);
  }

  const balance = await getEthBalance(wallet.address);
  return {
    wallet,
    balanceWei: balance.toString(),
  };
}

