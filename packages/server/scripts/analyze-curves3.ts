import { createPublicClient, http, parseAbiParameters, decodeAbiParameters, decodeFunctionData, type Hex, type Address } from "viem";
import { base } from "viem/chains";
import { coinFactoryABI } from "@zoralabs/protocol-deployments";
import { createCoinCall, setApiKey } from "@zoralabs/coins-sdk";

setApiKey(process.env.ZORA_API_KEY!);

const FACTORY = "0x777777751622c0d3258f214F9DF38E35BF45baF3".toLowerCase();
const SMART_WALLET = "0x097677d3e2cde65af10be80ae5e67b8b68eb613d" as Address;

interface CurveResult {
  label: string;
  currency: string;
  currencyLabel?: string;
  version: number;
  tickLowers: number[];
  tickUppers: number[];
  numPositions: number[];
  shares: number[];
  totalDiscoveryPct: number;
  minTick: number;
  maxTick: number;
}

// All factory function selectors that include poolConfig
const DEPLOY_SELECTORS = ["0xa423ada1", "0xa27a6dce", "0xc7ce4e16", "0xf4858a9a", "0x3c7bca94", "0x0d36fc77"];

function findFactoryCalls(trace: any, results: string[] = []): string[] {
  if (trace.to?.toLowerCase() === FACTORY) {
    const sel = trace.input?.slice(0, 10);
    if (DEPLOY_SELECTORS.includes(sel)) {
      results.push(trace.input);
    }
  }
  if (trace.calls) {
    for (const sub of trace.calls) {
      findFactoryCalls(sub, results);
    }
  }
  return results;
}

function decodePoolConfigFromCalldata(calldata: Hex): CurveResult | null {
  // Try each known function signature
  try {
    const decoded = decodeFunctionData({ abi: coinFactoryABI, data: calldata });
    // Find the bytes arg that looks like a poolConfig
    const args = decoded.args as any[];
    
    // Different deploy functions put poolConfig at different positions
    // We need to find the bytes arg that decodes as (uint8, address, int24[], int24[], uint16[], uint256[])
    for (const arg of args) {
      if (typeof arg === "string" && arg.startsWith("0x") && arg.length > 100) {
        try {
          const params = parseAbiParameters("uint8, address, int24[], int24[], uint16[], uint256[]");
          const [version, currency, tickLowers, tickUppers, numPositions, shares] = decodeAbiParameters(params, arg as Hex);
          if (Number(version) === 4 && tickLowers.length > 0) {
            const totalSharePct = Number(shares.reduce((a, b) => a + b, 0n)) / 1e18 * 100;
            return {
              label: "", currency: currency as string, version: Number(version),
              tickLowers: tickLowers.map(Number) as number[],
              tickUppers: tickUppers.map(Number) as number[],
              numPositions: numPositions.map(Number) as number[],
              shares: shares.map(s => Number(s) / 1e18) as number[],
              totalDiscoveryPct: totalSharePct,
              minTick: Math.min(...tickLowers.map(Number)),
              maxTick: Math.max(...tickUppers.map(Number)),
            };
          }
        } catch {}
      }
    }
    return null;
  } catch {
    return null;
  }
}

async function analyzeOnChain(label: string, coinAddr: string): Promise<CurveResult | null> {
  console.log(`\n${"=".repeat(70)}`);
  console.log(`📊 ${label}: ${coinAddr}`);
  console.log("=".repeat(70));

  // Find creation tx
  const resp = await fetch(`https://base.blockscout.com/api?module=account&action=tokentx&contractaddress=${coinAddr}&page=1&offset=5&sort=asc`);
  const data = await resp.json();
  let txHash = data.result?.[0]?.hash;

  if (!txHash) {
    // Try internal txs
    const resp2 = await fetch(`https://base.blockscout.com/api/v2/addresses/${coinAddr}/internal-transactions`);
    const data2 = await resp2.json();
    txHash = data2.items?.[0]?.transaction_hash;
  }

  if (!txHash) {
    // Try logs - look for Transfer events from 0x0 (minting)
    const resp3 = await fetch(`https://base.blockscout.com/api?module=logs&action=getLogs&address=${coinAddr}&topic0=0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef&topic1=0x0000000000000000000000000000000000000000000000000000000000000000&fromBlock=0&toBlock=latest&page=1&offset=1`);
    const data3 = await resp3.json();
    txHash = data3.result?.[0]?.transactionHash;
  }

  if (!txHash) {
    console.log("  ❌ Cannot find creation tx");
    return null;
  }

  console.log(`  TX: ${txHash}`);

  // Get raw trace
  const traceResp = await fetch(`https://base.blockscout.com/api/v2/transactions/${txHash}/raw-trace`);
  const rawTrace = await traceResp.json();

  const calls = findFactoryCalls(rawTrace);
  if (calls.length === 0) {
    console.log("  ⚠️ No factory deploy calls found in trace");
    return null;
  }

  for (const calldata of calls) {
    const result = decodePoolConfigFromCalldata(calldata as Hex);
    if (result) {
      result.label = label;
      console.log(`  Currency: ${result.currency}`);
      console.log(`  Version: ${result.version}`);
      console.log(`  Discovery: ${result.totalDiscoveryPct.toFixed(1)}%  |  Tail: ${(100 - result.totalDiscoveryPct).toFixed(1)}%`);
      for (let i = 0; i < result.tickLowers.length; i++) {
        console.log(`  Curve ${i+1}: [${result.tickLowers[i]}, ${result.tickUppers[i]}] Δ${result.tickUppers[i]-result.tickLowers[i]}, ${result.numPositions[i]} pos, ${(result.shares[i]*100).toFixed(1)}%`);
      }
      console.log(`  Overall: ${Math.pow(1.0001, result.maxTick - result.minTick).toFixed(1)}× range`);
      return result;
    }
  }

  console.log("  ⚠️ Could not decode pool config from any factory call");
  return null;
}

