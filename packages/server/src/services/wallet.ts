import { db } from "../db/index.js";
import {
  createSmartAccount,
  getOrCreateMasterSmartAccount,
  getOrCreateOwnerAccount,
} from "./cdp.js";
import type { WalletRecord } from "../types.js";
import { getEthBalance } from "./balance.js";

export async function ensureMasterWallet(): Promise<WalletRecord> {
  const { owner, smartAccount } = await getOrCreateMasterSmartAccount();

  const existingMaster = db.getMasterWallet();
  if (existingMaster) {
    // Validate: DB record must match the live derived addresses.
    // A mismatch means the private key changed without resetting the DB.
    if (existingMaster.ownerAddress.toLowerCase() !== owner.address.toLowerCase()) {
      throw new Error(
        `MASTER KEY MISMATCH: DB owner ${existingMaster.ownerAddress} ≠ derived owner ${owner.address}. ` +
        `The MASTER_WALLET_PRIVATE_KEY (or LOCAL_SIGNER_SEED) changed since this DB was created. ` +
        `Either restore the original key or delete the master wallet record (id=${existingMaster.id}) to re-derive.`,
      );
    }
    if (existingMaster.address.toLowerCase() !== smartAccount.address.toLowerCase()) {
      throw new Error(
        `MASTER SMART ACCOUNT MISMATCH: DB address ${existingMaster.address} ≠ derived ${smartAccount.address}. ` +
        `This should not happen if the owner key matches. Possible chain/version drift. ` +
        `Delete the master wallet record (id=${existingMaster.id}) to re-derive.`,
      );
    }
    return existingMaster;
  }

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

