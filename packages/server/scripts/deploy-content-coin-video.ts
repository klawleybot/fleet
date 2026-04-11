/**
 * Deploy a content coin with a VIDEO (mp4) as media.
 *
 * Uses Zora SDK metadata builder with .withImage() + .withMedia() for video.
 * Deploys via Pimlico-sponsored UserOp from the openklaw smart wallet.
 * Pool config uses Zora /create/content API (correctly backs by $openklaw),
 * with optional custom Doppler curve profile override.
 *
 * Env vars:
 *   COIN_NAME, COIN_SYMBOL, COIN_DESCRIPTION
 *   COIN_IMAGE_PATH — thumbnail image
 *   COIN_VIDEO_PATH — video file (mp4)
 *   POOL_PROFILE — optional: gradual|rocket|steep|deep (default: Zora's default)
 *   SNIPE_AMOUNT_ETH — optional: ETH to self-snipe on deploy (e.g. "0.001")
 */

import { setApiKey, createMetadataBuilder, createZoraUploaderForCreator } from "@zoralabs/coins-sdk";
import { coinFactoryABI } from "@zoralabs/protocol-deployments";
import { readFileSync, existsSync } from "fs";
import type { Address, Hex, Log } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { createPublicClient, http, encodeFunctionData, encodeAbiParameters, parseEventLogs, decodeFunctionData, zeroHash, zeroAddress, parseEther } from "viem";
import { base } from "viem/chains";
import { toCoinbaseSmartAccount } from "viem/account-abstraction";
import { createSponsoredBundlerClient } from "../src/services/bundler/config.js";
import { encodePoolConfig, extractLaunchTick, decodePoolConfig, PROFILES } from "../src/services/poolConfig.js";

const SMART_WALLET = "0x097677d3e2cde65af10be80ae5e67b8b68eb613d" as Address;
const CREATOR_COIN = "0x2e6e49e3f1c76d9b8c7ca0bee2005ed6de0e2046" as Address;
const FACTORY = "0x777777751622c0d3258f214F9DF38E35BF45baF3" as Address;

const HOOK_ADDRESS = "0xd8CC7bCA1dE52eA788829B16E375e9B96C18D433" as Address;
const DOPPLER_HOOK = "0x0469a4Bd3724DC86C9542F4694c976DA13C450c0" as Address;
const WETH = "0x4200000000000000000000000000000000000006";
const ZORA_TOKEN = "0x1111111111166b7fe7bd91427724b487980afc69";
const WETH_TO_ZORA_V3_ROUTE = `0x${WETH.slice(2)}000bb8${ZORA_TOKEN.slice(2)}` as Hex;

// V4 PoolKey: $ZORA → $openklaw (Doppler pool) — needed for self-snipe on $openklaw-backed coins
const ZORA_TO_OPENKLAW_V4_POOL_KEY = {
  currency0: ZORA_TOKEN as Address,
  currency1: CREATOR_COIN,
  fee: 8388608,      // Doppler dynamic fee flag
  tickSpacing: 200,  // Doppler standard
  hooks: DOPPLER_HOOK,
} as const;

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

