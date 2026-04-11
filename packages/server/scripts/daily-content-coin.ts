/**
 * Daily Content Coin — Klawley's daily commentary on the degen trenches.
 *
 * Flow:
 * 1. Fetch trending/top coins from zora-intelligence
 * 2. Generate a roast/commentary + image prompt
 * 3. Generate image via OpenAI
 * 4. Upload image + metadata to Zora IPFS
 * 5. Deploy content coin backed by creator coin ($openklaw) with CUSTOM Doppler curve
 * 6. Optionally self-snipe (buy our own supply on deploy)
 * 7. Post to Discord
 *
 * CUSTOM CURVES:
 *   Set POOL_PROFILE env to use a custom Doppler curve instead of Zora's default.
 *   Available: gradual (Zora default), rocket, steep, deep
 *   Set SNIPE_AMOUNT_ETH to buy supply on deploy (e.g. "0.001")
 *
 * This script is designed to be called by the agent via cron,
 * NOT run standalone — the agent handles image gen + Discord posting.
 */

import { setApiKey } from "@zoralabs/coins-sdk";
import { readFileSync, existsSync } from "fs";
import type { Address, Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { createPublicClient, http, encodeFunctionData, encodeAbiParameters, zeroHash, zeroAddress, parseEther, type Log, parseEventLogs, decodeFunctionData } from "viem";
import { coinFactoryABI } from "@zoralabs/protocol-deployments";
import { base } from "viem/chains";
import { toCoinbaseSmartAccount } from "viem/account-abstraction";
import { createSponsoredBundlerClient } from "../src/services/bundler/config.js";
import { encodePoolConfig, extractLaunchTick, decodePoolConfig, PROFILES, type ProfileSpec } from "../src/services/poolConfig.js";
import { createCampaignFromDeployment } from "../src/services/campaigns.js";
import { getCreatorCoinStrategySnapshot } from "../src/services/creatorCoinStrategy.js";

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
  //    Priority: Zora IPFS → Arweave → fail (no free IPFS)
  console.log("📤 Uploading metadata...");

  let imageUrl: string;
  let metadataURI: string;

  // --- Try Zora IPFS uploader first ---
  try {
    const { createMetadataBuilder, createZoraUploaderForCreator } = await import("@zoralabs/coins-sdk");
    console.log("  Trying Zora IPFS uploader...");

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

    metadataURI = uploadResult.url;
    imageUrl = metadataURI; // Zora bundles image into metadata
    console.log("✅ Zora IPFS:", metadataURI);
  } catch (zoraErr) {
    console.warn("⚠️ Zora uploader failed:", (zoraErr as Error).message?.slice(0, 80));

    // --- Fallback to Arweave ---
    console.log("  Falling back to Arweave...");
    const { uploadToArweave, uploadDataToArweave } = await import(
      new URL("../../../packages/intelligence/src/arweave.js", import.meta.url).pathname
    );
    imageUrl = await uploadToArweave(params.imagePath);
    console.log("✅ Image (Arweave):", imageUrl);

    const metadata = {
      name: params.name,
      symbol: params.symbol,
      description: params.description,
      image: imageUrl,
      content: { mime: "image/png", uri: imageUrl },
    };
    metadataURI = await uploadDataToArweave(JSON.stringify(metadata), "application/json");
    console.log("✅ Metadata (Arweave):", metadataURI);
  }

  // 2. Get pool config from Zora's /create/content API with currency: CREATOR_COIN
  //    This returns calldata with $openklaw as the backing token (not ZORA).
  //    NOTE: getContentCoinPoolConfig() returns ZORA regardless of currencyType —
  //    only the /create/content API correctly pairs to the creator coin.
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
      name: params.name,
      symbol: params.symbol,
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
  // deploy args: payoutRecipient, owners[], uri, name, symbol, poolConfig, platformReferrer, postDeployHook, postDeployHookData, coinSalt
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
    console.log(`   Curves: ${customProfile.curves.length}, Discovery: ${customProfile.curves.reduce((s, c) => s + c.sharePercent, 0)}%`);

    const launchTick = Math.min(...poolConfigDecoded.tickLowers);
    console.log(`   Launch tick: ${launchTick} (from Zora config)`);

    finalPoolConfig = encodePoolConfig({
      currency: poolConfigDecoded.currency,
      profile: customProfile,
      launchTick,
    });
    console.log(`   Encoded config: ${finalPoolConfig.length} chars`);
  } else {
    finalPoolConfig = zoraPoolConfig;
    if (profileName && !customProfile) console.log(`  ⚠️  Unknown profile "${profileName}", using Zora default`);
  }

  // 3. Build deploy calldata (with our poolConfig + optional self-snipe)
  const snipeAmountEth = process.env.SNIPE_AMOUNT_ETH ? parseFloat(process.env.SNIPE_AMOUNT_ETH) : 0;
  const requestedSnipeValue = snipeAmountEth > 0 ? parseEther(snipeAmountEth.toString()) : 0n;
  const creatorCoinStrategy = await getCreatorCoinStrategySnapshot().catch(() => null);
  const snipeFundingSource = creatorCoinStrategy?.preferredSnipeSource ?? "ETH";
  const useCreatorCoinForSnipe = requestedSnipeValue > 0n && snipeFundingSource === "CREATOR_COIN";
  const snipeValue = useCreatorCoinForSnipe ? 0n : requestedSnipeValue;

  const calldata = encodeFunctionData({
    abi: coinFactoryABI,
    functionName: "deploy",
    args: [
      SMART_WALLET,       // payoutRecipient
      [SMART_WALLET],     // owners
      metadataURI,        // uri
      params.name,        // name
      params.symbol,      // symbol
      finalPoolConfig,    // poolConfig — now correctly backed by $openklaw
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
  if (requestedSnipeValue > 0n) {
    if (useCreatorCoinForSnipe) {
      console.log(`  🪙 Preferred self-snipe source: CREATOR_COIN (${creatorCoinStrategy?.regime ?? "unknown"} regime)`);
      console.log("  ⚠️ Creator-coin-funded launch snipe not wired yet; deploy will proceed without inline ETH hook snipe.");
    } else {
      console.log(`  💰 Self-snipe: ${snipeAmountEth} ETH`);
    }
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

  // 5. Parse coin address
  const events = parseEventLogs({ abi: coinCreatedAbi, logs: receipt.receipt.logs as Log[] });
  const created = events.find(e => e.eventName === "CoinCreatedV4");
  const coinAddress = created?.args?.coin || "unknown";

  console.log("🎉 Content coin deployed!");
  console.log("  Address:", coinAddress);
  console.log("  TX:", receipt.receipt.transactionHash);
  console.log("  Zora:", `https://zora.co/coin/base:${coinAddress.toLowerCase()}`);

  const txHash = receipt.receipt.transactionHash;

  try {
    const dryRun = (process.env.CAMPAIGN_DRY_RUN ?? "").trim().toLowerCase();
    const targetAllocationBps = Number.parseInt(process.env.CAMPAIGN_TARGET_ALLOCATION_BPS ?? "100", 10);
    const snipeWei = snipeValue > 0n ? snipeValue : 0n;
    const campaign = await createCampaignFromDeployment({
      coinAddress,
      name: params.name,
      symbol: params.symbol,
      deployTxHash: txHash,
      deploySource: "daily-content-coin",
      metadataUri: metadataURI,
      selfSnipeEthWei: snipeWei,
      targetAllocationBps: Number.isFinite(targetAllocationBps) ? targetAllocationBps : 100,
      dryRun: ["1", "true", "yes", "on"].includes(dryRun),
      notes: `profile=${customProfile?.name ?? "zora-default"}; selfSnipeEth=${snipeAmountEth}; preferredSnipeSource=${snipeFundingSource}; creatorCoinRegime=${creatorCoinStrategy?.regime ?? "unknown"}`,
    });
    console.log(`📋 Campaign ${campaign.id} created (${campaign.status}/${campaign.phase})`);
  } catch (campaignErr) {
    console.warn("⚠️ Failed to create campaign record:", (campaignErr as Error).message?.slice(0, 200));
  }

  return {
    coinAddress,
    txHash,
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
