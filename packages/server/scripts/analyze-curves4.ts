/**
 * Analyze Doppler curves by reading pool state from PoolManager + Doppler hook.
 * Instead of tracing deploy txs, we read the current position state.
 */
import { createPublicClient, http, type Address, type Hex, keccak256, encodePacked, encodeAbiParameters, parseAbiParameters, decodeAbiParameters } from "viem";
import { base } from "viem/chains";

const client = createPublicClient({ chain: base, transport: http("https://mainnet.base.org") });

// Zora V4 PoolManager on Base
const POOL_MANAGER = "0x498581ff718922c3f8e6a244956af099b2652b2b" as Address;

// Known coins to analyze
const coins: Record<string, { addr: string; type: string; pairedWith?: string }> = {
  "Creator Coin (nealianokid)": { addr: "0x989d9e051265a86587f9731b79105e7b4224bd91", type: "creator" },
  "Trending Coin (earlylifecrisis)": { addr: "0x272c334b84147dff986b6a007a465abb3c1916c2", type: "trending" },
  "Content → Creator": { addr: "0xb02e6fff372bd17fe257e8766191da6884856e8f", type: "content-creator", pairedWith: "0x989d9e051265a86587f9731b79105e7b4224bd91" },
  "Content → Trending": { addr: "0xb2fdf0139d2e4545c7130f745ae5d0c4d4b5a27f", type: "content-trending", pairedWith: "0x272c334b84147dff986b6a007a465abb3c1916c2" },
};

// Let's try another approach: use Zora's GraphQL API to get coin details
async function getZoraCoinData(addr: string) {
  // Try the Zora coins API with the correct endpoint
  const queries = [
    `https://zora.co/api/coins/base:${addr}`,
    `https://api-sdk.zora.engineering/coins?chainId=8453&coin=${addr}`,
  ];
  
  for (const url of queries) {
    try {
      const resp = await fetch(url, { headers: { "Accept": "application/json" } });
      if (resp.ok) {
        const data = await resp.json();
        return data;
      }
    } catch {}
  }
  return null;
}

// Try to find creation tx via multiple methods
async function findCreationTx(addr: string): Promise<string | null> {
  // Method 1: Blockscout token transfers
  try {
    const resp = await fetch(`https://base.blockscout.com/api?module=account&action=tokentx&contractaddress=${addr}&page=1&offset=5&sort=asc`);
    const data = await resp.json();
    if (data.result?.[0]?.hash) return data.result[0].hash;
  } catch {}

  // Method 2: Blockscout logs - Transfer from 0x0 (mint)
  try {
    const resp = await fetch(`https://base.blockscout.com/api?module=logs&action=getLogs&address=${addr}&topic0=0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef&topic1=0x0000000000000000000000000000000000000000000000000000000000000000&fromBlock=0&toBlock=latest&page=1&offset=1`);
    const data = await resp.json();
    if (data.result?.[0]?.transactionHash) return data.result[0].transactionHash;
  } catch {}

  // Method 3: Blockscout internal transactions to the address
  try {
    const resp = await fetch(`https://base.blockscout.com/api/v2/addresses/${addr}/internal-transactions?filter=to`);
    const data = await resp.json();
    if (data.items?.[0]?.transaction_hash) return data.items[0].transaction_hash;
  } catch {}

  // Method 4: Search factory logs for recent CoinCreatedV4 events
  // CoinCreatedV4 topic0
  const topic0 = keccak256(encodePacked(["string"], ["CoinCreatedV4(address,address,address,address,string,string,string,address,(address,address,uint24,int24,address),bytes32,string)"]));
  try {
    // Get recent blocks
    const blockNum = await client.getBlockNumber();
    const fromBlock = blockNum - 200000n; // ~5 days of blocks
    const resp = await fetch(`https://base.blockscout.com/api?module=logs&action=getLogs&address=0x777777751622c0d3258f214F9DF38E35BF45baF3&topic0=${topic0}&fromBlock=${fromBlock}&toBlock=latest&page=1&offset=100`);
    const data = await resp.json();
    // Can't filter by non-indexed coin address, would need to decode each log
    // Skip this approach - too many logs
  } catch {}

  return null;
}