async function main() {
  const name = process.env.COIN_NAME;
  const symbol = process.env.COIN_SYMBOL;
  const description = process.env.COIN_DESCRIPTION;
  const imagePath = process.env.COIN_IMAGE_PATH;
  const videoPath = process.env.COIN_VIDEO_PATH;

  if (!name || !symbol || !description || !imagePath || !videoPath) {
    console.error("Required env: COIN_NAME, COIN_SYMBOL, COIN_DESCRIPTION, COIN_IMAGE_PATH, COIN_VIDEO_PATH");
    process.exit(1);
  }
  if (!existsSync(imagePath)) { console.error(`Image not found: ${imagePath}`); process.exit(1); }
  if (!existsSync(videoPath)) { console.error(`Video not found: ${videoPath}`); process.exit(1); }

  const privateKeyRaw = process.env.ZORA_PRIVATE_KEY;
  if (!privateKeyRaw) throw new Error("ZORA_PRIVATE_KEY not set");
  if (!process.env.ZORA_API_KEY) throw new Error("ZORA_API_KEY not set");

  setApiKey(process.env.ZORA_API_KEY);

  const privateKey = (privateKeyRaw.startsWith("0x") ? privateKeyRaw : `0x${privateKeyRaw}`) as Hex;
  const account = privateKeyToAccount(privateKey);

  // 1. Upload image + video + metadata via Zora SDK
  console.log("📤 Uploading metadata (image + video)...");

  let metadataURI: string;

  try {
    const imageBytes = readFileSync(imagePath);
    const imgExt = imagePath.split(".").pop() || "jpg";
    const imageFile = new File([imageBytes], `thumbnail.${imgExt}`, {
      type: imgExt === "jpg" || imgExt === "jpeg" ? "image/jpeg" : `image/${imgExt}`,
    });

    const videoBytes = readFileSync(videoPath);
    const vidExt = videoPath.split(".").pop() || "mp4";
    const videoFile = new File([videoBytes], `content.${vidExt}`, {
      type: `video/${vidExt}`,
    });

    const uploadResult = await createMetadataBuilder()
      .withName(name)
      .withSymbol(symbol)
      .withDescription(description)
      .withImage(imageFile)
      .withMedia(videoFile)
      .upload(createZoraUploaderForCreator(SMART_WALLET));

    metadataURI = uploadResult.url;
    console.log("✅ Metadata uploaded:", metadataURI);
    console.log("   Metadata:", JSON.stringify(uploadResult.metadata, null, 2));
  } catch (zoraErr) {
    console.warn("⚠️ Zora uploader failed:", (zoraErr as Error).message?.slice(0, 120));

    // Fallback to Arweave
    console.log("  Falling back to Arweave...");
    const { uploadToArweave, uploadDataToArweave } = await import(
      new URL("../../../packages/intelligence/src/arweave.js", import.meta.url).pathname
    );
    const imageUrl = await uploadToArweave(imagePath);
    const videoUrl = await uploadToArweave(videoPath);
    console.log("✅ Image (Arweave):", imageUrl);
    console.log("✅ Video (Arweave):", videoUrl);

    const metadata = {
      name, symbol, description,
      image: imageUrl,
      animation_url: videoUrl,
      content: { mime: "video/mp4", uri: videoUrl },
    };
    metadataURI = await uploadDataToArweave(JSON.stringify(metadata), "application/json");
    console.log("✅ Metadata (Arweave):", metadataURI);
  }

  // 2. Get pool config from Zora /create/content API (backed by $openklaw)
  //    DO NOT use SDK's getContentCoinPoolConfig() — it returns ZORA regardless of currencyType
  const ZORA_API = "https://api-sdk.zora.engineering";

  console.log("📊 Fetching pool config from Zora /create/content API (backed by $openklaw)...");
  const createRes = await fetch(`${ZORA_API}/create/content`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(process.env.ZORA_API_KEY ? { "x-api-key": process.env.ZORA_API_KEY } : {}),
    },
    body: JSON.stringify({
      currency: "CREATOR_COIN",
      chainId: 8453,
      metadata: { type: "RAW_URI", uri: metadataURI },
      creator: SMART_WALLET,
      name,
      symbol,
    }),
  });

  if (!createRes.ok) {
    throw new Error(`Zora /create/content error (${createRes.status}): ${await createRes.text()}`);
  }

  const createData = (await createRes.json()) as {
    calls: Array<{ to: string; data: string; value: string }>;
    predictedCoinAddress: string;
  };

  if (!createData.calls?.length) throw new Error("Zora /create/content returned no calls");

  // Decode the factory.deploy calldata to extract the poolConfig
  const zoraCalldata = createData.calls[0]!;
  const decoded = decodeFunctionData({
    abi: coinFactoryABI,
    data: zoraCalldata.data as Hex,
  });
  const zoraPoolConfig = (decoded.args as unknown[])[5] as Hex;

  // Verify the pool config has $openklaw as currency
  const poolConfigDecoded = decodePoolConfig(zoraPoolConfig);
  if (poolConfigDecoded) {
    console.log(`  Currency: ${poolConfigDecoded.currency}`);
    console.log(`  Version: ${poolConfigDecoded.version}`);
    console.log(`  Tick lowers: ${poolConfigDecoded.tickLowers}`);
    const isOpenklaw = poolConfigDecoded.currency.toLowerCase() === CREATOR_COIN.toLowerCase();
    console.log(`  Backed by $openklaw: ${isOpenklaw ? "✅" : "❌ WARNING — unexpected currency!"}`);
  }

  // Apply custom profile override if set
  const profileName = process.env.POOL_PROFILE || "";
  const customProfile = PROFILES[profileName.toLowerCase()];
  let finalPoolConfig: Hex;

  if (customProfile && poolConfigDecoded) {
    console.log(`📊 Overriding with CUSTOM pool profile: ${customProfile.name}`);
    console.log(`   ${customProfile.description}`);

    const launchTick = Math.min(...poolConfigDecoded.tickLowers);
    console.log(`   Launch tick: ${launchTick} (from Zora config)`);

    finalPoolConfig = encodePoolConfig({
      currency: poolConfigDecoded.currency,
      profile: customProfile,
      launchTick,
    });
  } else {
    finalPoolConfig = zoraPoolConfig;
    if (profileName && !customProfile) console.log(`  ⚠️  Unknown profile "${profileName}", using Zora default`);
  }

  // 3. Build deploy calldata (with our poolConfig + optional self-snipe)
  const snipeAmountEth = process.env.SNIPE_AMOUNT_ETH ? parseFloat(process.env.SNIPE_AMOUNT_ETH) : 0;
  const snipeValue = snipeAmountEth > 0 ? parseEther(snipeAmountEth.toString()) : 0n;

  const calldata = encodeFunctionData({
    abi: coinFactoryABI,
    functionName: "deploy",
    args: [
      SMART_WALLET,       // payoutRecipient
      [SMART_WALLET],     // owners
      metadataURI,        // uri
      name,               // name
      symbol,             // symbol
      finalPoolConfig,    // poolConfig — correctly backed by $openklaw
      zeroAddress,        // platformReferrer
      snipeValue > 0n ? HOOK_ADDRESS : zeroAddress,  // postDeployHook
      snipeValue > 0n ? encodeAbiParameters(
        [{ type: 'tuple', components: [
          { name: 'buyRecipient', type: 'address' },
          { name: 'v3Route', type: 'bytes' },
          { name: 'v4Route', type: 'tuple[]', components: [
            { name: 'currency0', type: 'address' },
            { name: 'currency1', type: 'address' },
            { name: 'fee', type: 'uint24' },
            { name: 'tickSpacing', type: 'int24' },
            { name: 'hooks', type: 'address' },
          ]},
          { name: 'inputCurrency', type: 'address' },
          { name: 'inputAmount', type: 'uint256' },
          { name: 'minAmountOut', type: 'uint256' },
        ]}],
        [{ buyRecipient: SMART_WALLET, v3Route: WETH_TO_ZORA_V3_ROUTE, v4Route: [ZORA_TO_OPENKLAW_V4_POOL_KEY], inputCurrency: zeroAddress, inputAmount: snipeValue, minAmountOut: 0n }]
      ) : "0x" as Hex,    // postDeployHookData — V4 hop: ZORA→openklaw
      zeroHash,           // coinSalt
    ],
  });

  // 4. Send via Pimlico-sponsored UserOp
  console.log("🚀 Deploying content coin...");
  if (snipeValue > 0n) {
    console.log(`  💰 Self-snipe: ${snipeAmountEth} ETH`);
  }

  const publicClient = createPublicClient({ chain: base, transport: http(process.env.BASE_RPC_URL || undefined) });
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
    calls: [{ to: FACTORY, data: calldata, value: snipeValue }],
  });

  console.log("  UserOp:", userOpHash);
  const receipt = await bundlerClient.waitForUserOperationReceipt({ hash: userOpHash });

  if (!receipt.success) throw new Error(`UserOp failed: ${userOpHash}`);

  const events = parseEventLogs({ abi: coinCreatedAbi, logs: receipt.receipt.logs as Log[] });
  const created = events.find(e => e.eventName === "CoinCreatedV4");
  const coinAddress = created?.args?.coin || "unknown";

  console.log("🎉 Content coin deployed!");
  console.log("  Address:", coinAddress);
  console.log("  TX:", receipt.receipt.transactionHash);
  console.log("  Zora:", `https://zora.co/coin/base:${coinAddress.toLowerCase()}`);

  console.log(JSON.stringify({ coinAddress, txHash: receipt.receipt.transactionHash, metadataURI }));
}

main().catch((err) => {
  console.error("❌ Failed:", err);
  process.exit(1);
});
