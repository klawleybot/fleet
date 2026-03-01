/**
 * Daily Content Coin — Klawley's daily commentary on the degen trenches.
 *
 * Flow:
 * 1. Fetch trending/top coins from zora-intelligence
 * 2. Generate a roast/commentary + image prompt
 * 3. Generate image via OpenAI
 * 4. Upload image + metadata to Zora IPFS
 * 5. Deploy content coin backed by creator coin ($openklaw)
 * 6. Post to Discord
 *
 * This script is designed to be called by the agent via cron,
 * NOT run standalone — the agent handles image gen + Discord posting.
 */

import { setApiKey, createMetadataBuilder, createZoraUploaderForCreator } from "@zoralabs/coins-sdk";
import { readFileSync, existsSync } from "fs";
import type { Address, Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { createPublicClient, http, encodeFunctionData, zeroHash, type Log, parseEventLogs } from "viem";
import { base } from "viem/chains";
import { toCoinbaseSmartAccount } from "viem/account-abstraction";
import { createSponsoredBundlerClient } from "../src/services/bundler/config.js";
import { getContentCoinPoolConfig } from "@zoralabs/coins-sdk";

const SMART_WALLET = "0x097677d3e2cde65af10be80ae5e67b8b68eb613d" as Address;
const CREATOR_COIN = "0x2e6e49e3f1c76d9b8c7ca0bee2005ed6de0e2046" as Address;
const FACTORY = "0x777777751622c0d3258f214F9DF38E35BF45baF3" as Address;

const deployAbi = [{
  type: "function",
  name: "deploy",
  inputs: [
    { name: "payoutRecipient", type: "address" },
    { name: "owners", type: "address[]" },
    { name: "uri", type: "string" },
    { name: "name", type: "string" },
    { name: "symbol", type: "string" },
    { name: "poolConfig", type: "bytes" },
    { name: "platformReferrer", type: "address" },
    { name: "", type: "uint256" },
  ],
  outputs: [
    { name: "", type: "address" },
    { name: "", type: "uint256" },
  ],
  stateMutability: "payable",
}] as const;

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
    { name: "poolKey", type: "tuple", components: [
      { name: "currency0", type: "address" },
      { name: "currency1", type: "address" },
      { name: "fee", type: "uint24" },
      { name: "tickSpacing", type: "int24" },
      { name: "hooks", type: "address" },
    ], indexed: false },
    { name: "poolKeyHash", type: "bytes32", indexed: false },
    { name: "version", type: "string", indexed: false },
  ],
}] as const;

interface ContentCoinParams {
  name: string;
  symbol: string;
  description: string;
  imagePath: string;
}

async function deployContentCoin(params: ContentCoinParams): Promise<{
  coinAddress: string;
  txHash: string;
  metadataURI: string;
}> {
  const privateKeyRaw = process.env.ZORA_PRIVATE_KEY;
  if (!privateKeyRaw) throw new Error("ZORA_PRIVATE_KEY not set");
  if (!process.env.ZORA_API_KEY) throw new Error("ZORA_API_KEY not set");

  setApiKey(process.env.ZORA_API_KEY);

  const privateKey = (privateKeyRaw.startsWith("0x") ? privateKeyRaw : `0x${privateKeyRaw}`) as Hex;
  const account = privateKeyToAccount(privateKey);

  // 1. Upload image + metadata
  console.log("📤 Uploading metadata to Zora IPFS...");
  const imageBytes = readFileSync(params.imagePath);
  const ext = params.imagePath.split(".").pop() || "png";
  const imageFile = new File([imageBytes], `content-coin.${ext}`, {
    type: ext === "jpg" || ext === "jpeg" ? "image/jpeg" : `image/${ext}`,
  });

  const uploadResult = await createMetadataBuilder()
    .withName(params.name)
    .withSymbol(params.symbol)
    .withDescription(params.description)
    .withImage(imageFile)
    .upload(createZoraUploaderForCreator(SMART_WALLET));

  const metadataURI = uploadResult.url;
  console.log("✅ Metadata URI:", metadataURI);

  // 2. Get content coin pool config (backed by creator coin)
  console.log("📊 Fetching content coin pool config (backed by $openklaw)...");
  const poolConfigResult = await getContentCoinPoolConfig({
    query: {
      creatorCoin: CREATOR_COIN,
      chainId: 8453,
    },
  });

  const encodedConfig = poolConfigResult.data?.contentCoinPoolConfig?.encodedConfig;
  if (!encodedConfig) throw new Error("Failed to get content coin pool config");

  console.log("  Currency:", poolConfigResult.data?.contentCoinPoolConfig?.currency);

  // 3. Build calldata
  const calldata = encodeFunctionData({
    abi: deployAbi,
    functionName: "deploy",
    args: [
      SMART_WALLET,
      [SMART_WALLET],
      metadataURI,
      params.name,
      params.symbol,
      encodedConfig as Hex,
      "0x0000000000000000000000000000000000000000" as Address,
      0n,
    ],
  });

  // 4. Send via Pimlico-sponsored UserOp
  console.log("🚀 Deploying content coin...");
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

  const userOpHash = await bundlerClient.sendUserOperation({
    calls: [{ to: FACTORY, data: calldata, value: 0n }],
  });

  console.log("  UserOp:", userOpHash);
  const receipt = await bundlerClient.waitForUserOperationReceipt({ hash: userOpHash });

  if (!receipt.success) throw new Error(`UserOp failed: ${userOpHash}`);

  // 5. Parse coin address
  const events = parseEventLogs({ abi: coinCreatedAbi, logs: receipt.receipt.logs as Log[] });
  const created = events.find(e => e.eventName === "CoinCreatedV4");
  const coinAddress = created?.args?.coin || "unknown";

  console.log("🎉 Content coin deployed!");
  console.log("  Address:", coinAddress);
  console.log("  TX:", receipt.receipt.transactionHash);
  console.log("  Zora:", `https://zora.co/coin/base:${coinAddress.toLowerCase()}`);

  return {
    coinAddress,
    txHash: receipt.receipt.transactionHash,
    metadataURI,
  };
}

// When run directly, expect params as JSON on stdin or env
async function main() {
  const name = process.env.COIN_NAME;
  const symbol = process.env.COIN_SYMBOL;
  const description = process.env.COIN_DESCRIPTION;
  const imagePath = process.env.COIN_IMAGE_PATH;

  if (!name || !symbol || !description || !imagePath) {
    console.error("Required env: COIN_NAME, COIN_SYMBOL, COIN_DESCRIPTION, COIN_IMAGE_PATH");
    process.exit(1);
  }

  if (!existsSync(imagePath)) {
    console.error(`Image not found: ${imagePath}`);
    process.exit(1);
  }

  const result = await deployContentCoin({ name, symbol, description, imagePath });
  console.log(JSON.stringify(result));
}

main().catch((err) => {
  console.error("❌ Failed:", err);
  process.exit(1);
});
