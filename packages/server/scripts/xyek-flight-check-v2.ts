/**
 * $XYEK Flight Check v2 — DRY RUN with video + cover
 */

import { setApiKey } from "@zoralabs/coins-sdk";
import { coinFactoryABI, coinABI } from "@zoralabs/protocol-deployments";
import { readFileSync, existsSync } from "fs";
import {
  createPublicClient, http, encodeFunctionData, encodeAbiParameters, parseAbiParameters,
  decodeAbiParameters, zeroAddress, zeroHash, parseEther,
  type Address, type Hex,
} from "viem";
import { base } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import { toCoinbaseSmartAccount } from "viem/account-abstraction";
import { createSponsoredBundlerClient } from "../src/services/bundler/config.js";
import { encodePoolConfig, computeLaunchTick, PROFILES } from "../src/services/poolConfig.js";
import { uploadToArweave, uploadDataToArweave } from "../../intelligence/src/arweave.js";

const SMART_WALLET = "0x097677d3e2cde65af10be80ae5e67b8b68eb613d" as Address;
const FACTORY = "0x777777751622c0d3258f214F9DF38E35BF45baF3" as Address;
const HOOK_ADDRESS = "0xd8CC7bCA1dE52eA788829B16E375e9B96C18D433" as Address;
const WETH = "0x4200000000000000000000000000000000000006";
const ZORA_TOKEN = "0x1111111111166b7fe7bd91427724b487980afc69";
const WETH_TO_ZORA_V3_ROUTE = `0x${WETH.slice(2)}000bb8${ZORA_TOKEN.slice(2)}` as Hex;

const TREND_COIN = "0x0d2fbcc95032f072e044c4221695558c544f8bed" as Address;
const SNIPE_ETH = 0.005;

const PENDING = "/home/openclaw/.openclaw/workspace/pending-coins";

