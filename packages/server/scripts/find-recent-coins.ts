import { createPublicClient, http, decodeFunctionData, decodeAbiParameters, parseAbiParameters, type Hex } from "viem";
import { base } from "viem/chains";
import { coinFactoryABI } from "@zoralabs/protocol-deployments";

const RPC = process.env.BASE_RPC_URL!;
const client = createPublicClient({ chain: base, transport: http(RPC) });
const FACTORY = "0x777777751622c0d3258f214F9DF38E35BF45baF3";
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
      { name: "currency0", type: "address" },
      { name: "currency1", type: "address" },
      { name: "fee", type: "uint24" },
      { name: "tickSpacing", type: "int24" },
      { name: "hooks", type: "address" },
    ]},
    { name: "poolKeyHash", type: "bytes32", indexed: false },
    { name: "version", type: "string", indexed: false },
  ],
};

const deploy8 = [{
  type: "function" as const, name: "deploy",
  inputs: [
    { name: "a", type: "address" }, { name: "b", type: "address[]" }, { name: "c", type: "string" },
    { name: "d", type: "string" }, { name: "e", type: "string" }, { name: "f", type: "bytes" },
    { name: "g", type: "address" }, { name: "h", type: "uint256" },
  ],
}];

const deploy10 = [{
  type: "function" as const, name: "deploy",
  inputs: [
    { name: "a", type: "address" }, { name: "b", type: "address[]" }, { name: "c", type: "string" },
    { name: "d", type: "string" }, { name: "e", type: "string" }, { name: "f", type: "bytes" },
    { name: "g", type: "address" }, { name: "h", type: "address" }, { name: "i", type: "bytes" },
    { name: "j", type: "bytes32" },
  ],
}];