async function getSDKConfig(label: string, currencyType: string): Promise<CurveResult | null> {
  console.log(`\n${"=".repeat(70)}`);
  console.log(`📊 ${label} (SDK default)`);
  console.log("=".repeat(70));

  const result = await createCoinCall({
    creator: SMART_WALLET,
    name: "Test", symbol: "TST",
    metadata: { type: "RAW_URI", uri: "ipfs://bafybeibtsltivt5tu423yxirtjirytjorlpgn6rk3jp3o7eplyhe6it544" },
    currency: currencyType as any,
    chainId: 8453,
    skipMetadataValidation: true,
  });

  const call = result.calls[0]!;
  const decoded = decodeFunctionData({ abi: coinFactoryABI, data: call.data });
  const args = decoded.args as any[];

  // Find poolConfig bytes
  for (const arg of args) {
    if (typeof arg === "string" && arg.startsWith("0x") && arg.length > 100) {
      try {
        const params = parseAbiParameters("uint8, address, int24[], int24[], uint16[], uint256[]");
        const [version, currency, tickLowers, tickUppers, numPositions, shares] = decodeAbiParameters(params, arg as Hex);
        if (Number(version) === 4) {
          const totalSharePct = Number(shares.reduce((a, b) => a + b, 0n)) / 1e18 * 100;
          const r: CurveResult = {
            label, currency: currency as string, version: Number(version),
            tickLowers: tickLowers.map(Number) as number[],
            tickUppers: tickUppers.map(Number) as number[],
            numPositions: numPositions.map(Number) as number[],
            shares: shares.map(s => Number(s)/1e18) as number[],
            totalDiscoveryPct: totalSharePct,
            minTick: Math.min(...tickLowers.map(Number)),
            maxTick: Math.max(...tickUppers.map(Number)),
          };
          console.log(`  Currency: ${r.currency}`);
          console.log(`  Discovery: ${r.totalDiscoveryPct.toFixed(1)}%  |  Tail: ${(100-r.totalDiscoveryPct).toFixed(1)}%`);
          for (let i = 0; i < r.tickLowers.length; i++) {
            console.log(`  Curve ${i+1}: [${r.tickLowers[i]}, ${r.tickUppers[i]}] Δ${r.tickUppers[i]-r.tickLowers[i]}, ${r.numPositions[i]} pos, ${(r.shares[i]*100).toFixed(1)}%`);
          }
          console.log(`  Overall: ${Math.pow(1.0001, r.maxTick - r.minTick).toFixed(1)}× range`);
          return r;
        }
      } catch {}
    }
  }
  console.log("  ❌ Could not extract pool config");
  return null;
}

async function main() {
  const results: CurveResult[] = [];

  // On-chain reference coins
  const r1 = await analyzeOnChain("Creator Coin (nealianokid)", "0x989d9e051265a86587f9731b79105e7b4224bd91");
  if (r1) { r1.currencyLabel = "ZORA"; results.push(r1); }

  const r2 = await analyzeOnChain("Trending Coin (earlylifecrisis)", "0x272c334b84147dff986b6a007a465abb3c1916c2");
  if (r2) { r2.currencyLabel = "ZORA"; results.push(r2); }

  const r3 = await analyzeOnChain("Content → Creator", "0xb02e6fff372bd17fe257e8766191da6884856e8f");
  if (r3) { r3.currencyLabel = "Creator Coin"; results.push(r3); }

  const r4 = await analyzeOnChain("Content → Trending", "0xb2fdf0139d2e4545c7130f745ae5d0c4d4b5a27f");
  if (r4) { r4.currencyLabel = "Trending Coin"; results.push(r4); }

  // SDK defaults for comparison
  const s1 = await getSDKConfig("SDK: Creator Coin", "CREATOR_COIN");
  if (s1) { s1.currencyLabel = "openklaw (creator coin)"; results.push(s1); }

  const s2 = await getSDKConfig("SDK: ZORA-backed", "ZORA");
  if (s2) { s2.currencyLabel = "ZORA"; results.push(s2); }

  console.log("\n\nALL_RESULTS=" + JSON.stringify(results));
}

main().catch(console.error);
