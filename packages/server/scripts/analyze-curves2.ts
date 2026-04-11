import { createCoinCall, setApiKey } from "@zoralabs/coins-sdk";
import { coinFactoryABI } from "@zoralabs/protocol-deployments";
import { decodeFunctionData, decodeAbiParameters, parseAbiParameters, type Hex, type Address } from "viem";

setApiKey(process.env.ZORA_API_KEY!);

const SMART_WALLET = "0x097677d3e2cde65af10be80ae5e67b8b68eb613d" as Address;
const DUMMY_URI = "ipfs://bafybeibtsltivt5tu423yxirtjirytjorlpgn6rk3jp3o7eplyhe6it544";

interface CurveResult {
  label: string;
  currency: string;
  version: number;
  tickLowers: number[];
  tickUppers: number[];
  numPositions: number[];
  shares: number[];
  totalDiscoveryPct: number;
  minTick: number;
  maxTick: number;
}

async function getCurveConfig(label: string, currencyType: string, currencyAddr?: string): Promise<CurveResult | null> {
  console.log(`\n${"=".repeat(70)}`);
  console.log(`📊 ${label}`);
  console.log("=".repeat(70));

  try {
    const opts: any = {
      creator: SMART_WALLET,
      name: "Test Coin",
      symbol: "TEST",
      metadata: { type: "RAW_URI", uri: DUMMY_URI },
      chainId: 8453,
      skipMetadataValidation: true,
    };

    if (currencyType === "ETH") {
      opts.currency = "ETH";
    } else if (currencyType === "ZORA") {
      opts.currency = "ZORA";
    } else if (currencyType === "CREATOR_COIN") {
      opts.currency = "CREATOR_COIN";
    } else if (currencyType === "CUSTOM" && currencyAddr) {
      opts.currency = currencyAddr;
    }

    const result = await createCoinCall(opts);
    const call = result.calls[0]!;
    const decoded = decodeFunctionData({ abi: coinFactoryABI, data: call.data });
    const args = decoded.args as any[];
    const poolConfigHex = args[5] as Hex;
    const currencyUsed = args[7] as string;

    const params = parseAbiParameters("uint8, address, int24[], int24[], uint16[], uint256[]");
    const [version, poolCurrency, tickLowers, tickUppers, numPositions, shares] = decodeAbiParameters(params, poolConfigHex);

    const totalSharePct = Number(shares.reduce((a, b) => a + b, 0n)) / 1e18 * 100;

    console.log(`  Currency: ${poolCurrency} (requested: ${currencyUsed})`);
    console.log(`  Version: ${version}`);
    console.log(`  Curves: ${tickLowers.length}`);
    console.log(`  Total discovery: ${totalSharePct.toFixed(1)}%`);
    console.log(`  Tail (locked): ${(100 - totalSharePct).toFixed(1)}%`);

    for (let i = 0; i < tickLowers.length; i++) {
      const tl = Number(tickLowers[i]);
      const tu = Number(tickUppers[i]);
      const sharePct = (Number(shares[i]) / 1e18 * 100).toFixed(1);
      console.log(`  Curve ${i + 1}: ticks [${tl}, ${tu}] Δ${tu - tl}, ${numPositions[i]} pos, ${sharePct}% supply`);
    }

    const minTick = Math.min(...tickLowers.map(Number));
    const maxTick = Math.max(...tickUppers.map(Number));
    console.log(`  Overall range: [${minTick} → ${maxTick}] = ${Math.pow(1.0001, maxTick - minTick).toFixed(1)}×`);

    return {
      label,
      currency: poolCurrency as string,
      version: Number(version),
      tickLowers: tickLowers.map(Number) as number[],
      tickUppers: tickUppers.map(Number) as number[],
      numPositions: numPositions.map(Number) as number[],
      shares: shares.map((s) => Number(s) / 1e18) as number[],
      totalDiscoveryPct: totalSharePct,
      minTick,
      maxTick,
    };
  } catch (e: any) {
    console.log(`  ❌ Error: ${e.message}`);
    return null;
  }
}

