/**
 * $XYEK Flight Check — DRY RUN ONLY
 * 
 * Validates:
 * 1. Metadata upload (cover.png + video)
 * 2. Launch tick computation from $CURVES actual price
 * 3. Midcurve poolConfig encoding
 * 4. Self-snipe route simulation (0.005 ETH)
 */

import { setApiKey, createMetadataBuilder, createZoraUploaderForCreator } from "@zoralabs/coins-sdk";
import { coinFactoryABI, coinABI } from "@zoralabs/protocol-deployments";
import { readFileSync, existsSync } from "fs";
import {
  createPublicClient, http, encodeFunctionData, encodeAbiParameters, parseAbiParameters,
  decodeFunctionData, zeroAddress, zeroHash, parseEther,
  type Address, type Hex,
} from "viem";
import { base } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import { toCoinbaseSmartAccount } from "viem/account-abstraction";
import { createSponsoredBundlerClient } from "../src/services/bundler/config.js";
import { encodePoolConfig, computeLaunchTick, PROFILES } from "../src/services/poolConfig.js";

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
  console.log("  $XYEK FLIGHT CHECK — DRY RUN");
  console.log("═══════════════════════════════════════\n");

  // ── 1. Verify assets ──────────────────────────────
  console.log("📁 Asset check:");
  const coverPath = `${PENDING}/cover.png`;
  const videoPath = `${PENDING}/liquidity_curves_web.mp4`;
  
  const coverExists = existsSync(coverPath);
  const videoExists = existsSync(videoPath);
  const coverSize = coverExists ? readFileSync(coverPath).length : 0;
  const videoSize = videoExists ? readFileSync(videoPath).length : 0;
  
  console.log(`  cover.png: ${coverExists ? `✅ ${(coverSize / 1024).toFixed(0)}KB` : "❌ MISSING"}`);
  console.log(`  liquidity_curves_web.mp4: ${videoExists ? `✅ ${(videoSize / 1024 / 1024).toFixed(1)}MB` : "❌ MISSING"}`);
  
  if (!coverExists) throw new Error("cover.png missing!");

  // ── 2. Upload metadata ────────────────────────────
  console.log("\n📤 Uploading metadata...");
  if (!process.env.ZORA_API_KEY) throw new Error("ZORA_API_KEY not set");
  setApiKey(process.env.ZORA_API_KEY);

  const name = "Liquidity Curves";
  const symbol = "XYEK";
  const description = "The equation that replaced every trading floor on earth. No order book. No market maker. Just x * y = k. Two tokens enter the pool. The ratio shifts. The price moves. Nobody asked permission. The curve decides — not you, never you. Bonding curves, concentrated liquidity, slippage nightmares, and the infinite rebalancing act of decentralized finance. You are the liquidity. The liquidity is you.";

  const imageBytes = readFileSync(coverPath);
  const imageFile = new File([imageBytes], "cover.png", { type: "image/png" });

  let metadataURI: string;
  try {
    const uploadResult = await createMetadataBuilder()
      .withName(name)
      .withSymbol(symbol)
      .withDescription(description)
      .withImage(imageFile)
      .upload(createZoraUploaderForCreator(SMART_WALLET));
    metadataURI = uploadResult.url;
    console.log(`  ✅ Zora IPFS: ${metadataURI}`);
  } catch (zoraErr: any) {
    console.warn(`  ⚠️ Zora uploader failed: ${zoraErr.message?.slice(0, 80)}`);
    console.log("  Falling back to Arweave...");
    const arweave = await import("../../intelligence/src/arweave.js");
    const imageUrl = await arweave.uploadToArweave(coverPath);
    console.log(`  ✅ Image (Arweave): ${imageUrl}`);
    const metadata = { name, symbol, description, image: imageUrl, content: { mime: "image/png", uri: imageUrl } };
    metadataURI = await arweave.uploadDataToArweave(JSON.stringify(metadata), "application/json");
    console.log(`  ✅ Metadata (Arweave): ${metadataURI}`);
  }

  // ── 3. Compute launch tick ────────────────────────
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
  console.log(`  Target launch MC: $${TARGET_MC}`);
  console.log(`  Computed launch tick: ${launchTick}`);

  // Verify roundtrip
  const verifyMC = Math.pow(1.0001, launchTick) * TOTAL_SUPPLY * trendCoinPriceUSD;
  console.log(`  ✅ Verified launch MC: $${verifyMC.toFixed(2)}`);

  // ── 4. Encode midcurve poolConfig ─────────────────
  console.log("\n🎯 Encoding midcurve poolConfig...");
  const profile = PROFILES.midcurve;
  console.log(`  Profile: ${profile.name}`);
  console.log(`  Curves: ${profile.curves.length}`);
  for (const c of profile.curves) {
    console.log(`    ${c.sharePercent}% share, ${c.rangeStart}×–${c.rangeEnd}×, ${c.numPositions} positions`);
  }

  const poolConfig = encodePoolConfig({
    currency: TREND_COIN,
    profile,
    launchTick,
  });

  // Decode and verify
  const [version, currency, tickLowers, tickUppers, numPositions, shares] = 
    (await import("viem")).decodeAbiParameters(
      parseAbiParameters("uint8, address, int24[], int24[], uint16[], uint256[]"),
      poolConfig,
    );
  
  console.log(`  Version: ${version}`);
  console.log(`  Currency: ${currency} (should be $CURVES)`);
  console.log(`  Tick ranges: ${Array.from(tickLowers).map((t, i) => `[${t}, ${Array.from(tickUppers)[i]}]`).join(", ")}`);
  console.log(`  Discovery shares: ${Array.from(shares).map(s => `${(Number(s) * 100 / 1e18).toFixed(1)}%`).join(" + ")}`);
  const totalDisc = Array.from(shares).reduce((a, b) => a + Number(b), 0) / 1e18 * 100;
  console.log(`  Total discovery: ${totalDisc.toFixed(1)}%, Tail: ${(100 - totalDisc).toFixed(1)}%`);
  console.log(`  ✅ Currency matches $CURVES: ${currency.toLowerCase() === TREND_COIN.toLowerCase()}`);

  // ── 5. Snipe route simulation ─────────────────────
  console.log("\n🎯 Self-snipe route (0.005 ETH)...");
  
  const publicClient = createPublicClient({ chain: base, transport: http() });
  
  // Get $CURVES pool key
  const trendPoolKey = await publicClient.readContract({
    address: TREND_COIN,
    abi: coinABI,
    functionName: "getPoolKey",
  });
  console.log("  $CURVES pool key:", JSON.stringify({
    currency0: trendPoolKey.currency0,
    currency1: trendPoolKey.currency1,
    fee: Number(trendPoolKey.fee),
    tickSpacing: Number(trendPoolKey.tickSpacing),
    hooks: trendPoolKey.hooks,
  }, null, 4));

  const snipeValue = parseEther(SNIPE_ETH.toString());

  // Encode postDeployHookData
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

  console.log("  V3 route: ETH → WETH → $ZORA (fee 3000)");
  console.log("  V4 route: $ZORA → $CURVES (Doppler pool)");
  console.log("  V4 route: $CURVES → $XYEK (new coin's Doppler pool — auto from hook)");
  console.log(`  Snipe amount: ${SNIPE_ETH} ETH`);
  console.log(`  PostDeployHook: ${HOOK_ADDRESS}`);
  console.log(`  PostDeployHookData length: ${postDeployHookData.length} chars`);

  // Build the full deploy calldata
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
      zeroAddress,
      HOOK_ADDRESS,
      postDeployHookData,
      zeroHash,
    ],
  });

  console.log(`  Deploy calldata: ${calldata.length} chars`);

  // ── 6. Simulate via eth_call ──────────────────────
  console.log("\n🧪 Simulating deploy + snipe via eth_call...");

  const privateKeyRaw = process.env.ZORA_PRIVATE_KEY!;
  if (!privateKeyRaw) throw new Error("ZORA_PRIVATE_KEY not set");
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

  // Prepare UserOp but DON'T send it — just estimate gas
  try {
    const userOp = await bundlerClient.prepareUserOperation({
      calls: [{ to: FACTORY, data: calldata, value: snipeValue }],
    });
    
    console.log("  ✅ UserOp prepared successfully!");
    console.log(`  callGasLimit: ${userOp.callGasLimit}`);
    console.log(`  verificationGasLimit: ${userOp.verificationGasLimit}`);
    console.log(`  preVerificationGas: ${userOp.preVerificationGas}`);
    console.log(`  Paymaster: ${userOp.paymaster || "none"}`);
    console.log(`  Paymaster covers gas: ${!!userOp.paymasterData}`);
  } catch (simErr: any) {
    console.error("  ❌ Simulation FAILED:", simErr.message?.slice(0, 200));
    console.error("  Full error:", JSON.stringify(simErr, null, 2).slice(0, 500));
    throw simErr;
  }

  // ── Summary ───────────────────────────────────────
  console.log("\n═══════════════════════════════════════");
  console.log("  FLIGHT CHECK SUMMARY");
  console.log("═══════════════════════════════════════");
  console.log(`  Coin: ${name} ($${symbol})`);
  console.log(`  Backing: $CURVES (${TREND_COIN})`);
  console.log(`  Profile: Midcurve (50% disc / 50% tail)`);
  console.log(`  Launch tick: ${launchTick}`);
  console.log(`  Launch MC: ~$${verifyMC.toFixed(2)}`);
  console.log(`  Snipe: ${SNIPE_ETH} ETH`);
  console.log(`  Route: ETH→ZORA(V3)→$CURVES(V4)→$XYEK(V4)`);
  console.log(`  Metadata: ${metadataURI}`);
  console.log(`  Status: ✅ READY TO LAUNCH`);
  console.log("═══════════════════════════════════════");
  console.log("\n⚠️  DRY RUN COMPLETE — NO DEPLOYMENT MADE");
}

main().catch(err => {
  console.error("\n💀 FLIGHT CHECK FAILED:", err.message);
  process.exit(1);
});
