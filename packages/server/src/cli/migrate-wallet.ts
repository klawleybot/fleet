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

import { createPublicClient, http, type Address } from "viem";
import type { PublicClient as ReadPublicClient } from "viem";
import { createBundlerClient } from "viem/account-abstraction";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";
import { createSponsoredBundlerClient } from "../services/bundler/config.js";
import {
  isOwnerAddress,
  findOwnerIndex,
  getOwnerCount,
  getNextOwnerIndex,
  migrateSmartWalletOwner,
} from "../services/walletMigration.js";

// ---- Parse args ----

function parseArgs() {
  const args = process.argv.slice(2);
  let wallet = "";
  let oldKeyEnv = "";
  let newKeyEnv = "";
  let dryRun = false;

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--wallet":
        wallet = args[++i] ?? "";
        break;
      case "--old-key-env":
        oldKeyEnv = args[++i] ?? "";
        break;
      case "--new-key-env":
        newKeyEnv = args[++i] ?? "";
        break;
      case "--dry-run":
        dryRun = true;
        break;
    }
  }

  if (!wallet || !oldKeyEnv || !newKeyEnv) {
    console.error(
      "Usage: migrate-wallet --wallet <addr> --old-key-env <ENV_VAR> --new-key-env <ENV_VAR> [--dry-run]",
    );
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
    walletAddress: wallet as Address,
    oldKey: (oldKey.startsWith("0x") ? oldKey : `0x${oldKey}`) as `0x${string}`,
    newKey: (newKey.startsWith("0x") ? newKey : `0x${newKey}`) as `0x${string}`,
    dryRun,
  };
}

// ---- Main ----

async function main() {
  const { walletAddress, oldKey, newKey, dryRun } = parseArgs();

  const rpcUrl = process.env.BASE_RPC_URL || "https://mainnet.base.org";
  const publicClient = createPublicClient({
    chain: base,
    transport: http(rpcUrl),
  });
  const readClient = publicClient as ReadPublicClient;
  const bundlerCompatClient = publicClient as unknown as NonNullable<Parameters<typeof createBundlerClient>[0]["client"]>;

  const oldAccount = privateKeyToAccount(oldKey);
  const newAccount = privateKeyToAccount(newKey);

  console.log("╔══════════════════════════════════════════════════════════╗");
  console.log("║           SMART WALLET OWNER MIGRATION                 ║");
  console.log("╠══════════════════════════════════════════════════════════╣");
  console.log(`║ Wallet:      ${walletAddress}`);
  console.log(`║ Old Owner:   ${oldAccount.address}`);
  console.log(`║ New Owner:   ${newAccount.address}`);
  console.log(`║ Mode:        ${dryRun ? "🔍 DRY RUN" : "⚠️  LIVE MIGRATION"}`);
  console.log("╚══════════════════════════════════════════════════════════╝");
  console.log();

  // ---- Pre-flight diagnostics ----
  console.log("📋 Pre-flight checks...");

  const oldIsOwner = await isOwnerAddress(readClient, walletAddress, oldAccount.address);
  console.log(`  Old owner is current owner: ${oldIsOwner ? "✅ YES" : "❌ NO"}`);

  const newIsOwner = await isOwnerAddress(readClient, walletAddress, newAccount.address);
  console.log(`  New owner already an owner: ${newIsOwner ? "⚠️ YES" : "✅ NO"}`);

  const ownerCount = await getOwnerCount(readClient, walletAddress);
  const nextIndex = await getNextOwnerIndex(readClient, walletAddress);
  console.log(`  Owner count: ${ownerCount}, next index: ${nextIndex}`);

  if (oldIsOwner) {
    const oldIdx = await findOwnerIndex(readClient, walletAddress, oldAccount.address);
    console.log(`  Old owner index: ${oldIdx}`);
  }

  if (!oldIsOwner) {
    console.error("\n❌ Cannot proceed: old key is not an owner of this wallet.");
    process.exit(1);
  }

  if (newIsOwner) {
    console.error(
      "\n❌ Cannot proceed: new key is already an owner. Remove the old owner manually if needed.",
    );
    process.exit(1);
  }

  if (dryRun) {
    console.log("\n🔍 Dry run complete. All pre-flight checks passed.");
    console.log("   Re-run without --dry-run to execute the migration.");
    process.exit(0);
  }

  // ---- Execute migration ----
  console.log("\n🚀 Starting migration...\n");

  const result = await migrateSmartWalletOwner({
    walletAddress,
    currentOwnerAccount: oldAccount,
    newOwnerAccount: newAccount,
    publicClient: readClient,
    createBundler: (account) =>
      createSponsoredBundlerClient({
        account,
        chain: base,
        client: bundlerCompatClient,
      }),
  });

  console.log("✅ Migration complete!\n");
  console.log("Step 1 — Add new owner:");
  console.log(`  UserOp: ${result.step1_addOwner.userOpHash}`);
  console.log(`  Tx:     ${result.step1_addOwner.txHash}`);
  console.log();
  console.log("Step 2 — Remove old owner:");
  console.log(`  UserOp: ${result.step2_removeOwner.userOpHash}`);
  console.log(`  Tx:     ${result.step2_removeOwner.txHash}`);
  console.log(`  Removed at index: ${result.removedAtIndex}`);
  console.log();
  console.log(`New owner: ${result.newOwner}`);
  console.log(`Removed:   ${result.removedOwner}`);

  // ---- Post-migration verification ----
  console.log("\n📋 Post-migration verification...");
  const finalOldIsOwner = await isOwnerAddress(readClient, walletAddress, oldAccount.address);
  const finalNewIsOwner = await isOwnerAddress(readClient, walletAddress, newAccount.address);
  console.log(`  Old owner still owns wallet: ${finalOldIsOwner ? "❌ STILL OWNER" : "✅ REMOVED"}`);
  console.log(`  New owner owns wallet:       ${finalNewIsOwner ? "✅ YES" : "❌ FAILED"}`);

  if (finalOldIsOwner || !finalNewIsOwner) {
    console.error("\n⚠️  Post-migration verification failed! Manual intervention may be needed.");
    process.exit(1);
  }

  console.log("\n🎉 Migration successful. Compromised key has been removed.");
}

main().catch((err) => {
  console.error("\n💥 Migration failed:", err.message || err);
  process.exit(1);
});
