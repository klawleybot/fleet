/**
 * Dry-run: metadata upload + pool config + calldata encoding (no deploy)
 */
import { setApiKey, createMetadataBuilder, createZoraUploaderForCreator } from "@zoralabs/coins-sdk";
import { coinFactoryABI } from "@zoralabs/protocol-deployments";
import { readFileSync } from "fs";
import type { Address, Hex, Log } from "viem";
import { encodeFunctionData, encodeAbiParameters, zeroHash, zeroAddress, parseEther, decodeFunctionData } from "viem";
import { decodePoolConfig, encodePoolConfig, PROFILES } from "../src/services/poolConfig.js";

const SMART_WALLET = "0x097677d3e2cde65af10be80ae5e67b8b68eb613d" as Address;
const CREATOR_COIN = "0x2e6e49e3f1c76d9b8c7ca0bee2005ed6de0e2046" as Address;
const FACTORY = "0x777777751622c0d3258f214F9DF38E35BF45baF3" as Address;
const HOOK_ADDRESS = "0xd8CC7bCA1dE52eA788829B16E375e9B96C18D433" as Address;
const DOPPLER_HOOK = "0x0469a4Bd3724DC86C9542F4694c976DA13C450c0" as Address;
const WETH = "0x4200000000000000000000000000000000000006";
const ZORA_TOKEN = "0x1111111111166b7fe7bd91427724b487980afc69";
const WETH_TO_ZORA_V3_ROUTE = `0x${WETH.slice(2)}000bb8${ZORA_TOKEN.slice(2)}` as Hex;
const ZORA_TO_OPENKLAW_V4_POOL_KEY = {
  currency0: ZORA_TOKEN as Address,
  currency1: CREATOR_COIN,
  fee: 8388608,
  tickSpacing: 200,
  hooks: DOPPLER_HOOK,
} as const;

const name = "Let The Bot Cook";
const symbol = "COOK";
const description = `A degen wrote a trading bot at 2AM. The bot traded against itself across five wallets. The Grafana dashboard showed a perfectly flat P&L line. The bot bought $47,000 of a coin called $FARTS. The bot doesn't have an off switch because nobody wrote one. At dawn, the degen started writing a new bot. This time with a stop loss. Maybe.\n\nThis is not financial advice. This is a terminal screen in an empty room, still trading into nothing. The bots are still running.\n\nNo degens were financially recovered during the making of this video.`;
const imagePath = "/home/openclaw/.openclaw/workspace/pending-coins/let_the_bot_cook.png";
const videoPath = "/home/openclaw/.openclaw/workspace/pending-coins/let_the_bot_cook.mp4";
const snipeAmountEth = 0.002;
const snipeValue = parseEther(snipeAmountEth.toString());

setApiKey(process.env.ZORA_API_KEY!);

