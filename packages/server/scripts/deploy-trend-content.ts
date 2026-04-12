/**
 * Deploy a content coin paired to a TrendCoin.
 *
 * Uses the SDK's createCoinCall to get correctly-calibrated pool config
 * (ticks appropriate for the creator's coin price), then re-encodes
 * with the trend coin address as currency.
 *
 * Usage:
 *   TREND_COIN=0x... COIN_NAME="..." COIN_SYMBOL="..." COIN_DESCRIPTION="..." COIN_IMAGE_PATH=... \
 *   doppler run --project openclaw --config prd -- bun x tsx packages/server/scripts/deploy-trend-content.ts
 */

import { setApiKey, createCoinCall, createMetadataBuilder, createZoraUploaderForCreator } from "@zoralabs/coins-sdk";
import { coinFactoryABI, coinABI } from "@zoralabs/protocol-deployments";
import { readFileSync } from "fs";
import {
  createPublicClient, http, encodeFunctionData, parseEventLogs,
  decodeFunctionData, decodeAbiParameters, encodeAbiParameters, parseAbiParameters,
  zeroAddress, zeroHash, parseEther,
  type Address, type Hex, type Log,
} from "viem";
import { base } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import { toCoinbaseSmartAccount } from "viem/account-abstraction";
import { createSponsoredBundlerClient } from "../src/services/bundler/config.js";
import { encodePoolConfig, extractLaunchTick, PROFILES, type ProfileSpec } from "../src/services/poolConfig.js";

const SMART_WALLET = "0x097677d3e2cde65af10be80ae5e67b8b68eb613d" as Address;
const FACTORY = "0x777777751622c0d3258f214F9DF38E35BF45baF3" as Address;

