/**
 * Coinbase Smart Wallet owner migration.
 *
 * Migrates ownership of a CoinbaseSmartWallet (MultiOwnable) from one EOA
 * signer to another via two UserOperations:
 *   1. addOwnerAddress(newOwner) — signed by the current owner
 *   2. removeOwnerAtIndex(oldOwnerIndex, oldOwnerBytes) — signed by the new owner
 *
 * This ensures the wallet is never left without an owner and the compromised
 * key is fully removed.
 */

import { type Address, encodeFunctionData, getAddress } from "viem";
import type { PublicClient as ReadPublicClient } from "viem";
import type { PrivateKeyAccount } from "viem/accounts";
import {
  toCoinbaseSmartAccount,
  sendUserOperation,
  waitForUserOperationReceipt,
  type ToCoinbaseSmartAccountReturnType,
  type BundlerClient,
} from "viem/account-abstraction";

// ---- ABI fragments for MultiOwnable ----

const multiOwnableAbi = [
  {
    name: "addOwnerAddress",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [{ name: "owner", type: "address" }],
    outputs: [],
  },
  {
    name: "removeOwnerAtIndex",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "index", type: "uint256" },
      { name: "owner", type: "bytes" },
    ],
    outputs: [],
  },
  {
    name: "isOwnerAddress",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    name: "ownerAtIndex",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "index", type: "uint256" }],
    outputs: [{ name: "", type: "bytes" }],
  },
  {
    name: "nextOwnerIndex",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    name: "ownerCount",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

// ---- Read helpers ----

export async function isOwnerAddress(
  client: ReadPublicClient,
  walletAddress: Address,
  owner: Address,
): Promise<boolean> {
  return client.readContract({
    address: walletAddress,
    abi: multiOwnableAbi,
    functionName: "isOwnerAddress",
    args: [owner],
  });
}

export async function getNextOwnerIndex(
  client: ReadPublicClient,
  walletAddress: Address,
): Promise<bigint> {
  return client.readContract({
    address: walletAddress,
    abi: multiOwnableAbi,
    functionName: "nextOwnerIndex",
    args: [],
  });
}

export async function getOwnerCount(
  client: ReadPublicClient,
  walletAddress: Address,
): Promise<bigint> {
  return client.readContract({
    address: walletAddress,
    abi: multiOwnableAbi,
    functionName: "ownerCount",
    args: [],
  });
}

export async function getOwnerAtIndex(
  client: ReadPublicClient,
  walletAddress: Address,
  index: bigint,
): Promise<string> {
  const data = await client.readContract({
    address: walletAddress,
    abi: multiOwnableAbi,
    functionName: "ownerAtIndex",
    args: [index],
  });
  return data as string;
}

/**
 * Find the owner index for a given address by scanning all owner slots.
 * Returns the index or throws if the address is not found.
 */
export async function findOwnerIndex(
  client: ReadPublicClient,
  walletAddress: Address,
  ownerAddress: Address,
): Promise<bigint> {
  const nextIndex = await getNextOwnerIndex(client, walletAddress);
  const normalizedTarget = getAddress(ownerAddress).toLowerCase();

  for (let i = 0n; i < nextIndex; i++) {
    try {
      const ownerBytes = await getOwnerAtIndex(client, walletAddress, i);
      // ABI-encoded address is 32 bytes (left-padded with zeros)
      if (ownerBytes && ownerBytes.length === 66) {
        // 0x + 64 hex chars
        const decoded = getAddress(`0x${ownerBytes.slice(26)}`).toLowerCase();
        if (decoded === normalizedTarget) {
          return i;
        }
      }
    } catch {
      // Slot may be empty (removed owner) — skip
      continue;
    }
  }

  throw new Error(
    `Owner ${ownerAddress} not found in wallet ${walletAddress} (scanned indices 0..${nextIndex - 1n})`,
  );
}

// ---- Migration ----

export interface MigrationInput {
  /** The smart wallet address being migrated */
  walletAddress: Address;
  /** The current (compromised) owner's viem account */
  currentOwnerAccount: PrivateKeyAccount;
  /** The new owner's viem account */
  newOwnerAccount: PrivateKeyAccount;
  /** Public client for reading chain state */
  publicClient: ReadPublicClient;
  /** Function to create a sponsored bundler client for a given smart account */
  createBundler: (account: ToCoinbaseSmartAccountReturnType) => BundlerClient;
}

export interface MigrationResult {
  step1_addOwner: {
    userOpHash: `0x${string}`;
    txHash: `0x${string}`;
  };
  step2_removeOwner: {
    userOpHash: `0x${string}`;
    txHash: `0x${string}`;
  };
  newOwner: Address;
  removedOwner: Address;
  removedAtIndex: bigint;
}

/**
 * Migrate a CoinbaseSmartWallet from currentOwner to newOwner.
 *
 * Step 1: Using the current owner's key, add the new owner address.
 * Step 2: Using the new owner's key, remove the old owner at its index.
 *
 * After completion, only the new owner controls the wallet.
 */
export async function migrateSmartWalletOwner(
  input: MigrationInput,
): Promise<MigrationResult> {
  const { walletAddress, currentOwnerAccount, newOwnerAccount, publicClient, createBundler } =
    input;

  // ---- Pre-flight checks ----
  const currentIsOwner = await isOwnerAddress(
    publicClient,
    walletAddress,
    currentOwnerAccount.address,
  );
  if (!currentIsOwner) {
    throw new Error(
      `Current account ${currentOwnerAccount.address} is not an owner of wallet ${walletAddress}`,
    );
  }

  const newIsAlreadyOwner = await isOwnerAddress(
    publicClient,
    walletAddress,
    newOwnerAccount.address,
  );
  if (newIsAlreadyOwner) {
    throw new Error(
      `New account ${newOwnerAccount.address} is already an owner of wallet ${walletAddress}. ` +
        `If you just need to remove the old owner, call removeOwnerAtIndex directly.`,
    );
  }

  // Find the old owner's index BEFORE adding the new one
  const oldOwnerIndex = await findOwnerIndex(
    publicClient,
    walletAddress,
    currentOwnerAccount.address,
  );
  const oldOwnerBytes = encodedAddress(currentOwnerAccount.address);

  // ---- Step 1: Add new owner (signed by current/compromised owner) ----
  const smartAccountAsCurrentOwner = await toCoinbaseSmartAccount({
    client: publicClient,
    owners: [currentOwnerAccount],
    address: walletAddress,
    version: "1.1",
  });

  const addOwnerData = encodeFunctionData({
    abi: multiOwnableAbi,
    functionName: "addOwnerAddress",
    args: [newOwnerAccount.address],
  });

  const bundlerCurrent = createBundler(smartAccountAsCurrentOwner);
  const addOpHash = await sendUserOperation(bundlerCurrent, {
    account: smartAccountAsCurrentOwner,
    calls: [{ to: walletAddress, data: addOwnerData, value: 0n }],
  });

  const addReceipt = await waitForUserOperationReceipt(bundlerCurrent, {
    hash: addOpHash,
    timeout: 120_000,
  });

  if (addReceipt.success === false) {
    throw new Error(`Step 1 (addOwnerAddress) UserOp reverted: ${addOpHash}`);
  }

  // Verify the new owner was actually added
  const newIsOwnerNow = await isOwnerAddress(publicClient, walletAddress, newOwnerAccount.address);
  if (!newIsOwnerNow) {
    throw new Error(
      `Step 1 completed but new owner ${newOwnerAccount.address} is not recognized. ` +
        `Transaction may have reverted silently.`,
    );
  }

  // ---- Step 2: Remove old owner (signed by new owner) ----
  const smartAccountAsNewOwner = await toCoinbaseSmartAccount({
    client: publicClient,
    owners: [newOwnerAccount],
    address: walletAddress,
    version: "1.1",
  });

  const removeOwnerData = encodeFunctionData({
    abi: multiOwnableAbi,
    functionName: "removeOwnerAtIndex",
    args: [oldOwnerIndex, oldOwnerBytes],
  });

  const bundlerNew = createBundler(smartAccountAsNewOwner);
  const removeOpHash = await sendUserOperation(bundlerNew, {
    account: smartAccountAsNewOwner,
    calls: [{ to: walletAddress, data: removeOwnerData, value: 0n }],
  });

  const removeReceipt = await waitForUserOperationReceipt(bundlerNew, {
    hash: removeOpHash,
    timeout: 120_000,
  });

  if (removeReceipt.success === false) {
    throw new Error(
      `Step 2 (removeOwnerAtIndex) UserOp reverted: ${removeOpHash}. ` +
        `WARNING: New owner was added but old owner was NOT removed!`,
    );
  }

  // Verify old owner is gone
  const oldStillOwner = await isOwnerAddress(
    publicClient,
    walletAddress,
    currentOwnerAccount.address,
  );
  if (oldStillOwner) {
    throw new Error(
      `Step 2 completed but old owner ${currentOwnerAccount.address} is still recognized. ` +
        `Manual intervention required.`,
    );
  }

  return {
    step1_addOwner: {
      userOpHash: addOpHash,
      txHash: addReceipt.receipt.transactionHash,
    },
    step2_removeOwner: {
      userOpHash: removeOpHash,
      txHash: removeReceipt.receipt.transactionHash,
    },
    newOwner: newOwnerAccount.address,
    removedOwner: currentOwnerAccount.address,
    removedAtIndex: oldOwnerIndex,
  };
}

/** ABI-encode an address as 32 bytes (matching MultiOwnable's storage format) */
function encodedAddress(addr: Address): `0x${string}` {
  return `0x${addr.slice(2).toLowerCase().padStart(64, "0")}`;
}