async function main() {
  const latest = Number(await client.getBlockNumber());
  // Scan last 5000 blocks (~2.8 hours)
  const logs = await client.getLogs({
    address: FACTORY as any,
    event,
    fromBlock: BigInt(latest - 5000),
    toBlock: BigInt(latest),
  });

  console.log(`Found ${logs.length} CoinCreatedV4 events in last 5000 blocks\n`);

  // Separate by backing currency type
  const zoraBacked: typeof logs = [];
  const creatorBacked: typeof logs = [];

  for (const log of logs) {
    const currency = (log.args.currency as string).toLowerCase();
    if (currency === ZORA_TOKEN) {
      zoraBacked.push(log);
    } else if (currency !== "0x0000000000000000000000000000000000000000") {
      // Not ETH, not ZORA → creator coin backed
      creatorBacked.push(log);
    }
  }

  console.log(`ZORA-backed: ${zoraBacked.length}, Creator-backed: ${creatorBacked.length}\n`);

  // Pick one of each and decode their pool config from the tx
  async function decodeFromTx(log: any, label: string) {
    console.log(`\n${"=".repeat(60)}`);
    console.log(`${label}`);
    console.log(`${"=".repeat(60)}`);
    console.log(`  Name: ${log.args.name} ($${log.args.symbol})`);
    console.log(`  Coin: ${log.args.coin}`);
    console.log(`  Currency: ${log.args.currency}`);
    console.log(`  TX: ${log.transactionHash}`);
    console.log(`  PoolKey hooks: ${log.args.poolKey.hooks}`);
    console.log(`  PoolKey tickSpacing: ${log.args.poolKey.tickSpacing}`);

    // Try to decode pool config from tx or trace
    const tx = await client.getTransaction({ hash: log.transactionHash });
    let poolConfigHex: Hex | null = null;
    
    for (const abi of [deploy8, deploy10]) {
      try {
        const decoded = decodeFunctionData({ abi, data: tx.input });
        poolConfigHex = decoded.args[5] as Hex;
        break;
      } catch {}
    }

    if (!poolConfigHex) {
      // UserOp — need trace
      try {
        const resp = await fetch(`https://base.blockscout.com/api/v2/transactions/${log.transactionHash}/raw-trace`, { signal: AbortSignal.timeout(10000) });
        const trace = await resp.json();
        function findDeploy(t: any): string | null {
          if (t.to?.toLowerCase() === FACTORY.toLowerCase() && (t.input?.startsWith("0xc7ce4e16") || t.input?.startsWith("0xa423ada1"))) return t.input;
          if (t.calls) for (const s of t.calls) { const f = findDeploy(s); if (f) return f; }
          return null;
        }
        const deployInput = findDeploy(trace);
        if (deployInput) {
          for (const abi of [deploy8, deploy10]) {
            try { poolConfigHex = decodeFunctionData({ abi, data: deployInput as Hex }).args[5] as Hex; break; } catch {}
          }
        }
      } catch {}
    }

    if (!poolConfigHex) {
      // Try debug_traceTransaction
      try {
        const result = await client.request({
          method: "debug_traceTransaction" as any,
          params: [log.transactionHash, { tracer: "callTracer", tracerConfig: { onlyTopCall: false } }],
        }) as any;
        function findFactory(t: any): string | null {
          if (t.to?.toLowerCase() === FACTORY.toLowerCase()) return t.input;
          if (t.calls) for (const s of t.calls) { const f = findFactory(s); if (f) return f; }
          return null;
        }
        const fi = findFactory(result);
        if (fi) {
          for (const abi of [deploy8, deploy10]) {
            try { poolConfigHex = decodeFunctionData({ abi, data: fi as Hex }).args[5] as Hex; break; } catch {}
          }
        }
      } catch {}
    }

    if (!poolConfigHex) { console.log("  ❌ Could not decode pool config"); return null; }

    const [ver, cur, tls, tus, nps, shs] = decodeAbiParameters(
      parseAbiParameters("uint8, address, int24[], int24[], uint16[], uint256[]"),
      poolConfigHex,
    );
    const minTick = Math.min(...tls.map(Number));
    const maxTick = Math.max(...tus.map(Number));
    const totalDisc = shs.reduce((a, b) => a + Number(b) / 1e18 * 100, 0);
    
    console.log(`  Version: ${ver}`);
    console.log(`  Tick range: [${minTick}, ${maxTick}] = ${Math.pow(1.0001, maxTick - minTick).toFixed(2)}x`);
    console.log(`  Discovery: ${totalDisc.toFixed(1)}% / Tail: ${(100 - totalDisc).toFixed(1)}%`);
    for (let i = 0; i < tls.length; i++) {
      console.log(`    Curve ${i+1}: [${tls[i]}, ${tus[i]}] = ${Math.pow(1.0001, Number(tls[i]) - minTick).toFixed(4)}x → ${Math.pow(1.0001, Number(tus[i]) - minTick).toFixed(4)}x, ${(Number(shs[i])/1e18*100).toFixed(1)}%, ${nps[i]} pos`);
    }
    return { minTick, maxTick, ticks: tls.map(Number), currency: cur as string, totalDisc };
  }

  // Decode one ZORA-backed and one creator-backed
  let zoraResult = null, creatorResult = null;
  for (const log of zoraBacked.slice(-3)) {
    zoraResult = await decodeFromTx(log, "ZORA-BACKED COIN");
    if (zoraResult) break;
  }
  for (const log of creatorBacked.slice(-3)) {
    creatorResult = await decodeFromTx(log, "CREATOR-BACKED COIN");
    if (creatorResult) break;
  }

  if (zoraResult && creatorResult) {
    console.log("\n\n🔑 KEY DIFFERENCE:");
    console.log(`  ZORA-backed launch tick: ${zoraResult.minTick}`);
    console.log(`  Creator-backed launch tick: ${creatorResult.minTick}`);
    console.log(`  Tick difference: ${Math.abs(zoraResult.minTick - creatorResult.minTick)}`);
    console.log(`  Price ratio: ${Math.pow(1.0001, Math.abs(zoraResult.minTick - creatorResult.minTick)).toFixed(2)}x`);
  }
}

main().catch(console.error);