const HOOK_ADDRESS = "0xd8CC7bCA1dE52eA788829B16E375e9B96C18D433" as Address;
const WETH = "0x4200000000000000000000000000000000000006";
const ZORA_TOKEN = "0x1111111111166b7fe7bd91427724b487980afc69";
const WETH_TO_ZORA_V3_ROUTE = `0x${WETH.slice(2)}000bb8${ZORA_TOKEN.slice(2)}` as Hex;

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
  const trendCoin = (process.env.TREND_COIN || "").toLowerCase() as Address;
  const name = process.env.COIN_NAME;
  const symbol = process.env.COIN_SYMBOL;
  const description = process.env.COIN_DESCRIPTION;
  const imagePath = process.env.COIN_IMAGE_PATH;

  if (!trendCoin || !name || !symbol || !description || !imagePath) {
    console.error("Required env: TREND_COIN, COIN_NAME, COIN_SYMBOL, COIN_DESCRIPTION, COIN_IMAGE_PATH");
    process.exit(1);
  }

  const privateKeyRaw = process.env.ZORA_PRIVATE_KEY!;
  if (!privateKeyRaw) throw new Error("ZORA_PRIVATE_KEY not set");
  if (!process.env.ZORA_API_KEY) throw new Error("ZORA_API_KEY not set");

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
    const metadata = { name, symbol, description, image: imageUrl, content: { mime: "image/png", uri: imageUrl } };
    metadataURI = await arweave.uploadDataToArweave(JSON.stringify(metadata), "application/json");
    console.log("✅ Metadata (Arweave):", metadataURI);
  }

  const publicClient = createPublicClient({ chain: base, transport: http(process.env.BASE_RPC_URL || undefined) });

  // 2. Get correctly-calibrated pool config for the TREND COIN
  //
  //    CRITICAL: Content coins paired to trend coins MUST use the TREND COIN as
  //    backing currency — NOT $ZORA, NOT $openklaw.
  //
  //    How Doppler tick calibration works:
  //    The SDK targets a specific USD-denominated launch market cap (~$50–$300).
  //    The launch tick encodes the token's launch price IN the backing currency:
  //
  //      tick = log( targetLaunchMC / (supply × currencyPriceUSD) ) / log(1.0001)
  //
  //    So different backing currencies get different absolute ticks even though the
  //    curve SHAPE (multiples, share splits) is identical:
  //      ETH    (~$2000/token)  → launch tick: ~-238400
  //      $ZORA  (~$0.01/token)  → launch tick: ~-120600
  //      $openklaw (~$0.00005)  → launch tick: ~-50800
  //      trend coin (~$0.000009) → needs its OWN calibrated tick
  //
  //    $CLAWD BUG: createCoinCall(currency:"CREATOR_COIN") → ticks for $openklaw →
  //    swapped currency address to trend coin → trend coin was 5.5x cheaper per unit →
  //    launch MC was $0.05 → $0.18 bought the ENTIRE discovery range.
  //
  //    FIX: Look up the trend coin's market cap from our intelligence DB, compute
  //    the correct launch tick directly, then encode with our poolConfig encoder.
  //    This is exact, not approximate.
  console.log("📊 Computing launch tick from trend coin's actual price...");

  // Look up trend coin market cap from our intelligence DB
  let trendCoinMarketCapUSD = 0;
  try {
    const Database = (await import("better-sqlite3")).default as any;
    const dbPath = new URL("../../intelligence/.data/zora-intelligence.db", import.meta.url).pathname;
    const db = new Database(dbPath);
    const row = db.prepare(
      "SELECT market_cap FROM coins WHERE LOWER(address) = ? LIMIT 1"
    ).get(trendCoin.toLowerCase()) as { market_cap: number } | undefined;
    if (row) {
      trendCoinMarketCapUSD = row.market_cap;
      console.log(`  Trend coin market cap from DB: $${trendCoinMarketCapUSD.toFixed(2)}`);
    } else {
      // Also check trend_coins table
      const row2 = db.prepare(
        "SELECT market_cap FROM trend_coins WHERE LOWER(address) = ? LIMIT 1"
      ).get(trendCoin.toLowerCase()) as { market_cap: number } | undefined;
      if (row2) {
        trendCoinMarketCapUSD = row2.market_cap;
        console.log(`  Trend coin market cap from DB (trend_coins): $${trendCoinMarketCapUSD.toFixed(2)}`);
      }
    }
    db.close();
  } catch (dbErr: any) {
    console.warn("  ⚠️ DB lookup failed:", dbErr.message?.slice(0, 60));
  }

  if (!trendCoinMarketCapUSD || trendCoinMarketCapUSD <= 0) {
    throw new Error(
      `Cannot calibrate pool config: trend coin ${trendCoin} not found in intelligence DB or has zero market cap.\n` +
      `Ensure the intelligence engine has indexed this coin before deploying against it.`
    );
  }

  // Compute trend coin price per token (1B supply is standard)
  const TOTAL_SUPPLY = 1_000_000_000;
  const trendCoinPriceUSD = trendCoinMarketCapUSD / TOTAL_SUPPLY;
  console.log(`  Trend coin price: $${trendCoinPriceUSD.toExponential(3)}/token`);

  // Target a ~$200 USD launch market cap (same ballpark as SDK defaults)
  const TARGET_LAUNCH_MC_USD = 200;
  const { computeLaunchTick } = await import("../src/services/poolConfig.js");
  const trendLaunchTick = computeLaunchTick(trendCoinPriceUSD, TARGET_LAUNCH_MC_USD, TOTAL_SUPPLY);
  console.log(`  Computed launch tick for $${TARGET_LAUNCH_MC_USD} launch MC: ${trendLaunchTick}`);

  // Apply custom profile if specified, otherwise use Gradual default
  const profileName = process.env.POOL_PROFILE || "";
  const profile: ProfileSpec = (profileName && PROFILES[profileName])
    ? PROFILES[profileName]
    : PROFILES.gradual;

  if (profileName && PROFILES[profileName]) {
    console.log(`  Applying custom profile: ${profile.name} (${profile.description})`);
  } else if (profileName) {
    console.warn(`  ⚠️ Unknown profile "${profileName}", using Gradual default`);
  } else {
    console.log("  Using Gradual default profile");
  }

  // Encode with TREND COIN as currency and correctly-computed launch tick
  const poolConfig = encodePoolConfig({
    currency: trendCoin as Address,
    profile,
    launchTick: trendLaunchTick,
  });

  // Log the final config for verification
  const finalDecoded = decodeAbiParameters(
    parseAbiParameters("uint8, address, int24[], int24[], uint16[], uint256[]"),
    poolConfig,
  );
  console.log("  ✅ Final currency:", finalDecoded[1], "(trend coin)");
  console.log("  Final ticks:", finalDecoded[2].map(Number), "→", finalDecoded[3].map(Number));
  const finalMinTick = Math.min(...(finalDecoded[2] as readonly number[]).map(Number));
  const verifyMC = Math.pow(1.0001, finalMinTick) * TOTAL_SUPPLY * trendCoinPriceUSD;
  console.log(`  ✅ Verified launch MC: $${verifyMC.toFixed(2)} (target: $${TARGET_LAUNCH_MC_USD})`);

  // 3. Self-snipe setup
  const snipeAmountEth = process.env.SNIPE_AMOUNT_ETH ? parseFloat(process.env.SNIPE_AMOUNT_ETH) : 0;
  const snipeValue = snipeAmountEth > 0 ? parseEther(snipeAmountEth.toString()) : 0n;

  let postDeployHook: Address = zeroAddress;
  let postDeployHookData: Hex = "0x";

  if (snipeValue > 0n) {
    console.log(`🎯 Self-snipe: ${snipeAmountEth} ETH — fetching trend coin pool key...`);
    const trendPoolKey = await publicClient.readContract({
      address: trendCoin,
      abi: coinABI,
      functionName: "getPoolKey",
    });
    console.log("  Trend coin pool key:", trendPoolKey);

    postDeployHook = HOOK_ADDRESS;
    postDeployHookData = encodeAbiParameters(
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
      [{ buyRecipient: SMART_WALLET, v3Route: WETH_TO_ZORA_V3_ROUTE, v4Route: [trendPoolKey], inputCurrency: zeroAddress, inputAmount: snipeValue, minAmountOut: 0n }]
    );
  }

  // 4. Deploy using the 10-param deploy function (matches SDK's selector)
  console.log("🚀 Deploying content coin...");
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

  // Use the same 10-param deploy the SDK uses
  const calldata = encodeFunctionData({
    abi: coinFactoryABI,
    functionName: "deploy",
    args: [
      SMART_WALLET,       // payoutRecipient
      [SMART_WALLET],     // owners
      metadataURI,        // uri
      name,               // name
      symbol,             // symbol
      poolConfig,         // poolConfig (with trend coin currency)
      zeroAddress,        // platformReferrer
      postDeployHook,     // postDeployHook
      postDeployHookData, // postDeployHookData
      zeroHash,           // coinSalt
    ],
  });

  const userOpHash = await bundlerClient.sendUserOperation({
    calls: [{ to: FACTORY, data: calldata, value: snipeValue }],
  });

  console.log("  UserOp:", userOpHash);
  const receipt = await bundlerClient.waitForUserOperationReceipt({ hash: userOpHash });

  if (!receipt.success) throw new Error(`UserOp failed: ${userOpHash}`);

  // 5. Parse result
  const events = parseEventLogs({ abi: coinCreatedAbi, logs: receipt.receipt.logs as Log[] });
  const created = events.find(e => e.eventName === "CoinCreatedV4");
  const coinAddress = created?.args?.coin || "unknown";
  const poolCurrency = created?.args?.currency || "unknown";

  console.log("\n🎉 Content coin deployed!");
  console.log("  Address:", coinAddress);
  console.log("  Pool currency:", poolCurrency);
  console.log("  TX:", receipt.receipt.transactionHash);
  console.log("  Zora:", `https://zora.co/coin/base:${String(coinAddress).toLowerCase()}`);

  // Output JSON for automation
  console.log("\nRESULT_JSON=" + JSON.stringify({
    coinAddress: String(coinAddress).toLowerCase(),
    poolCurrency: String(poolCurrency).toLowerCase(),
    txHash: receipt.receipt.transactionHash,
    metadataURI,
    zoraUrl: `https://zora.co/coin/base:${String(coinAddress).toLowerCase()}`,
  }));

  // 6. Update trend_posts DB if a matching pending record exists
  try {
    const Database = (await import("better-sqlite3")).default;
    const dbPath = new URL("../../intelligence/.data/zora-intelligence.db", import.meta.url).pathname;
    const db = new Database(dbPath);

    // Find matching pending post by trend_address + symbol
    const row = db.prepare(
      `SELECT id FROM trend_posts WHERE trend_address = ? AND symbol = ? AND status = 'pending' LIMIT 1`
    ).get(trendCoin, symbol);

    if (row) {
      db.prepare(
        `UPDATE trend_posts SET content_coin_address = ?, status = 'deployed', deployed_at = datetime('now') WHERE id = ?`
      ).run(String(coinAddress).toLowerCase(), (row as any).id);
      console.log(`📝 Updated trend_posts #${(row as any).id} → deployed`);
    } else {
      // No matching pending record — insert a new one
      db.prepare(
        `INSERT INTO trend_posts (trend_address, trend_symbol, content_coin_address, name, symbol, image_url, commentary, status, score, created_at, deployed_at, sell_after)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'deployed', 0, datetime('now'), datetime('now'), datetime('now', '+24 hours'))`
      ).run(trendCoin, '', String(coinAddress).toLowerCase(), name, symbol, imagePath || '', description || '');
      console.log("📝 Inserted new trend_posts record (no pending match found)");
    }

    db.close();
  } catch (dbErr: any) {
    console.warn("⚠️ Failed to update trend_posts:", dbErr.message?.slice(0, 80));
  }
}

main().catch(err => {
  console.error("❌ Failed:", err);
  process.exit(1);
});
