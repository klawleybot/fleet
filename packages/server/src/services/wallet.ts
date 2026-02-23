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

export async function createFleetWallets(count: number, fleetName: string): Promise<WalletRecord[]> {
  if (count < 1) {
    throw new Error("count must be at least 1");
  }

  await getOrCreateOwnerAccount();
  await ensureMasterWallet();

  const created: WalletRecord[] = [];
  // Count existing wallets for this fleet namespace to determine starting index
  const currentWallets = db.listWallets();
  const prefix = `${fleetName}-`;
  const existingForFleet = currentWallets.filter((w) => !w.isMaster && w.name.startsWith(prefix));
  let fleetIndex = existingForFleet.length + 1;

  for (let index = 0; index < count; index += 1) {
    const walletName = `${fleetName}-${fleetIndex}`;
    fleetIndex += 1;

    const { owner, smartAccount } = await createSmartAccount(walletName);

    // Check for address collision
    const existingByAddress = currentWallets.find(
      (w) => w.address.toLowerCase() === smartAccount.address.toLowerCase(),
    );
    if (existingByAddress) {
      throw new Error(
        `Address collision: derived address ${smartAccount.address} for wallet "${walletName}" ` +
        `already exists as wallet "${existingByAddress.name}" (id=${existingByAddress.id}). ` +
        `This indicates a wallet naming conflict.`,
      );
    }

    const wallet = db.createWallet({
      name: walletName,
      address: smartAccount.address,
      cdpAccountName: walletName,
      ownerAddress: owner.address,
      type: "smart",
      isMaster: false,
    });
    created.push(wallet);
    // Add to currentWallets so subsequent iterations can detect collisions
    currentWallets.push(wallet);
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

