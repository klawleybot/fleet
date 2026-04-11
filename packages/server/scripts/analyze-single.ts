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

async function main() {
  const coinAddr = "0x4d70f5970b0B6b3EDc7c9e6E4Ceb69e8b8F9E642";
  
  // Get creation tx
  const resp = await fetch(`https://base.blockscout.com/api/v2/addresses/${coinAddr}`);
  const data = await resp.json();
  const txHash = data.creation_transaction_hash || data.creation_tx_hash;
  if (!txHash) { console.log("No creation tx found"); return; }
  console.log(`TX: ${txHash}`);

  const receipt = await client.getTransactionReceipt({ hash: txHash as `0x${string}` });
  let coinName = "", symbol = "", currency = "";
  for (const log of receipt.logs) {
    try {
      const decoded = decodeEventLog({ abi: [coinCreatedV4Event], data: log.data, topics: log.topics });
      if (decoded.eventName === "CoinCreatedV4") {
        coinName = decoded.args.name;
        symbol = decoded.args.symbol;
        currency = decoded.args.currency;
        break;
      }
    } catch {}
  }
  console.log(`Name: ${coinName} ($${symbol})`);
  console.log(`Currency: ${currency}`);

  // Try direct decode
  const tx = await client.getTransaction({ hash: txHash as `0x${string}` });
  let poolConfigHex: Hex | null = null;
  
  try {
    const decoded = decodeFunctionData({ abi: deployAbi, data: tx.input });
    poolConfigHex = decoded.args[5] as Hex;
  } catch {
    // Try trace
    const rawTraceResp = await fetch(`https://base.blockscout.com/api/v2/transactions/${txHash}/raw-trace`);
    const rawTrace = await rawTraceResp.json();
    
    function findDeploy(trace: any): string | null {
      if (trace.to?.toLowerCase() === FACTORY.toLowerCase() && trace.input?.startsWith("0xa423ada1")) return trace.input;
      if (trace.calls) for (const sub of trace.calls) { const f = findDeploy(sub); if (f) return f; }
      return null;
    }
    const deployInput = findDeploy(rawTrace);
    if (deployInput) {
      const decoded = decodeFunctionData({ abi: deployAbi, data: deployInput as Hex });
      poolConfigHex = decoded.args[5] as Hex;
    }
  }

  if (!poolConfigHex) { console.log("Could not extract poolConfig"); return; }

  const params = parseAbiParameters("uint8, address, int24[], int24[], uint16[], uint256[]");
  const [version, curr, tickLowers, tickUppers, numPositions, shares] = decodeAbiParameters(params, poolConfigHex);

  const minTick = Math.min(...tickLowers.map(Number));
  
  // Convert to multiples relative to launch tick
  const curves = [];
  for (let i = 0; i < tickLowers.length; i++) {
    const rangeStart = Math.pow(1.0001, Number(tickLowers[i]) - minTick);
    const rangeEnd = Math.pow(1.0001, Number(tickUppers[i]) - minTick);
    const sharePercent = Number(shares[i]) / 1e18 * 100;
    curves.push({ rangeStart: +rangeStart.toFixed(4), rangeEnd: +rangeEnd.toFixed(4), sharePercent: +sharePercent.toFixed(1) });
  }

  const totalDisc = curves.reduce((a, c) => a + c.sharePercent, 0);
  console.log(`\nVersion: ${version}`);
  console.log(`Curves: ${curves.length}`);
  console.log(`Discovery: ${totalDisc.toFixed(1)}% / Tail: ${(100 - totalDisc).toFixed(1)}%`);
  console.log(`\nCURVE_JSON=${JSON.stringify({ name: coinName, symbol, currency: curr, curves, totalDiscovery: totalDisc })}`);
}

main().catch(console.error);
