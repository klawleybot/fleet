import { createPublicClient, http, decodeFunctionData, decodeAbiParameters, parseAbiParameters, type Hex } from "viem";
import { base } from "viem/chains";

const RPC = process.env.BASE_RPC_URL!;
const client = createPublicClient({ chain: base, transport: http(RPC) });
const FACTORY = "0x777777751622c0d3258f214f9df38e35bf45baf3";
const ZORA_TOKEN = "0x1111111111166b7fe7bd91427724b487980afc69";
const USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";

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

async function decodePoolConfig(txHash: string) {
  // Try direct decode first
  const tx = await client.getTransaction({ hash: txHash as `0x${string}` });
  for (const abi of abis) {
    try {
      const d = decodeFunctionData({ abi, data: tx.input });
      return d.args[5] as Hex;
    } catch {}
  }
  // Try trace via dRPC
  try {
    const result = await client.request({
      method: "debug_traceTransaction" as any,
      params: [txHash, { tracer: "callTracer", tracerConfig: { onlyTopCall: false } }],
    }) as any;
    function find(t: any): string | null {
      if (t.to?.toLowerCase() === FACTORY) return t.input;
      if (t.calls) for (const s of t.calls) { const f = find(s); if (f) return f; }
      return null;
    }
    const fi = find(result);
    if (fi) {
      for (const abi of abis) {
        try { return decodeFunctionData({ abi, data: fi as Hex }).args[5] as Hex; } catch {}
      }
    }
  } catch {}
  return null;
}

async function main() {
  const latest = Number(await client.getBlockNumber());
  const logs = await client.getLogs({
    address: FACTORY as any, event,
    fromBlock: BigInt(latest - 5000), toBlock: BigInt(latest),
  });

  // Filter: creator-backed (not ZORA, not ETH, not USDC)
  const creatorBacked = logs.filter(l => {
    const c = (l.args.currency as string).toLowerCase();
    return c !== ZORA_TOKEN && c !== USDC && c !== "0x0000000000000000000000000000000000000000";
  });

  console.log(`Total: ${logs.length}, Creator-backed: ${creatorBacked.length}`);
  
  // Try to decode the last few
  let found = 0;
  for (let i = creatorBacked.length - 1; i >= 0 && found < 2; i--) {
    const log = creatorBacked[i];
    const pc = await decodePoolConfig(log.transactionHash);
    if (!pc) continue;
    
    const [ver, cur, tls, tus, nps, shs] = decodeAbiParameters(
      parseAbiParameters("uint8, address, int24[], int24[], uint16[], uint256[]"), pc);
    const minTick = Math.min(...tls.map(Number));
    const maxTick = Math.max(...tus.map(Number));
    const totalDisc = shs.reduce((a, b) => a + Number(b) / 1e18 * 100, 0);
    
    console.log(`\n${"=".repeat(60)}`);
    console.log(`CREATOR-BACKED #${found+1}: ${log.args.name} ($${log.args.symbol})`);
    console.log(`  Coin: ${log.args.coin}`);
    console.log(`  Backing: ${log.args.currency}`);
    console.log(`  Ticks: [${minTick}, ${maxTick}] = ${Math.pow(1.0001, maxTick - minTick).toFixed(2)}x`);
    console.log(`  Discovery: ${totalDisc.toFixed(1)}%`);
    for (let j = 0; j < tls.length; j++) {
      console.log(`    C${j+1}: [${tls[j]}, ${tus[j]}] = ${Math.pow(1.0001, Number(tls[j]) - minTick).toFixed(4)}x → ${Math.pow(1.0001, Number(tus[j]) - minTick).toFixed(4)}x, ${(Number(shs[j])/1e18*100).toFixed(1)}%`);
    }
    found++;
  }
}
main().catch(console.error);