async function main() {
  console.log("=== DRY RUN: Let The Bot Cook ===\n");

  // 1. Metadata upload
  console.log("📤 Step 1: Uploading metadata (image + video) to Zora IPFS...");
  let metadataURI: string;
  try {
    const imageBytes = readFileSync(imagePath);
    const imageFile = new File([imageBytes], "thumbnail.png", { type: "image/png" });
    const videoBytes = readFileSync(videoPath);
    const videoFile = new File([videoBytes], "content.mp4", { type: "video/mp4" });

    const uploadResult = await createMetadataBuilder()
      .withName(name).withSymbol(symbol).withDescription(description)
      .withImage(imageFile).withMedia(videoFile)
      .upload(createZoraUploaderForCreator(SMART_WALLET));

    metadataURI = uploadResult.url;
    console.log("✅ Metadata URI:", metadataURI);
    console.log("   Metadata:", JSON.stringify(uploadResult.metadata, null, 2));
  } catch (err) {
    console.error("❌ Zora upload FAILED:", (err as Error).message);
    console.log("   Would fall back to Arweave in real deploy");
    process.exit(1);
  }

  // 2. Pool config from Zora API
  console.log("\n📊 Step 2: Fetching pool config (CREATOR_COIN backing)...");
  const ZORA_API = "https://api-sdk.zora.engineering";
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
      name, symbol,
    }),
  });

  if (!createRes.ok) {
    console.error("❌ Pool config FAILED:", createRes.status, await createRes.text());
    process.exit(1);
  }

  const createData = (await createRes.json()) as any;
  const decoded = decodeFunctionData({ abi: coinFactoryABI, data: createData.calls[0].data as Hex });
  const zoraPoolConfig = (decoded.args as unknown[])[5] as Hex;
  const poolInfo = decodePoolConfig(zoraPoolConfig);

  if (!poolInfo) { console.error("❌ Failed to decode pool config"); process.exit(1); }
  
  const isOpenklaw = poolInfo.currency.toLowerCase() === CREATOR_COIN.toLowerCase();
  console.log(`✅ Currency: ${poolInfo.currency} (openklaw: ${isOpenklaw ? "✅" : "❌ WRONG"})`);
  console.log(`   Version: ${poolInfo.version}`);
  console.log(`   Tick lowers: [${poolInfo.tickLowers.join(", ")}]`);
  console.log(`   Tick uppers: [${poolInfo.tickUppers.join(", ")}]`);
  console.log(`   Shares: [${poolInfo.shares.map((s: bigint) => `${Number(s * 100n / BigInt(1e18))}%`).join(", ")}]`);
  
  if (!isOpenklaw) { console.error("❌ STOP — wrong currency!"); process.exit(1); }

  // 3. Apply midcurve profile
  console.log("\n📊 Step 3: Applying MIDCURVE profile...");
  const midcurve = PROFILES["midcurve"];
  console.log(`   Profile: ${midcurve.name} — ${midcurve.description}`);
  const launchTick = Math.min(...poolInfo.tickLowers);
  console.log(`   Launch tick: ${launchTick}`);

  const finalPoolConfig = encodePoolConfig({
    currency: poolInfo.currency,
    profile: midcurve,
    launchTick,
  });
  const finalDecoded = decodePoolConfig(finalPoolConfig);
  console.log(`✅ Final tick lowers: [${finalDecoded!.tickLowers.join(", ")}]`);
  console.log(`   Final tick uppers: [${finalDecoded!.tickUppers.join(", ")}]`);
  console.log(`   Final shares: [${finalDecoded!.shares.map((s: bigint) => `${Number(s * 100n / BigInt(1e18))}%`).join(", ")}]`);

  // 4. Encode calldata
  console.log("\n🔧 Step 4: Encoding deploy calldata...");
  const calldata = encodeFunctionData({
    abi: coinFactoryABI,
    functionName: "deploy",
    args: [
      SMART_WALLET, [SMART_WALLET], metadataURI, name, symbol,
      finalPoolConfig, zeroAddress, HOOK_ADDRESS,
      encodeAbiParameters(
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
      ),
      zeroHash,
    ],
  });

  console.log(`✅ Calldata encoded (${calldata.length} chars)`);
  console.log(`   Self-snipe: ${snipeAmountEth} ETH`);
  console.log(`   Snipe route: ETH → WETH → $ZORA (V3) → $openklaw (V4 Doppler) → $COOK`);
  console.log(`   Predicted coin: ${createData.predictedCoinAddress}`);

  console.log("\n=== DRY RUN COMPLETE ✅ ===");
  console.log("All checks passed. Ready to deploy.");
  console.log(JSON.stringify({
    status: "PASS",
    metadataURI,
    predictedCoin: createData.predictedCoinAddress,
    currency: poolInfo.currency,
    profile: "midcurve",
    snipeEth: snipeAmountEth,
  }));
}

main().catch(e => { console.error("❌ DRY RUN FAILED:", e); process.exit(1); });
