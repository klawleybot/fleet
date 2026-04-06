/**
 * Step 2 only: Remove the old owner from a wallet where the new owner is already added.
 */
import { createPublicClient, http, encodeFunctionData } from "viem";
import type { PublicClient as ReadPublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { toCoinbaseSmartAccount, sendUserOperation, waitForUserOperationReceipt, createBundlerClient } from "viem/account-abstraction";
import { base } from "viem/chains";
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
  const walletAddress = "0x0bc571f8887ee177f8923176030b2e3f60a76f20" as `0x${string}`;
  const oldOwnerAddress = "0xA53581B8Ad325a2a3aF011bCE1b8322AbbaD762c" as `0x${string}`;

  const newKey = process.env.COINOLOGY_PRIVATE_KEY!;
  const newAccount = privateKeyToAccount((newKey.startsWith("0x") ? newKey : `0x${newKey}`) as `0x${string}`);

  const rpcUrl = process.env.BASE_RPC_URL || "https://mainnet.base.org";
  const publicClient = createPublicClient({ chain: base, transport: http(rpcUrl) });
  const readClient = publicClient as ReadPublicClient;
  const bundlerCompatClient = publicClient as unknown as NonNullable<Parameters<typeof createBundlerClient>[0]["client"]>;

  console.log("New owner signing:", newAccount.address);

  // Verify new owner IS an owner (required to sign the removal)
  const newIsOwner = await isOwnerAddress(readClient, walletAddress, newAccount.address);
  console.log("New owner is owner:", newIsOwner);
  if (!newIsOwner) {
    console.error("❌ New owner is not an owner — cannot sign removal");
    process.exit(1);
  }

  // Find old owner index
  const oldIdx = await findOwnerIndex(readClient, walletAddress, oldOwnerAddress);
  console.log("Old owner at index:", oldIdx.toString());

  const oldOwnerBytes = `0x${oldOwnerAddress.slice(2).toLowerCase().padStart(64, "0")}` as `0x${string}`;

  // Build smart account as new owner (index 1 — added in step 1)
  const smartAccount = await toCoinbaseSmartAccount({
    client: readClient,
    owners: [newAccount],
    address: walletAddress,
    ownerIndex: 1, // new owner is at index 1 (added in step 1)
    version: "1.1",
  });

  const removeData = encodeFunctionData({
    abi: multiOwnableAbi,
    functionName: "removeOwnerAtIndex",
    args: [oldIdx, oldOwnerBytes],
  });

  console.log("\n🚀 Sending removeOwnerAtIndex UserOp...");

  const bundler = createSponsoredBundlerClient({
    account: smartAccount,
    chain: base,
    client: bundlerCompatClient,
  });

  const opHash = await sendUserOperation(bundler, {
    account: smartAccount,
    calls: [{ to: walletAddress, data: removeData, value: 0n }],
  });
  console.log("UserOp hash:", opHash);

  const receipt = await waitForUserOperationReceipt(bundler, {
    hash: opHash,
    timeout: 120_000,
  });
  console.log("Tx hash:", receipt.receipt.transactionHash);
  console.log("Success:", receipt.success);

  // Verify
  const oldStillOwner = await isOwnerAddress(readClient, walletAddress, oldOwnerAddress);
  console.log("\nOld owner still owns wallet:", oldStillOwner ? "❌ YES" : "✅ REMOVED");
  const newStillOwner = await isOwnerAddress(readClient, walletAddress, newAccount.address);
  console.log("New owner owns wallet:", newStillOwner ? "✅ YES" : "❌ NO");

  if (!oldStillOwner && newStillOwner) {
    console.log("\n🎉 Migration complete! Compromised key removed.");
  }
}

main().catch((e) => {
  console.error("💥 Failed:", e.message);
  process.exit(1);
});
