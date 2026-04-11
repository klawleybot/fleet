/**
 * Deploy a pending trend content proposal.
 *
 * Usage:
 *   TREND_POST_ID=<id-or-symbol> \
 *   doppler run --project openclaw --config prd -- npx tsx packages/server/scripts/deploy-pending-trend.ts
 *
 * Reads the proposal from trend_posts DB, deploys the content coin,
 * and updates the DB record with the deployed address + status.
 */

import { setApiKey, createMetadataBuilder, createZoraUploaderForCreator } from "@zoralabs/coins-sdk";
import { coinFactoryABI } from "@zoralabs/protocol-deployments";
import { readFileSync, existsSync } from "fs";
import {
  createPublicClient, http, encodeFunctionData, parseEventLogs,
  type Address, type Hex, type Log,
} from "viem";
import { encodePoolConfig, computeLaunchTick, PROFILES } from "../src/services/poolConfig.js";
import { base } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import { toCoinbaseSmartAccount } from "viem/account-abstraction";
import Database from "better-sqlite3";
import { TrendScorer } from "../../intelligence/src/trend-scorer.js";
import { createSponsoredBundlerClient } from "../src/services/bundler/config.js";

const SMART_WALLET = "0x097677d3e2cde65af10be80ae5e67b8b68eb613d" as Address;
const FACTORY = "0x777777751622c0d3258f214F9DF38E35BF45baF3" as Address;
const DB_PATH = new URL("../../intelligence/.data/zora-intelligence.db", import.meta.url).pathname;

