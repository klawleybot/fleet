/**
 * Deploy a CREATOR COIN (not content coin) via the factory's deployCreatorCoin().
 *
 * Uses: Pimlico-sponsored UserOp through the Coinbase Smart Wallet.
 */
import {
  type Address,
  type Hex,
  type Log,
  createPublicClient,
  http,
  encodeFunctionData,
  parseEventLogs,
  zeroHash,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";
import { toCoinbaseSmartAccount } from "viem/account-abstraction";
import { getCreatorCoinPoolConfig, setApiKey } from "@zoralabs/coins-sdk";
import { createSponsoredBundlerClient } from "../src/services/bundler/config.js";

const SMART_WALLET = "0x097677d3e2cde65af10be80ae5e67b8b68eb613d" as Address;
const FACTORY = "0x777777751622c0d3258f214F9DF38E35BF45baF3" as Address;

// deployCreatorCoin ABI
const deployCreatorCoinAbi = [{
  type: "function",
  name: "deployCreatorCoin",
  inputs: [
    { name: "payoutRecipient", type: "address" },
    { name: "owners", type: "address[]" },
    { name: "uri", type: "string" },
    { name: "name", type: "string" },
    { name: "symbol", type: "string" },
    { name: "poolConfig", type: "bytes" },
    { name: "platformReferrer", type: "address" },
    { name: "coinSalt", type: "bytes32" },
  ],
  outputs: [{ name: "", type: "address" }],
  stateMutability: "nonpayable",
}] as const;

// CoinCreatedV4 event for parsing
const coinCreatedAbi = [{
  type: "event",
  anonymous: false,
  name: "CoinCreatedV4",
  inputs: [
    { name: "caller", type: "address", indexed: true },
    { name: "payoutRecipient", type: "address", indexed: true },
    { name: "platformReferrer", type: "address", indexed: true },
    { name: "currency", type: "address", indexed: false },
    { name: "uri", type: "string", indexed: false },
    { name: "name", type: "string", indexed: false },
    { name: "symbol", type: "string", indexed: false },
    { name: "coin", type: "address", indexed: false },
    {
      name: "poolKey",
      type: "tuple",
      components: [
        { name: "currency0", type: "address" },
        { name: "currency1", type: "address" },
        { name: "fee", type: "uint24" },
        { name: "tickSpacing", type: "int24" },
        { name: "hooks", type: "address" },
      ],
      indexed: false,
    },
    { name: "poolKeyHash", type: "bytes32", indexed: false },
    { name: "version", type: "string", indexed: false },
  ],
}] as const;

async function main() {
  const privateKeyRaw = process.env.ZORA_PRIVATE_KEY;
  if (!privateKeyRaw) { console.error("❌ ZORA_PRIVATE_KEY not set"); process.exit(1); }
  if (process.env.ZORA_API_KEY) setApiKey(process.env.ZORA_API_KEY);

  const privateKey = (privateKeyRaw.startsWith("0x") ? privateKeyRaw : `0x${privateKeyRaw}`) as Hex;
  const account = privateKeyToAccount(privateKey);

  const NAME = "Klawley";
  const SYMBOL = "openklaw";
  const METADATA_URI = "ipfs://bafybeiayd563azte4db7eyv7daayraftt4i2bwqujc6oxgeyqs5ilh4s4i";

  console.log("🦞 Creator Coin Deployment (deployCreatorCoin)");
  console.log("─".repeat(50));
  console.log(`  Name:         ${NAME}`);
  console.log(`  Symbol:       $${SYMBOL}`);
  console.log(`  Metadata:     ${METADATA_URI}`);
  console.log(`  EOA:          ${account.address}`);
  console.log(`  Smart Wallet: ${SMART_WALLET}`);
  console.log(`  Factory:      ${FACTORY}`);
  console.log("─".repeat(50));

  // 1. Get creator coin pool config from Zora API
  console.log("\n📊 Fetching creator coin pool config...");
  const poolConfigResult = await getCreatorCoinPoolConfig({ query: {} });
  const encodedConfig = poolConfigResult.data?.creatorCoinPoolConfig?.encodedConfig;
  if (!encodedConfig) {
    console.error("❌ Failed to get pool config");
    process.exit(1);
  }
  console.log(`  Currency: ${poolConfigResult.data?.creatorCoinPoolConfig?.currency}`);
  console.log(`  Config length: ${encodedConfig.length} chars`);

  // 2. Build calldata for deployCreatorCoin
  const calldata = encodeFunctionData({
    abi: deployCreatorCoinAbi,
    functionName: "deployCreatorCoin",
    args: [
      SMART_WALLET,                    // payoutRecipient
      [SMART_WALLET],                  // owners
      METADATA_URI,                    // uri
      NAME,                            // name
      SYMBOL,                          // symbol
      encodedConfig as Hex,            // poolConfig
      "0x0000000000000000000000000000000000000000" as Address, // platformReferrer
      zeroHash,                        // coinSalt (0 = no deterministic deploy)
    ],
  });

  console.log("\n🔗 Calldata built, setting up smart wallet + bundler...");

  // 3. Set up smart wallet + Pimlico bundler
  const publicClient = createPublicClient({ chain: base, transport: http() });

  const smartAccount = await toCoinbaseSmartAccount({
    client: publicClient,
    owners: [account],
    address: SMART_WALLET,
  });

  const bundlerClient = createSponsoredBundlerClient({
    account: smartAccount,
    chain: base,
    client: publicClient,
  });

  // 4. Send UserOp
  console.log("🚀 Sending deployCreatorCoin as sponsored UserOp...");

  const userOpHash = await bundlerClient.sendUserOperation({
    calls: [{
      to: FACTORY,
      data: calldata,
      value: 0n,
    }],
  });

  console.log(`  UserOp hash: ${userOpHash}`);
  console.log("  Waiting for receipt...");

  const receipt = await bundlerClient.waitForUserOperationReceipt({ hash: userOpHash });

  if (!receipt.success) {
    console.error("❌ UserOp failed!");
    console.error(receipt);
    process.exit(1);
  }

  // 5. Parse CoinCreatedV4 event
  const events = parseEventLogs({
    abi: coinCreatedAbi,
    logs: receipt.receipt.logs as Log[],
  });

  const created = events.find(e => e.eventName === "CoinCreatedV4");

  console.log("\n🎉 CREATOR COIN DEPLOYED!");
  console.log("─".repeat(50));
  console.log(`  Coin Address: ${created?.args?.coin || "check tx"}`);
  console.log(`  TX Hash:      ${receipt.receipt.transactionHash}`);
  console.log(`  View on Zora: https://zora.co/coin/base:${(created?.args?.coin || "").toLowerCase()}`);
  console.log(`  BaseScan:     https://basescan.org/tx/${receipt.receipt.transactionHash}`);
}

main().catch((err) => {
  console.error("❌ Failed:", err);
  process.exit(1);
});
