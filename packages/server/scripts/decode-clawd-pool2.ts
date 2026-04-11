import { createPublicClient, http, type Address, type Hex, keccak256, encodeAbiParameters } from "viem";
import { base } from "viem/chains";
import { coinABI } from "@zoralabs/protocol-deployments";

const RPC = process.env.BASE_RPC_URL || "https://mainnet.base.org";
const client = createPublicClient({ chain: base, transport: http(RPC) });

const CLAWD = "0x4d70f5970b0B6b3EDc7c9e6E4Ceb69e8b8F9E642" as Address;
const POOL_MANAGER = "0x498581ff718922c3f8e6a244956af099b2652b2b" as Address;
const DOPPLER_HOOK = "0x0469a4Bd3724DC86C9542F4694c976DA13C450c0" as Address;

// Pool key from previous output
const poolKey = {
  currency0: "0x1742c7d9D55f7279009FC85041B269ba5f368A71" as Address,
  currency1: "0x4d70f5970b0B6b3EDc7c9e6E4Ceb69e8b8F9E642" as Address,
  fee: 8388608,
  tickSpacing: 200,
  hooks: "0x0469a4Bd3724DC86C9542F4694c976DA13C450c0" as Address,
};

async function main() {
  // Compute PoolId = keccak256(abi.encode(poolKey))
  const poolId = keccak256(encodeAbiParameters(
    [{ type: "address" }, { type: "address" }, { type: "uint24" }, { type: "int24" }, { type: "address" }],
    [poolKey.currency0, poolKey.currency1, poolKey.fee, poolKey.tickSpacing, poolKey.hooks],
  ));
  console.log("PoolId:", poolId);

  // slot0
  const [sqrtPriceX96, tick, protocolFee, lpFee] = await client.readContract({
    address: POOL_MANAGER,
    abi: [{
      type: "function", name: "getSlot0",
      inputs: [{ name: "id", type: "bytes32" }],
      outputs: [
        { name: "sqrtPriceX96", type: "uint160" },
        { name: "tick", type: "int24" },
        { name: "protocolFee", type: "uint24" },
        { name: "lpFee", type: "uint24" },
      ],
      stateMutability: "view",
    }],
    functionName: "getSlot0",
    args: [poolId],
  });

  console.log("Current tick:", tick);
  console.log("sqrtPriceX96:", sqrtPriceX96.toString());

  // liquidity
  const liq = await client.readContract({
    address: POOL_MANAGER,
    abi: [{
      type: "function", name: "getLiquidity",
      inputs: [{ name: "id", type: "bytes32" }],
      outputs: [{ name: "", type: "uint128" }],
      stateMutability: "view",
    }],
    functionName: "getLiquidity",
    args: [poolId],
  });
  console.log("Current liquidity:", liq.toString());

  // Now let's get the Doppler hook state
  // Try getState / getPositionState / positions
  const tryABIs = [
    { name: "getState", abi: [{ type: "function", name: "getState", inputs: [{ name: "poolId", type: "bytes32" }], outputs: [{ name: "", type: "tuple", components: [{ name: "lastTick", type: "int24" },{ name: "tickLower", type: "int24" },{ name: "tickUpper", type: "int24" },{ name: "numPdSlugs", type: "uint16" },{ name: "totalTokensSold", type: "uint256" },{ name: "totalProceeds", type: "uint256" },{ name: "totalTokensSoldLastEpoch", type: "uint256" },{ name: "totalProceedsLastEpoch", type: "uint256" }] }], stateMutability: "view" }] },
  ];

  for (const { name, abi } of tryABIs) {
    try {
      const result = await client.readContract({ address: DOPPLER_HOOK, abi, functionName: name, args: [poolId] });
      console.log(`\n${name}:`, JSON.stringify(result, (_, v) => typeof v === 'bigint' ? v.toString() : v, 2));
    } catch (e: any) {
      console.log(`${name}: failed (${e.message?.slice(0, 80)})`);
    }
  }

  // Try reading slugs
  for (let i = 0; i < 40; i++) {
    try {
      const result = await client.readContract({
        address: DOPPLER_HOOK,
        abi: [{
          type: "function", name: "getSlug",
          inputs: [{ name: "poolId", type: "bytes32" }, { name: "index", type: "uint256" }],
          outputs: [{ name: "", type: "tuple", components: [
            { name: "tickLower", type: "int24" },
            { name: "tickUpper", type: "int24" },
            { name: "liquidity", type: "uint128" },
          ]}],
          stateMutability: "view",
        }],
        functionName: "getSlug",
        args: [poolId, BigInt(i)],
      });
      console.log(`Slug ${i}: [${result.tickLower}, ${result.tickUpper}] liq=${result.liquidity.toString()}`);
    } catch (e: any) {
      if (i === 0) {
        console.log("getSlug failed:", e.message?.slice(0, 100));
        // Try positions mapping
        try {
          const result = await client.readContract({
            address: DOPPLER_HOOK,
            abi: [{
              type: "function", name: "positions",
              inputs: [{ name: "poolId", type: "bytes32" }, { name: "index", type: "uint256" }],
              outputs: [
                { name: "tickLower", type: "int24" },
                { name: "tickUpper", type: "int24" },
                { name: "liquidity", type: "uint128" },
              ],
              stateMutability: "view",
            }],
            functionName: "positions",
            args: [poolId, BigInt(0)],
          });
          console.log("positions(0):", result);
        } catch { console.log("positions also failed"); }
      }
      break;
    }
  }

  // Get the creation tx via blockscout token-transfers to find the actual deploy calldata
  console.log("\n--- Trying to find deploy tx via token transfers ---");
  try {
    const resp = await fetch(`https://base.blockscout.com/api/v2/tokens/${CLAWD}/transfers?type=ERC-20`, { signal: AbortSignal.timeout(10000) });
    const data = await resp.json();
    const items = data.items || [];
    // Find the first mint (from = 0x000...)
    const mint = items.find((t: any) => t.from?.hash === "0x0000000000000000000000000000000000000000");
    if (mint) {
      console.log("Mint TX:", mint.transaction_hash || mint.tx_hash);
    }
    // Also log the latest few to understand trade sizes
    console.log("\nRecent transfers:");
    for (const t of items.slice(0, 5)) {
      const amount = Number(t.total?.value || t.value || 0) / 1e18;
      console.log(`  ${t.from?.hash?.slice(0,10)} → ${t.to?.hash?.slice(0,10)}: ${amount.toLocaleString()} tokens (tx: ${(t.transaction_hash || t.tx_hash || '').slice(0,20)})`);
    }
  } catch (e: any) {
    console.log("Token transfer fetch failed:", e.message?.slice(0, 80));
  }

  // Calculate price from sqrtPriceX96
  const price = Number(sqrtPriceX96) ** 2 / (2 ** 192);
  console.log("\nDerived price (currency0/currency1):", price.toExponential(4));
  console.log("Inverse (currency1/currency0):", (1/price).toExponential(4));

  // Tick ranges from our gradual profile
  const launchTick = -50800; // from SDK output
  const currentMultiple = Math.pow(1.0001, tick - launchTick);
  console.log("\nCurrent tick:", tick, "vs launch tick:", launchTick);
  console.log("Current multiple vs launch:", currentMultiple.toFixed(4) + "x");
}

main().catch(console.error);
