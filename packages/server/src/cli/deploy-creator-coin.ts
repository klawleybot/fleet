#!/usr/bin/env tsx
/**
 * CLI to deploy a Creator Coin on Zora.
 *
 * Usage:
 *   doppler run --config prd -- npx tsx src/cli/deploy-creator-coin.ts \
 *     --name "Klawley" \
 *     --symbol "KLAW" \
 *     --description "Sarcastic silicon with a caffeine deficit" \
 *     --image-uri "ipfs://Qm..." \
 *     [--image-file ./path/to/image.png] \
 *     [--dry-run]
 *
 * Required env:
 *   ZORA_PRIVATE_KEY — EOA private key that controls the smart wallet
 *
 * The smart wallet address is derived from the Zora account setup.
 */

import { parseArgs } from "node:util";
import type { Address, Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { createPublicClient, http } from "viem";
import { base } from "viem/chains";

const SMART_WALLET = "0x097677d3e2cde65af10be80ae5e67b8b68eb613d" as Address;

const { values } = parseArgs({
  options: {
    name: { type: "string" },
    symbol: { type: "string" },
    description: { type: "string", default: "" },
    "metadata-uri": { type: "string" },
    "dry-run": { type: "boolean", default: false },
    "chain-id": { type: "string", default: "8453" },
  },
  strict: true,
});

async function main() {
  const privateKeyRaw = process.env.ZORA_PRIVATE_KEY;
  if (!privateKeyRaw) {
    console.error("❌ ZORA_PRIVATE_KEY env var not set");
    process.exit(1);
  }

  const privateKey = (privateKeyRaw.startsWith("0x") ? privateKeyRaw : `0x${privateKeyRaw}`) as Hex;
  const account = privateKeyToAccount(privateKey);

  if (!values.name || !values.symbol) {
    console.error("❌ --name and --symbol are required");
    process.exit(1);
  }

  const chainId = Number(values["chain-id"]);
  const metadataURI = values["metadata-uri"] || "";

  console.log("🦞 Creator Coin Deployment");
  console.log("─".repeat(40));
  console.log(`  Name:         ${values.name}`);
  console.log(`  Symbol:       $${values.symbol}`);
  console.log(`  Description:  ${values.description || "(none)"}`);
  console.log(`  Metadata URI: ${metadataURI || "(none — will use placeholder for dry run)"}`);
  console.log(`  Chain:        ${chainId === 8453 ? "Base" : `Chain ${chainId}`}`);
  console.log(`  EOA Signer:   ${account.address}`);
  console.log(`  Smart Wallet: ${SMART_WALLET}`);
  console.log(`  Gas:          Pimlico sponsored (no ETH needed)`);
  console.log(`  Dry Run:      ${values["dry-run"]}`);
  console.log("─".repeat(40));

  // Verify EOA is owner of smart wallet
  const publicClient = createPublicClient({ chain: base, transport: http() });
  const isOwner = await publicClient.readContract({
    address: SMART_WALLET,
    abi: [{
      name: "isOwnerAddress",
      type: "function",
      stateMutability: "view",
      inputs: [{ name: "account", type: "address" }],
      outputs: [{ name: "", type: "bool" }],
    }],
    functionName: "isOwnerAddress",
    args: [account.address],
  });

  if (!isOwner) {
    console.error(`❌ EOA ${account.address} is NOT an owner of smart wallet ${SMART_WALLET}`);
    process.exit(1);
  }
  console.log("✅ EOA confirmed as smart wallet owner");

  if (values["dry-run"]) {
    console.log("\n🔍 Dry run — fetching predicted address...");

    const { getCreatorCoinCalldata } = await import("../services/creatorCoin.js");
    const data = await getCreatorCoinCalldata({
      creator: SMART_WALLET,
      name: values.name,
      symbol: values.symbol,
      metadataURI: metadataURI || "ipfs://placeholder",
      chainId,
    });

    console.log(`\n✅ Dry run successful!`);
    console.log(`  Predicted coin address: ${data.predictedCoinAddress}`);
    console.log(`  Smart wallet routing:   ${data.usedSmartWalletRouting}`);
    console.log(`  # of calls:             ${data.calls.length}`);
    console.log(`  Target:                 ${data.calls[0]?.to}`);
    console.log(`  Value:                  ${data.calls[0]?.value} wei`);
    return;
  }

  // Real deployment
  if (!metadataURI) {
    console.error("❌ --metadata-uri is required for deployment (ipfs:// or https:// to metadata JSON)");
    process.exit(1);
  }

  const { deployCreatorCoin } = await import("../services/creatorCoin.js");

  const result = await deployCreatorCoin(
    {
      creator: SMART_WALLET,
      metadata: {
        name: values.name,
        symbol: values.symbol,
        description: values.description || "",
        metadataURI,
      },
      chainId,
    },
    privateKey,
  );

  console.log("\n🎉 Creator Coin deployed!");
  console.log("─".repeat(40));
  console.log(`  Coin Address:      ${result.coinAddress}`);
  console.log(`  Predicted Address: ${result.predictedAddress}`);
  console.log(`  TX Hash:           ${result.txHash}`);
  console.log(`  View on Zora:      https://zora.co/coin/base:${result.coinAddress.toLowerCase()}`);
}

main().catch((err) => {
  console.error("❌ Deployment failed:", err);
  process.exit(1);
});
