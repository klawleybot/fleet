#!/usr/bin/env tsx
/**
 * CLI: Migrate a CoinbaseSmartWallet owner from one EOA to another.
 *
 * Usage:
 *   doppler run --project openclaw --config prd -- npx tsx src/cli/migrate-wallet.ts \
 *     --wallet 0x0bc571f8887ee177f8923176030b2e3f60a76f20 \
 *     --old-key-env COINOLOGY_ORIGINAL_PRIVATE_KEY \
 *     --new-key-env COINOLOGY_PRIVATE_KEY \
 *     [--dry-run]
 */

import { createPublicClient, http, isAddress, type Address } from "viem";
import { createBundlerClient } from "viem/account-abstraction";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";
import { logger } from "../logger.js";
import { createSponsoredBundlerClient } from "../services/bundler/config.js";
import {
  isOwnerAddress,
  findOwnerIndex,
  getOwnerCount,
  getNextOwnerIndex,
  migrateSmartWalletOwner,
} from "../services/walletMigration.js";

function normalizePrivateKey(value: string): `0x${string}` {
  return value.startsWith("0x") ? value : `0x${value}`;
}

function parseArgs(): {
  walletAddress: Address;
  oldKey: `0x${string}`;
  newKey: `0x${string}`;
  dryRun: boolean;
} {
  const args = process.argv.slice(2);
  let wallet = "";
  let oldKeyEnv = "";
  let newKeyEnv = "";
  let dryRun = false;

  for (let i = 0; i < args.length; i += 1) {
    switch (args[i]) {
      case "--wallet":
        wallet = args[i + 1] ?? "";
        i += 1;
        break;
      case "--old-key-env":
        oldKeyEnv = args[i + 1] ?? "";
        i += 1;
        break;
      case "--new-key-env":
        newKeyEnv = args[i + 1] ?? "";
        i += 1;
        break;
      case "--dry-run":
        dryRun = true;
        break;
      default:
        break;
    }
  }

  if (!wallet || !oldKeyEnv || !newKeyEnv) {
    console.error(
      "Usage: migrate-wallet --wallet <addr> --old-key-env <ENV_VAR> --new-key-env <ENV_VAR> [--dry-run]",
    );
    process.exit(1);
  }
  if (!isAddress(wallet)) {
    console.error(`❌ Invalid wallet address: ${wallet}`);
    process.exit(1);
  }

  const oldKey = process.env[oldKeyEnv]?.trim();
  const newKey = process.env[newKeyEnv]?.trim();
  if (!oldKey) {
    console.error(`❌ Environment variable ${oldKeyEnv} is not set`);
    process.exit(1);
  }
  if (!newKey) {
    console.error(`❌ Environment variable ${newKeyEnv} is not set`);
    process.exit(1);
  }

  return {
    walletAddress: wallet,
    oldKey: normalizePrivateKey(oldKey),
    newKey: normalizePrivateKey(newKey),
    dryRun,
  };
}

async function main() {
  const { walletAddress, oldKey, newKey, dryRun } = parseArgs();

  const rpcUrl = process.env.BASE_RPC_URL || "https://mainnet.base.org";
  const publicClient = createPublicClient({
    chain: base,
    transport: http(rpcUrl),
  });
  const bundlerCompatClient = publicClient as unknown as NonNullable<Parameters<typeof createBundlerClient>[0]["client"]>;

  const oldAccount = privateKeyToAccount(oldKey);
  const newAccount = privateKeyToAccount(newKey);

  logger.warn(
    {
      walletAddress,
      oldOwner: oldAccount.address,
      newOwner: newAccount.address,
      mode: dryRun ? "dry-run" : "live",
    },
    "smart wallet owner migration",
  );

  const oldIsOwner = await isOwnerAddress(publicClient, walletAddress, oldAccount.address);
  const newIsOwner = await isOwnerAddress(publicClient, walletAddress, newAccount.address);
  const ownerCount = await getOwnerCount(publicClient, walletAddress);
  const nextIndex = await getNextOwnerIndex(publicClient, walletAddress);

  logger.info(
    {
      oldIsOwner,
      newIsOwner,
      ownerCount: ownerCount.toString(),
      nextIndex: nextIndex.toString(),
    },
    "pre-flight checks",
  );

  if (oldIsOwner) {
    const oldIdx = await findOwnerIndex(publicClient, walletAddress, oldAccount.address);
    logger.info({ oldOwnerIndex: oldIdx.toString() }, "old owner index");
  }

  if (!oldIsOwner) {
    console.error("❌ Cannot proceed: old key is not an owner of this wallet.");
    process.exit(1);
  }

  if (newIsOwner) {
    console.error("❌ Cannot proceed: new key is already an owner. Remove the old owner manually if needed.");
    process.exit(1);
  }

  if (dryRun) {
    logger.info("dry run complete. Re-run without --dry-run to execute the migration");
    process.exit(0);
  }

  logger.info("starting wallet owner migration");

  const result = await migrateSmartWalletOwner({
    walletAddress,
    currentOwnerAccount: oldAccount,
    newOwnerAccount: newAccount,
    publicClient,
    createBundler: (account) =>
      createSponsoredBundlerClient({
        account,
        chain: base,
        client: bundlerCompatClient,
      }),
  });

  logger.info(
    {
      addOwnerUserOpHash: result.step1_addOwner.userOpHash,
      addOwnerTxHash: result.step1_addOwner.txHash,
      removeOwnerUserOpHash: result.step2_removeOwner.userOpHash,
      removeOwnerTxHash: result.step2_removeOwner.txHash,
      removedAtIndex: result.removedAtIndex,
      newOwner: result.newOwner,
      removedOwner: result.removedOwner,
    },
    "migration complete",
  );

  const finalOldIsOwner = await isOwnerAddress(publicClient, walletAddress, oldAccount.address);
  const finalNewIsOwner = await isOwnerAddress(publicClient, walletAddress, newAccount.address);
  logger.info({ finalOldIsOwner, finalNewIsOwner }, "post-migration verification");

  if (finalOldIsOwner || !finalNewIsOwner) {
    console.error("⚠️ Post-migration verification failed. Manual intervention may be needed.");
    process.exit(1);
  }

  logger.info("migration successful. compromised key removed");
}

main().catch((error: unknown) => {
  if (error instanceof Error) {
    console.error("💥 Migration failed:", error.message);
  } else {
    console.error("💥 Migration failed:", error);
  }
  process.exit(1);
});