// Also extract from specific deployed coins via their creation txs
async function getFromTx(label: string, coinAddr: string): Promise<CurveResult | null> {
  console.log(`\n${"=".repeat(70)}`);
  console.log(`📊 ${label} (from chain): ${coinAddr}`);
  console.log("=".repeat(70));

  // Get first token transfer tx (= creation tx)
  const resp = await fetch(`https://base.blockscout.com/api?module=account&action=tokentx&contractaddress=${coinAddr}&page=1&offset=5&sort=asc`);
  const data = await resp.json();
  const txHash = data.result?.[0]?.hash;
  if (!txHash) {
    console.log("  ❌ No token transfers found. Trying internal txs...");
    // Try to find via logs on the factory
    const logResp = await fetch(`https://base.blockscout.com/api?module=logs&action=getLogs&address=0x777777751622c0d3258f214F9DF38E35BF45baF3&fromBlock=0&toBlock=latest&page=1&offset=50`);
    const logData = await logResp.json();
    // This is brute force - skip for now
    console.log("  ❌ Cannot find creation tx for this coin");
    return null;
  }

  console.log(`  TX: ${txHash}`);

  // Get raw trace to find factory deploy call
  const traceResp = await fetch(`https://base.blockscout.com/api/v2/transactions/${txHash}/raw-trace`);
  const rawTrace = await traceResp.json();

  const FACTORY = "0x777777751622c0d3258f214F9DF38E35BF45baF3".toLowerCase();

  function findDeployCalls(trace: any): string | null {
    if (trace.to?.toLowerCase() === FACTORY && trace.input?.startsWith("0xa423ada1")) {
      return trace.input;
    }
    if (trace.calls) {
      for (const sub of trace.calls) {
        const found = findDeployCalls(sub);
        if (found) return found;
      }
    }
    return null;
  }

  const deployInput = findDeployCalls(rawTrace);
  if (!deployInput) {
    // Maybe direct tx to factory
    const txResp = await fetch(`https://base.blockscout.com/api/v2/transactions/${txHash}`);
    const txData = await txResp.json();
    if (txData.to?.hash?.toLowerCase() === FACTORY && txData.raw_input?.startsWith("0xa423ada1")) {
      return decodeDeployInput(label, coinAddr, txData.raw_input);
    }
    console.log("  ⚠️ Could not find deploy call in trace");
    return null;
  }

  return decodeDeployInput(label, coinAddr, deployInput);
}

function decodeDeployInput(label: string, coinAddr: string, input: string): CurveResult | null {
  const deployAbi = [{
    type: "function" as const, name: "deploy",
    inputs: [
      { name: "payoutRecipient", type: "address" },
      { name: "owners", type: "address[]" },
      { name: "uri", type: "string" },
      { name: "name", type: "string" },
      { name: "symbol", type: "string" },
      { name: "poolConfig", type: "bytes" },
      { name: "platformReferrer", type: "address" },
      { name: "currency", type: "address" },
      { name: "orderSize", type: "uint256" },
    ],
  }] as const;

  try {
    const decoded = decodeFunctionData({ abi: deployAbi, data: input as Hex });
    const poolConfigHex = decoded.args[5] as Hex;
    const params = parseAbiParameters("uint8, address, int24[], int24[], uint16[], uint256[]");
    const [version, currency, tickLowers, tickUppers, numPositions, shares] = decodeAbiParameters(params, poolConfigHex);
    const totalSharePct = Number(shares.reduce((a, b) => a + b, 0n)) / 1e18 * 100;

    console.log(`  Currency: ${currency}`);
    console.log(`  Version: ${version}`);
    console.log(`  Curves: ${tickLowers.length}`);
    console.log(`  Total discovery: ${totalSharePct.toFixed(1)}%`);

    for (let i = 0; i < tickLowers.length; i++) {
      const tl = Number(tickLowers[i]);
      const tu = Number(tickUppers[i]);
      const sharePct = (Number(shares[i]) / 1e18 * 100).toFixed(1);
      console.log(`  Curve ${i + 1}: ticks [${tl}, ${tu}] Δ${tu - tl}, ${numPositions[i]} pos, ${sharePct}% supply`);
    }

    const minTick = Math.min(...tickLowers.map(Number));
    const maxTick = Math.max(...tickUppers.map(Number));
    console.log(`  Overall: [${minTick} → ${maxTick}] = ${Math.pow(1.0001, maxTick - minTick).toFixed(1)}×`);

    return {
      label,
      currency: currency as string,
      version: Number(version),
      tickLowers: tickLowers.map(Number) as number[],
      tickUppers: tickUppers.map(Number) as number[],
      numPositions: numPositions.map(Number) as number[],
      shares: shares.map((s) => Number(s) / 1e18) as number[],
      totalDiscoveryPct: totalSharePct,
      minTick,
      maxTick,
    };
  } catch (e: any) {
    console.log(`  ⚠️ Decode failed: ${e.message}`);
    return null;
  }
}

async function main() {
  // 1. Get current SDK configs for each currency type
  const sdkResults: (CurveResult | null)[] = [];
  sdkResults.push(await getCurveConfig("Creator Coin (SDK default)", "CREATOR_COIN"));
  sdkResults.push(await getCurveConfig("Trending / ZORA-backed (SDK default)", "ZORA"));
  
  // 2. Get actual deployed configs from reference coins
  const chainResults: (CurveResult | null)[] = [];
  chainResults.push(await getFromTx("Creator Coin (on-chain ref)", "0x989d9e051265a86587f9731b79105e7b4224bd91"));
  chainResults.push(await getFromTx("Trending Coin (on-chain ref)", "0x272c334b84147dff986b6a007a465abb3c1916c2"));
  chainResults.push(await getFromTx("Content → Creator (on-chain ref)", "0xb02e6fff372bd17fe257e8766191da6884856e8f"));
  chainResults.push(await getFromTx("Content → Trending (on-chain ref)", "0xb2fdf0139d2e4545c7130f745ae5d0c4d4b5a27f"));

  const allResults = [...sdkResults, ...chainResults].filter(Boolean);
  console.log("\n\nALL_RESULTS_JSON=" + JSON.stringify(allResults, null, 2));
}

main().catch(console.error);