// Read the coin's token info and pool info via direct contract reads
async function readCoinInfo(addr: string) {
  const coinAddr = addr as Address;
  
  // Read name, symbol, totalSupply
  const [name, symbol, totalSupply] = await Promise.all([
    client.readContract({ address: coinAddr, abi: [{ type: "function", name: "name", inputs: [], outputs: [{ type: "string" }], stateMutability: "view" }], functionName: "name" }),
    client.readContract({ address: coinAddr, abi: [{ type: "function", name: "symbol", inputs: [], outputs: [{ type: "string" }], stateMutability: "view" }], functionName: "symbol" }),
    client.readContract({ address: coinAddr, abi: [{ type: "function", name: "totalSupply", inputs: [], outputs: [{ type: "uint256" }], stateMutability: "view" }], functionName: "totalSupply" }),
  ]);
  
  return { name: name as string, symbol: symbol as string, totalSupply: totalSupply as bigint };
}

// Try to read pool config from the coin contract itself (some Zora coins expose this)
async function readPoolConfig(addr: string) {
  const coinAddr = addr as Address;
  
  // Try reading poolConfig / getPoolConfig / poolState
  const configABIs = [
    { type: "function" as const, name: "poolConfig", inputs: [], outputs: [{ type: "bytes" }], stateMutability: "view" as const },
    { type: "function" as const, name: "getPoolConfig", inputs: [], outputs: [{ type: "bytes" }], stateMutability: "view" as const },
    { type: "function" as const, name: "poolKey", inputs: [], outputs: [
      { type: "address", name: "currency0" },
      { type: "address", name: "currency1" },
      { type: "uint24", name: "fee" },
      { type: "int24", name: "tickSpacing" },
      { type: "address", name: "hooks" },
    ], stateMutability: "view" as const },
    { type: "function" as const, name: "hook", inputs: [], outputs: [{ type: "address" }], stateMutability: "view" as const },
    { type: "function" as const, name: "currency", inputs: [], outputs: [{ type: "address" }], stateMutability: "view" as const },
  ];
  
  const results: Record<string, any> = {};
  for (const abi of configABIs) {
    try {
      const result = await client.readContract({ address: coinAddr, abi: [abi], functionName: abi.name as any });
      results[abi.name] = result;
    } catch {}
  }
  
  return results;
}

// Get the Doppler hook address and read position state
async function readDopplerState(hookAddr: string, coinAddr: string, currencyAddr: string) {
  const hook = hookAddr as Address;
  
  // The Doppler hook stores positions. Let's try to read them.
  // Common Doppler hook functions:
  const hookABIs = [
    { type: "function" as const, name: "getState", inputs: [{ type: "bytes32", name: "poolId" }], outputs: [{ type: "tuple", components: [
      { type: "int24", name: "tickLower" },
      { type: "int24", name: "tickUpper" },
      { type: "uint256", name: "totalProceeds" },
      { type: "uint256", name: "totalTokensSold" },
    ]}], stateMutability: "view" as const },
    { type: "function" as const, name: "getPositions", inputs: [{ type: "bytes32", name: "poolId" }], outputs: [{ type: "tuple[]", components: [
      { type: "int24", name: "tickLower" },
      { type: "int24", name: "tickUpper" },
      { type: "uint128", name: "liquidity" },
    ]}], stateMutability: "view" as const },
    { type: "function" as const, name: "numTokensToSell", inputs: [{ type: "bytes32", name: "poolId" }], outputs: [{ type: "uint256" }], stateMutability: "view" as const },
  ];
  
  // Compute poolId = keccak256(abi.encode(currency0, currency1, fee, tickSpacing, hooks))
  // We need the pool key components...
  
  return {};
}

