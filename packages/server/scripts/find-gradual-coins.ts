import { createPublicClient, http, decodeFunctionData, decodeAbiParameters, parseAbiParameters, type Hex } from "viem";
import { base } from "viem/chains";

const RPC = process.env.BASE_RPC_URL!;
const client = createPublicClient({ chain: base, transport: http(RPC) });
const FACTORY = "0x777777751622c0d3258f214f9df38e35bf45baf3";
const ZORA_TOKEN = "0x1111111111166b7fe7bd91427724b487980afc69";

const event = {
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
      { name: "currency0", type: "address" },{ name: "currency1", type: "address" },{ name: "fee", type: "uint24" },{ name: "tickSpacing", type: "int24" },{ name: "hooks", type: "address" },
    ]},
    { name: "poolKeyHash", type: "bytes32", indexed: false },
    { name: "version", type: "string", indexed: false },
  ],
};

const abis = [
  [{ type: "function" as const, name: "deploy", inputs: [
    { name: "a", type: "address" },{ name: "b", type: "address[]" },{ name: "c", type: "string" },
    { name: "d", type: "string" },{ name: "e", type: "string" },{ name: "f", type: "bytes" },
    { name: "g", type: "address" },{ name: "h", type: "uint256" },
  ]}],
  [{ type: "function" as const, name: "deploy", inputs: [
    { name: "a", type: "address" },{ name: "b", type: "address[]" },{ name: "c", type: "string" },
    { name: "d", type: "string" },{ name: "e", type: "string" },{ name: "f", type: "bytes" },
    { name: "g", type: "address" },{ name: "h", type: "address" },{ name: "i", type: "bytes" },
    { name: "j", type: "bytes32" },
  ]}],
];

async function main() {
  const latest = Number(await client.getBlockNumber());
  const logs = await client.getLogs({
    address: FACTORY as any, event,
    fromBlock: BigInt(latest - 5000), toBlock: BigInt(latest),
  });

  // Try to find 3-curve 70% configs
  let zoraFound: any = null, creatorFound: any = null;
  
  for (let i = logs.length - 1; i >= 0 && (!zoraFound || !creatorFound); i--) {
    const log = logs[i];
    const currency = (log.args.currency as string).toLowerCase();
    const isZora = currency === ZORA_TOKEN;
    const isCreator = currency !== ZORA_TOKEN && currency !== "0x0000000000000000000000000000000000000000" && currency !== "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
    
    if ((isZora && zoraFound) || (isCreator && creatorFound) || (!isZora && !isCreator)) continue;

    const tx = await client.getTransaction({ hash: log.transactionHash });
    let pc: Hex | null = null;
    for (const abi of abis) {
      try { pc = decodeFunctionData({ abi, data: tx.input }).args[5] as Hex; break; } catch {}
    }
    if (!pc) {
      try {
        const result = await client.request({ method: "debug_traceTransaction" as any, params: [log.transactionHash, { tracer: "callTracer", tracerConfig: { onlyTopCall: false } }] }) as any;
        function find(t: any): string | null {
          if (t.to?.toLowerCase() === FACTORY) return t.input;
          if (t.calls) for (const s of t.calls) { const f = find(s); if (f) return f; }
          return null;
        }
        const fi = find(result);
        if (fi) { for (const abi of abis) { try { pc = decodeFunctionData({ abi, data: fi as Hex }).args[5] as Hex; break; } catch {} } }
      } catch {}
    }
    if (!pc) continue;

    const [ver, cur, tls, tus, nps, shs] = decodeAbiParameters(
      parseAbiParameters("uint8, address, int24[], int24[], uint16[], uint256[]"), pc);
    
    if (tls.length !== 3) continue; // Only 3-curve configs
    const totalDisc = shs.reduce((a, b) => a + Number(b) / 1e18 * 100, 0);
    if (Math.abs(totalDisc - 70) > 1) continue; // Only ~70% discovery

    const minTick = Math.min(...tls.map(Number));
    const maxTick = Math.max(...tus.map(Number));
    const entry = {
      name: log.args.name, symbol: log.args.symbol, coin: log.args.coin,
      currency, minTick, maxTick, totalDisc,
      curves: tls.map((tl: any, j: number) => ({
        tickLower: Number(tl), tickUpper: Number(tus[j]),
        rangeStart: +Math.pow(1.0001, Number(tl) - minTick).toFixed(4),
        rangeEnd: +Math.pow(1.0001, Number(tus[j]) - minTick).toFixed(4),
        share: +(Number(shs[j]) / 1e18 * 100).toFixed(1),
      })),
    };

    if (isZora && !zoraFound) zoraFound = entry;
    if (isCreator && !creatorFound) creatorFound = entry;
  }

  for (const [label, e] of [["ZORA-BACKED", zoraFound], ["CREATOR-BACKED", creatorFound]] as const) {
    if (!e) { console.log(`${label}: not found`); continue; }
    console.log(`\n${"=".repeat(60)}`);
    console.log(`${label}: ${e.name} ($${e.symbol})`);
    console.log(`  Coin: ${e.coin}`);
    console.log(`  Currency: ${e.currency}`);
    console.log(`  Launch tick: ${e.minTick}`);
    console.log(`  Top tick: ${e.maxTick}`);
    console.log(`  Range: ${Math.pow(1.0001, e.maxTick - e.minTick).toFixed(2)}x`);
    console.log(`  Discovery: ${e.totalDisc.toFixed(1)}%`);
    for (const c of e.curves) {
      console.log(`    [${c.tickLower}, ${c.tickUpper}] = ${c.rangeStart}x → ${c.rangeEnd}x, ${c.share}%`);
    }
  }

  if (zoraFound && creatorFound) {
    console.log(`\n🔑 TICK DIFFERENCE:`);
    console.log(`  ZORA launch: ${zoraFound.minTick}`);
    console.log(`  Creator launch: ${creatorFound.minTick}`);
    console.log(`  Delta: ${Math.abs(zoraFound.minTick - creatorFound.minTick)} ticks`);
    console.log(`  Price ratio: ${Math.pow(1.0001, Math.abs(zoraFound.minTick - creatorFound.minTick)).toFixed(2)}x`);
    console.log(`  The SAME curve shape (25/30/15 split over 9x range)`);
    console.log(`  But the absolute ticks are shifted so launch price matches the backing token's value`);
  }
}
main().catch(console.error);