const coinCreatedAbi = [{
  type: "event", anonymous: false, name: "CoinCreatedV4",
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
  const query = process.env.TREND_POST_ID;
  if (!query) {
    console.error("Required env: TREND_POST_ID (post id or trend/content symbol)");
    process.exit(1);
  }

  const privateKeyRaw = process.env.ZORA_PRIVATE_KEY!;
  if (!privateKeyRaw) throw new Error("ZORA_PRIVATE_KEY not set");
  if (!process.env.ZORA_API_KEY) throw new Error("ZORA_API_KEY not set");

  // Find the pending post
  const db = new Database(DB_PATH);
  const scorer = new TrendScorer(db);
  const post = scorer.findPendingPost(query);

  if (!post) {
    console.error(`No pending post found for: ${query}`);
    console.log("Pending posts:");
    for (const p of scorer.getPendingPosts()) {
      console.log(`  #${p.id}: ${p.name} ($${p.symbol}) → $${p.trend_symbol}`);
    }
    db.close();
    process.exit(1);
  }

  console.log(`📋 Deploying post #${post.id}: "${post.name}" ($${post.symbol}) paired to $${post.trend_symbol}`);

  const trendCoin = post.trend_address.toLowerCase() as Address;
  const name = post.name!;
  const symbol = post.symbol!;
  const description = post.commentary || `Klawley content coin paired to $${post.trend_symbol}. 🦞`;
  const imagePath = post.image_url;

  if (!imagePath || !existsSync(imagePath)) {
    console.error(`Image not found: ${imagePath}`);
    db.close();
    process.exit(1);
  }

  const privateKey = (privateKeyRaw.startsWith("0x") ? privateKeyRaw : `0x${privateKeyRaw}`) as Hex;
  const account = privateKeyToAccount(privateKey);
  setApiKey(process.env.ZORA_API_KEY);

  // 1. Upload metadata
  console.log("📤 Uploading metadata...");
  const imageBytes = readFileSync(imagePath);
  const ext = imagePath.split(".").pop() || "png";
  const imageFile = new File([imageBytes], `content-coin.${ext}`, {
    type: ext === "jpg" || ext === "jpeg" ? "image/jpeg" : `image/${ext}`,
  });

  let metadataURI: string;
  try {
    const uploadResult = await createMetadataBuilder()
      .withName(name)
      .withSymbol(symbol)
      .withDescription(description)
      .withImage(imageFile)
      .upload(createZoraUploaderForCreator(SMART_WALLET));
    metadataURI = uploadResult.url;
    console.log("✅ Zora IPFS:", metadataURI);
  } catch (zoraErr: any) {
    console.warn("⚠️ Zora uploader failed:", zoraErr.message?.slice(0, 80));
    const arweave = await import("../../intelligence/src/arweave.js");
    const imageUrl = await arweave.uploadToArweave(imagePath);
    console.log("✅ Image (Arweave):", imageUrl);
    const metadata = { name, symbol, description, image: imageUrl, content: { mime: `image/${ext}`, uri: imageUrl } };
    metadataURI = await arweave.uploadDataToArweave(JSON.stringify(metadata), "application/json");
    console.log("✅ Metadata (Arweave):", metadataURI);
  }

  // 2. Compute pool config using trend coin's actual price
  console.log("📊 Computing pool config for trend coin...");

  // Get trend coin market cap from intelligence DB
  const trendCoinRow = db.prepare(
    `SELECT market_cap FROM coins WHERE LOWER(address) = LOWER(?) LIMIT 1`
  ).get(trendCoin) as { market_cap: number } | undefined;

  const trendMcap = trendCoinRow?.market_cap;
  if (!trendMcap || trendMcap <= 0) {
    throw new Error(`Cannot find market cap for trend coin ${trendCoin} — need it to compute launch tick`);
  }

  // Derive price: mcap / totalSupply (1B for Zora coins)
  const TOTAL_SUPPLY = 1e9;
  const trendCoinPriceUSD = trendMcap / TOTAL_SUPPLY;
  const TARGET_LAUNCH_MC_USD = 200; // Zora's standard ~$200 launch MC

  const launchTick = computeLaunchTick(trendCoinPriceUSD, TARGET_LAUNCH_MC_USD, TOTAL_SUPPLY);
  const profile = PROFILES.midcurve; // balanced 50/50 discovery/tail

  const poolConfig = encodePoolConfig({
    currency: trendCoin,
    profile,
    launchTick,
    tickSpacing: 200,
  });

  console.log("  Currency:", trendCoin);
  console.log("  Trend coin price: $" + trendCoinPriceUSD.toFixed(8));
  console.log("  Launch tick:", launchTick);
  console.log("  Profile:", profile.name, "-", profile.description);

  // 3. Deploy
  console.log("🚀 Deploying...");
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

  const calldata = encodeFunctionData({
    abi: coinFactoryABI,
    functionName: "deploy",
    args: [
      SMART_WALLET,
      [SMART_WALLET],
      metadataURI,
      name,
      symbol,
      poolConfig,
      "0x0000000000000000000000000000000000000000" as Address,
      "0x0000000000000000000000000000000000000000" as Address,
      "0x" as Hex,
      "0x0000000000000000000000000000000000000000000000000000000000000000" as Hex,
    ],
  });

  const userOpHash = await bundlerClient.sendUserOperation({
    calls: [{ to: FACTORY, data: calldata, value: 0n }],
  });

  console.log("  UserOp:", userOpHash);
  const receipt = await bundlerClient.waitForUserOperationReceipt({ hash: userOpHash });
  if (!receipt.success) throw new Error(`UserOp failed: ${userOpHash}`);

  // 4. Parse result
  const events = parseEventLogs({ abi: coinCreatedAbi, logs: receipt.receipt.logs as Log[] });
  const created = events.find(e => e.eventName === "CoinCreatedV4");
  const coinAddress = String(created?.args?.coin || "unknown").toLowerCase();
  const poolCurrency = String(created?.args?.currency || "unknown").toLowerCase();

  // 5. Update DB
  scorer.updatePost(post.id, {
    contentCoinAddress: coinAddress,
    status: "deployed",
    deployedAt: new Date().toISOString(),
  });

  console.log("\n🎉 Content coin deployed!");
  console.log("  Post ID:", post.id);
  console.log("  Address:", coinAddress);
  console.log("  Pool currency:", poolCurrency);
  console.log("  TX:", receipt.receipt.transactionHash);
  console.log("  Zora:", `https://zora.co/coin/base:${coinAddress}`);

  console.log("\nRESULT_JSON=" + JSON.stringify({
    postId: post.id,
    coinAddress,
    poolCurrency,
    txHash: receipt.receipt.transactionHash,
    metadataURI,
    zoraUrl: `https://zora.co/coin/base:${coinAddress}`,
    trendSymbol: post.trend_symbol,
    name,
    symbol,
  }));

  db.close();
}

main().catch(err => {
  console.error("❌ Failed:", err);
  process.exit(1);
});
