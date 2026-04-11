import { createPublicClient, http, parseAbiParameters, decodeAbiParameters, decodeFunctionData, decodeEventLog, type Address, type Hex } from "viem";
import { base } from "viem/chains";

const client = createPublicClient({ chain: base, transport: http("https://mainnet.base.org") });
const FACTORY = "0x777777751622c0d3258f214F9DF38E35BF45baF3" as Address;

const coinCreatedV4Event = {
  type: "event" as const, anonymous: false, name: "CoinCreatedV4",
  inputs: [
    { name: "caller", type: "address", indexed: true },
    { name: "payoutRecipient", type: "address", indexed: true },
    { name: "platformReferrer", type: "address", indexed: true },
    { name: "currency", type: "address", indexed: false },
    { name: "uri", type: "string", indexed: false },
    { name: "name", type: "string", indexed: false },
    { name: "symbol", type: "string", indexed: false },
    { name: "coin", type: "address", indexed: false },
    { name: "poolKey", type: "tuple", indexed: false, components: [
      { name: "currency0", type: "address" },
      { name: "currency1", type: "address" },
      { name: "fee", type: "uint24" },
      { name: "tickSpacing", type: "int24" },
      { name: "hooks", type: "address" },
    ]},
    { name: "poolKeyHash", type: "bytes32", indexed: false },
    { name: "version", type: "string", indexed: false },
  ],
} as const;

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

const coins: Record<string, string> = {
  "Creator Coin": "0x989d9e051265a86587f9731b79105e7b4224bd91",
  "Trending Coin": "0x272c334b84147dff986b6a007a465abb3c1916c2",
  "Content (Creator-backed)": "0xb02e6fff372bd17fe257e8766191da6884856e8f",
  "Content (Trending-backed)": "0xb2fdf0139d2e4545c7130f745ae5d0c4d4b5a27f",
};

async function getCreationTx(coinAddr: string): Promise<string | null> {
  const resp = await fetch(`https://base.blockscout.com/api/v2/addresses/${coinAddr}`);
  const data = await resp.json();
  return data.creation_transaction_hash || data.creation_tx_hash || null;
}

function decodeAndPrint(poolConfigHex: Hex) {
  const params = parseAbiParameters("uint8, address, int24[], int24[], uint16[], uint256[]");
  const [version, currency, tickLowers, tickUppers, numPositions, shares] = decodeAbiParameters(params, poolConfigHex);

  const totalSharePct = shares.reduce((a, b) => a + b, 0n) * 100n / BigInt(1e18);

  console.log(`  Pool Config (version ${version}):`);
  console.log(`  Currency: ${currency}`);
  console.log(`  Curves: ${tickLowers.length}`);
  console.log(`  Discovery supply: ~${totalSharePct}%`);
  console.log(`  Tail (locked) supply: ~${100n - totalSharePct}%`);

  const curveData: any[] = [];
  for (let i = 0; i < tickLowers.length; i++) {
    const tl = Number(tickLowers[i]);
    const tu = Number(tickUppers[i]);
    const sharePct = (Number(shares[i]) / 1e18 * 100).toFixed(1);
    const tickRange = tu - tl;

    curveData.push({ tl, tu, sharePct, numPos: Number(numPositions[i]), tickRange });

    console.log(`  Curve ${i + 1}: ticks [${tl}, ${tu}] (Δ${tickRange}), ${numPositions[i]} positions, ${sharePct}% supply`);
  }

  const minTick = Math.min(...tickLowers.map(Number));
  const maxTick = Math.max(...tickUppers.map(Number));
  const overallMultiple = Math.pow(1.0001, maxTick - minTick);
  console.log(`  Overall: [${minTick} → ${maxTick}] = ${overallMultiple.toFixed(1)}× price range`);

  return { version: Number(version), currency: currency as string, tickLowers: tickLowers.map(Number), tickUppers: tickUppers.map(Number), numPositions: numPositions.map(Number), shares: shares.map(s => Number(s) / 1e18), totalDiscoveryPct: Number(totalSharePct), minTick, maxTick, overallMultiple };
}

async function analyzeFromTx(label: string, coinAddr: string) {
  console.log(`\n${"=".repeat(70)}`);
  console.log(`📊 ${label}: ${coinAddr}`);
  console.log("=".repeat(70));

  const txHash = await getCreationTx(coinAddr);
  if (!txHash) { console.log("  ❌ Could not find creation tx"); return null; }
  console.log(`  TX: ${txHash}`);

  const receipt = await client.getTransactionReceipt({ hash: txHash as `0x${string}` });

  let poolKey: any = null;
  let currency = "";
  let coinName = "";
  let symbol = "";

  for (const log of receipt.logs) {
    try {
      const decoded = decodeEventLog({ abi: [coinCreatedV4Event], data: log.data, topics: log.topics });
      if (decoded.eventName === "CoinCreatedV4") {
        poolKey = decoded.args.poolKey;
        currency = decoded.args.currency;
        coinName = decoded.args.name;
        symbol = decoded.args.symbol;
        break;
      }
    } catch {}
  }

  if (!poolKey) { console.log("  ❌ CoinCreatedV4 event not found"); return null; }

  console.log(`  Name: ${coinName} ($${symbol})`);
  console.log(`  Backing currency: ${currency}`);
  console.log(`  Hooks: ${poolKey.hooks}`);
  console.log(`  TickSpacing: ${poolKey.tickSpacing}`);

  // Try direct tx decode
  const tx = await client.getTransaction({ hash: txHash as `0x${string}` });
  try {
    const decoded = decodeFunctionData({ abi: deployAbi, data: tx.input });
    const poolConfigHex = decoded.args[5] as Hex;
    const result = decodeAndPrint(poolConfigHex);
    return { label, coinAddr, currency, poolKey, ...result };
  } catch {}

  // Try trace for UserOp txs
  const rawTraceResp = await fetch(`https://base.blockscout.com/api/v2/transactions/${txHash}/raw-trace`);
  const rawTrace = await rawTraceResp.json();

  function findDeployCalls(trace: any): string | null {
    if (trace.to?.toLowerCase() === FACTORY.toLowerCase() && trace.input?.startsWith("0xa423ada1")) {
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
  if (deployInput) {
    try {
      const decoded = decodeFunctionData({ abi: deployAbi, data: deployInput as Hex });
      const poolConfigHex = decoded.args[5] as Hex;
      const result = decodeAndPrint(poolConfigHex);
      return { label, coinAddr, currency, poolKey, ...result };
    } catch (e: any) {
      console.log(`  ⚠️ Failed to decode: ${e.message}`);
    }
  } else {
    console.log("  ⚠️ Could not find deploy call in trace");
  }

  return null;
}

async function main() {
  const results: any[] = [];
  for (const [label, addr] of Object.entries(coins)) {
    const r = await analyzeFromTx(label, addr);
    if (r) results.push(r);
  }

  // JSON output for visualization
  console.log("\n\nCURVE_DATA_JSON=" + JSON.stringify(results, null, 2));
}

main().catch(console.error);