async function main() {
  for (const [label, info] of Object.entries(coins)) {
    console.log(`\n${"=".repeat(70)}`);
    console.log(`📊 ${label}: ${info.addr}`);
    console.log("=".repeat(70));
    
    // Basic token info
    const tokenInfo = await readCoinInfo(info.addr);
    console.log(`  Name: ${tokenInfo.name} ($${tokenInfo.symbol})`);
    console.log(`  Total Supply: ${(Number(tokenInfo.totalSupply) / 1e18).toLocaleString()}`);
    
    // Pool config from contract
    const poolInfo = await readPoolConfig(info.addr);
    if (Object.keys(poolInfo).length > 0) {
      console.log(`  Contract reads:`, JSON.stringify(poolInfo, (k, v) => typeof v === 'bigint' ? v.toString() : v));
    }
    
    // Try finding creation tx
    const txHash = await findCreationTx(info.addr);
    if (txHash) {
      console.log(`  Creation TX: ${txHash}`);
      
      // Get raw trace
      const traceResp = await fetch(`https://base.blockscout.com/api/v2/transactions/${txHash}/raw-trace`);
      const rawTrace = await traceResp.json();
      
      const FACTORY = "0x777777751622c0d3258f214f9df38e35bf45baf3";
      // All known factory deploy selectors
      const SELECTORS = ["0xa423ada1", "0xa27a6dce", "0xc7ce4e16", "0xf4858a9a", "0x3c7bca94", "0x0d36fc77"];
      
      function findCalls(trace: any): string[] {
        const results: string[] = [];
        if (trace.to?.toLowerCase() === FACTORY) {
          const sel = trace.input?.slice(0, 10);
          if (SELECTORS.includes(sel)) results.push(trace.input);
        }
        if (trace.calls) for (const sub of trace.calls) results.push(...findCalls(sub));
        return results;
      }
      
      const deployCalls = findCalls(rawTrace);
      console.log(`  Factory calls found: ${deployCalls.length}`);
      
      for (const calldata of deployCalls) {
        // Try to decode with coinFactoryABI
        const { coinFactoryABI } = await import("@zoralabs/protocol-deployments");
        try {
          const decoded = decodeFunctionData({ abi: coinFactoryABI, data: calldata as Hex });
          console.log(`  Function: ${decoded.functionName}`);
          const args = decoded.args as any[];
          
          // Find bytes args that could be poolConfig
          for (let i = 0; i < args.length; i++) {
            const arg = args[i];
            if (typeof arg === "string" && arg.startsWith("0x") && arg.length > 200) {
              try {
                const params = parseAbiParameters("uint8, address, int24[], int24[], uint16[], uint256[]");
                const [version, currency, tickLowers, tickUppers, numPositions, shares] = decodeAbiParameters(params, arg as Hex);
                if (Number(version) >= 1 && tickLowers.length > 0) {
                  const totalSharePct = Number(shares.reduce((a, b) => a + b, 0n)) / 1e18 * 100;
                  console.log(`\n  ✅ Pool Config Found (arg ${i}):`);
                  console.log(`  Version: ${version}, Currency: ${currency}`);
                  console.log(`  Discovery: ${totalSharePct.toFixed(1)}% | Tail: ${(100-totalSharePct).toFixed(1)}%`);
                  for (let j = 0; j < tickLowers.length; j++) {
                    console.log(`  Curve ${j+1}: [${tickLowers[j]}, ${tickUppers[j]}] Δ${Number(tickUppers[j])-Number(tickLowers[j])}, ${numPositions[j]} pos, ${(Number(shares[j])/1e18*100).toFixed(1)}%`);
                  }
                  const minT = Math.min(...tickLowers.map(Number));
                  const maxT = Math.max(...tickUppers.map(Number));
                  console.log(`  Range: ${Math.pow(1.0001, maxT - minT).toFixed(1)}×`);
                }
              } catch {}
            }
          }
        } catch (e: any) {
          console.log(`  ⚠️ Decode error: ${e.message?.slice(0,80)}`);
        }
      }
    } else {
      console.log("  ❌ No creation tx found via any method");
    }
  }
}

main().catch(console.error);