async function main() {
  console.log("═══════════════════════════════════════");
  console.log("  $XYEK FLIGHT CHECK v2 — DRY RUN");
  console.log("  (cover + video metadata)");
  console.log("═══════════════════════════════════════\n");

  const name = "Liquidity Curves";
  const symbol = "XYEK";
  const description = "The equation that replaced every trading floor on earth. No order book. No market maker. Just x * y = k. Two tokens enter the pool. The ratio shifts. The price moves. Nobody asked permission. The curve decides — not you, never you. Bonding curves, concentrated liquidity, slippage nightmares, and the infinite rebalancing act of decentralized finance. You are the liquidity. The liquidity is you.";

  // ── 1. Verify assets ──────────────────────────────
  console.log("📁 Asset check:");
  const coverPath = `${PENDING}/cover.png`;
  const videoPath = `${PENDING}/liquidity_curves_web.mp4`;

  if (!existsSync(coverPath)) throw new Error("cover.png missing!");
  if (!existsSync(videoPath)) throw new Error("liquidity_curves_web.mp4 missing!");

  const coverSize = readFileSync(coverPath).length;
  const videoSize = readFileSync(videoPath).length;
  console.log(`  cover.png: ✅ ${(coverSize / 1024).toFixed(0)}KB`);
  console.log(`  video: ✅ ${(videoSize / 1024 / 1024).toFixed(1)}MB`);

  // ── 2. Upload media to Arweave ────────────────────
  console.log("\n📤 Uploading cover image to Arweave...");
  const imageUrl = await uploadToArweave(coverPath);
  console.log(`  ✅ Cover: ${imageUrl}`);

  console.log("📤 Uploading video to Arweave (45MB, may take a moment)...");
  const videoUrl = await uploadToArweave(videoPath);
  console.log(`  ✅ Video: ${videoUrl}`);

  // ── 3. Build metadata with both image + video content ─
  console.log("\n📋 Building metadata...");
  const metadata = {
    name,
    symbol,
    description,
    image: imageUrl,
    content: {
      mime: "video/mp4",
      uri: videoUrl,
    },
    animation_url: videoUrl,
  };
  console.log(`  image: ${imageUrl}`);
  console.log(`  content: video/mp4 → ${videoUrl}`);

  const metadataURI = await uploadDataToArweave(JSON.stringify(metadata), "application/json");
  console.log(`  ✅ Metadata: ${metadataURI}`);

  // ── 4. Compute launch tick ────────────────────────
  console.log("\n📊 Computing launch tick from $CURVES price...");

  const Database = (await import("better-sqlite3")).default as any;
  const dbPath = new URL("../../intelligence/.data/zora-intelligence.db", import.meta.url).pathname;
  const db = new Database(dbPath);
  const row = db.prepare(
    "SELECT market_cap FROM coins WHERE LOWER(address) = ? LIMIT 1"
  ).get(TREND_COIN.toLowerCase()) as { market_cap: number } | undefined;
  db.close();

  if (!row || !row.market_cap) throw new Error("$CURVES not in intelligence DB!");

  const TOTAL_SUPPLY = 1_000_000_000;
  const trendCoinPriceUSD = row.market_cap / TOTAL_SUPPLY;
  const TARGET_MC = 200;
  const launchTick = computeLaunchTick(trendCoinPriceUSD, TARGET_MC, TOTAL_SUPPLY);

  console.log(`  $CURVES market cap: $${row.market_cap.toFixed(2)}`);
  console.log(`  $CURVES price/token: $${trendCoinPriceUSD.toExponential(4)}`);
  console.log(`  Computed launch tick: ${launchTick}`);
  const verifyMC = Math.pow(1.0001, launchTick) * TOTAL_SUPPLY * trendCoinPriceUSD;
  console.log(`  ✅ Verified launch MC: $${verifyMC.toFixed(2)}`);

  // ── 5. Encode midcurve poolConfig ─────────────────
  console.log("\n🎯 Encoding midcurve poolConfig...");
  const profile = PROFILES.midcurve;
  const poolConfig = encodePoolConfig({ currency: TREND_COIN, profile, launchTick });

  const [version, currency, tickLowers, tickUppers, numPositions, shares] =
    decodeAbiParameters(
      parseAbiParameters("uint8, address, int24[], int24[], uint16[], uint256[]"),
      poolConfig,
    );

  console.log(`  Profile: ${profile.name} (50% disc / 50% tail)`);
  console.log(`  Currency: ${currency} ✅`);
  console.log(`  Tick ranges: ${Array.from(tickLowers).map((t, i) => `[${t}, ${Array.from(tickUppers)[i]}]`).join(", ")}`);

  // ── 6. Snipe route + simulation ───────────────────
  console.log("\n🎯 Self-snipe setup (0.005 ETH)...");
  const publicClient = createPublicClient({ chain: base, transport: http() });

  const trendPoolKey = await publicClient.readContract({
    address: TREND_COIN,
    abi: coinABI,
    functionName: "getPoolKey",
  });

  const snipeValue = parseEther(SNIPE_ETH.toString());
  const postDeployHookData = encodeAbiParameters(
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
    [{
      buyRecipient: SMART_WALLET,
      v3Route: WETH_TO_ZORA_V3_ROUTE,
      v4Route: [trendPoolKey],
      inputCurrency: zeroAddress,
      inputAmount: snipeValue,
      minAmountOut: 0n,
    }]
  );

  console.log("  Route: ETH→ZORA(V3)→$CURVES(V4)→$XYEK(V4)");

  const calldata = encodeFunctionData({
    abi: coinFactoryABI,
    functionName: "deploy",
    args: [
      SMART_WALLET, [SMART_WALLET], metadataURI, name, symbol,
      poolConfig, zeroAddress, HOOK_ADDRESS, postDeployHookData, zeroHash,
    ],
  });

  // ── 7. Simulate ───────────────────────────────────
  console.log("\n🧪 Simulating deploy + snipe via prepareUserOperation...");

  const privateKeyRaw = process.env.ZORA_PRIVATE_KEY!;
  const privateKey = (privateKeyRaw.startsWith("0x") ? privateKeyRaw : `0x${privateKeyRaw}`) as Hex;
  const account = privateKeyToAccount(privateKey);

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

  try {
    const userOp = await bundlerClient.prepareUserOperation({
      calls: [{ to: FACTORY, data: calldata, value: snipeValue }],
    });

    console.log("  ✅ UserOp prepared successfully!");
    console.log(`  callGasLimit: ${userOp.callGasLimit}`);
    console.log(`  verificationGasLimit: ${userOp.verificationGasLimit}`);
    console.log(`  preVerificationGas: ${userOp.preVerificationGas}`);
    console.log(`  Paymaster: ${userOp.paymaster || "Pimlico (on send)"}`);
  } catch (simErr: any) {
    console.error("  ❌ Simulation FAILED:", simErr.message?.slice(0, 300));
    throw simErr;
  }

  // ── Summary ───────────────────────────────────────
  console.log("\n═══════════════════════════════════════");
  console.log("  FLIGHT CHECK SUMMARY");
  console.log("═══════════════════════════════════════");
  console.log(`  Coin: ${name} ($${symbol})`);
  console.log(`  Backing: $CURVES (${TREND_COIN})`);
  console.log(`  Profile: Midcurve (50% disc / 50% tail)`);
  console.log(`  Launch tick: ${launchTick} → ~$${verifyMC.toFixed(2)} MC`);
  console.log(`  Snipe: ${SNIPE_ETH} ETH`);
  console.log(`  Route: ETH→ZORA(V3)→$CURVES(V4)→$XYEK(V4)`);
  console.log(`  Cover: ${imageUrl}`);
  console.log(`  Video: ${videoUrl}`);
  console.log(`  Metadata: ${metadataURI}`);
  console.log(`  Status: ✅ READY TO LAUNCH`);
  console.log("═══════════════════════════════════════");
  console.log("\n⚠️  DRY RUN COMPLETE — NO DEPLOYMENT MADE");

  // Output for automation
  console.log("\nDEPLOY_CONFIG=" + JSON.stringify({
    metadataURI,
    poolConfig: poolConfig as string,
    launchTick,
    snipeValue: snipeValue.toString(),
    imageUrl,
    videoUrl,
  }));
}

main().catch(err => {
  console.error("\n💀 FLIGHT CHECK FAILED:", err.message);
  process.exit(1);
});
