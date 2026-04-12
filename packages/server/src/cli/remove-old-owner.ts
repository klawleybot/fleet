/**
 * Step 2 only: Remove the old owner from a wallet where the new owner is already added.
 */
import { createPublicClient, http, encodeFunctionData } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { toCoinbaseSmartAccount, sendUserOperation, waitForUserOperationReceipt, createBundlerClient } from "viem/account-abstraction";
import { base } from "viem/chains";
import { logger } from "../logger.js";
import { createSponsoredBundlerClient } from "../services/bundler/config.js";
import { isOwnerAddress, findOwnerIndex } from "../services/walletMigration.js";

const multiOwnableAbi = [
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
] as const;

async function main() {
  const walletAddress = "0x0bc571f8887ee177f8923176030b2e3f60a76f20";
  const oldOwnerAddress = "0xA53581B8Ad325a2a3aF011bCE1b8322AbbaD762c";

  const newKey = process.env.COINOLOGY_PRIVATE_KEY;
  if (!newKey) {
    throw new Error("COINOLOGY_PRIVATE_KEY is required");
  }
  const normalizedKey = newKey.startsWith("0x") ? newKey : `0x${newKey}`;
  const newAccount = privateKeyToAccount(normalizedKey);

  const rpcUrl = process.env.BASE_RPC_URL || "https://mainnet.base.org";
  const publicClient = createPublicClient({ chain: base, transport: http(rpcUrl) });
  const bundlerCompatClient = publicClient as unknown as NonNullable<Parameters<typeof createBundlerClient>[0]["client"]>;

  logger.info({ newOwner: newAccount.address }, "New owner signing");

  const newIsOwner = await isOwnerAddress(publicClient, walletAddress, newAccount.address);
  logger.info({ newIsOwner }, "New owner ownership check");
  if (!newIsOwner) {
    console.error("❌ New owner is not an owner, cannot sign removal");
    process.exit(1);
  }

  const oldIdx = await findOwnerIndex(publicClient, walletAddress, oldOwnerAddress);
  logger.info({ oldOwnerIndex: oldIdx.toString() }, "Old owner index");

  const oldOwnerBytes = `0x${oldOwnerAddress.slice(2).toLowerCase().padStart(64, "0")}` as const;

  const smartAccount = await toCoinbaseSmartAccount({
    client: publicClient,
    owners: [newAccount],
    address: walletAddress,
    ownerIndex: 1,
    version: "1.1",
  });

  const removeData = encodeFunctionData({
    abi: multiOwnableAbi,
    functionName: "removeOwnerAtIndex",
    args: [oldIdx, oldOwnerBytes],
  });

  logger.info("Sending removeOwnerAtIndex UserOp");

  const bundler = createSponsoredBundlerClient({
    account: smartAccount,
    chain: base,
    client: bundlerCompatClient,
  });

  const opHash = await sendUserOperation(bundler, {
    account: smartAccount,
    calls: [{ to: walletAddress, data: removeData, value: 0n }],
  });
  logger.info({ opHash }, "UserOp sent");

  const receipt = await waitForUserOperationReceipt(bundler, {
    hash: opHash,
    timeout: 120_000,
  });
  logger.info({ txHash: receipt.receipt.transactionHash, success: receipt.success }, "UserOp receipt");

  const oldStillOwner = await isOwnerAddress(publicClient, walletAddress, oldOwnerAddress);
  const newStillOwner = await isOwnerAddress(publicClient, walletAddress, newAccount.address);
  logger.info({ oldStillOwner, newStillOwner }, "Post-removal owner verification");

  if (!oldStillOwner && newStillOwner) {
    logger.info("Migration complete. Compromised key removed");
  }
}

main().catch((error: unknown) => {
  if (error instanceof Error) {
    console.error("💥 Failed:", error.message);
  } else {
    console.error("💥 Failed:", error);
  }
  process.exit(1);
});
