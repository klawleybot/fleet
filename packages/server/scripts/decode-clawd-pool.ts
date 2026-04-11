import { createPublicClient, http, type Address, type Hex, parseAbiParameters, decodeAbiParameters } from "viem";
import { base } from "viem/chains";
import { coinABI } from "@zoralabs/protocol-deployments";

const RPC = process.env.BASE_RPC_URL || "https://mainnet.base.org";
const client = createPublicClient({ chain: base, transport: http(RPC) });

const CLAWD = "0x4d70f5970b0B6b3EDc7c9e6E4Ceb69e8b8F9E642" as Address;

async function main() {
  // 1. Get the pool key from the coin contract
  const poolKey = await client.readContract({
    address: CLAWD,
    abi: coinABI,
    functionName: "getPoolKey",
  });
  console.log("Pool Key:");
  console.log("  currency0:", poolKey.currency0);
  console.log("  currency1:", poolKey.currency1);
  console.log("  fee:", poolKey.fee);
  console.log("  tickSpacing:", poolKey.tickSpacing);
  console.log("  hooks (Doppler):", poolKey.hooks);

  // 2. Get total supply
  const totalSupply = await client.readContract({
    address: CLAWD,
    abi: [{ type: "function", name: "totalSupply", inputs: [], outputs: [{ type: "uint256" }], stateMutability: "view" }],
    functionName: "totalSupply",
  });
  console.log("\nTotal supply:", (Number(totalSupply) / 1e18).toLocaleString());

  // 3. Read the Doppler hook state to get actual positions
  // The Doppler hook stores position data — let's read slot0 of the pool via PoolManager
  const POOL_MANAGER = "0x498581ff718922c3f8e6a244956af099b2652b2b" as Address;
  
  // Get current tick from slot0
  const slot0Data = await client.readContract({
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
    args: [await client.readContract({
      address: CLAWD,
      abi: coinABI,
      functionName: "poolKeyHash",
    })],
  });
  
  console.log("\nPool State (slot0):");
  console.log("  sqrtPriceX96:", slot0Data[0].toString());
  console.log("  current tick:", slot0Data[1]);
  
  // 4. Get liquidity
  const liquidity = await client.readContract({
    address: POOL_MANAGER,
    abi: [{
      type: "function", name: "getLiquidity",
      inputs: [{ name: "id", type: "bytes32" }],
      outputs: [{ name: "", type: "uint128" }],
      stateMutability: "view",
    }],
    functionName: "getLiquidity",
    args: [await client.readContract({
      address: CLAWD,
      abi: coinABI,
      functionName: "poolKeyHash",
    })],
  });
  console.log("  liquidity:", liquidity.toString());

  // 5. Read positions from the Doppler hook
  // DopplerV4 stores numPdSlugs, pdSlugs array with tick ranges
  const hooksAddr = poolKey.hooks;
  const poolKeyHash = await client.readContract({
    address: CLAWD,
    abi: coinABI,
    functionName: "poolKeyHash",
  });
  
  // Try to read the state from the Doppler hook
  // getState(PoolId) returns the full Doppler state
  try {
    const state = await client.readContract({
      address: hooksAddr,
      abi: [{
        type: "function", name: "getState",
        inputs: [{ name: "poolId", type: "bytes32" }],
        outputs: [{
          name: "", type: "tuple",
          components: [
            { name: "lastTick", type: "int24" },
            { name: "tickLower", type: "int24" },
            { name: "tickUpper", type: "int24" },
            { name: "numPdSlugs", type: "uint16" },
            { name: "totalTokensSold", type: "uint256" },
            { name: "totalProceeds", type: "uint256" },
            { name: "totalTokensSoldLastEpoch", type: "uint256" },
            { name: "totalProceedsLastEpoch", type: "uint256" },
          ],
        }],
        stateMutability: "view",
      }],
      functionName: "getState",
      args: [poolKeyHash],
    });
    console.log("\nDoppler State:");
    console.log("  lastTick:", state.lastTick);
    console.log("  tickLower:", state.tickLower);
    console.log("  tickUpper:", state.tickUpper);
    console.log("  numPdSlugs:", state.numPdSlugs);
    console.log("  totalTokensSold:", (Number(state.totalTokensSold) / 1e18).toLocaleString());
    console.log("  totalProceeds:", (Number(state.totalProceeds) / 1e18).toLocaleString());
    
    const pctSold = Number(state.totalTokensSold) / Number(totalSupply) * 100;
    console.log("  % of supply sold:", pctSold.toFixed(2) + "%");
  } catch (e: any) {
    console.log("\ngetState failed:", e.message?.slice(0, 120));
  }

  // 6. Try to read individual position slugs from the Doppler hook
  // The hook stores slugs as mapping(PoolId => Slug[])
  // Let's try getSlug(poolId, index)
  for (let i = 0; i < 40; i++) {
    try {
      const slug = await client.readContract({
        address: hooksAddr,
        abi: [{
          type: "function", name: "getSlug",
          inputs: [{ name: "poolId", type: "bytes32" }, { name: "index", type: "uint256" }],
          outputs: [{
            name: "", type: "tuple",
            components: [
              { name: "tickLower", type: "int24" },
              { name: "tickUpper", type: "int24" },
              { name: "liquidity", type: "uint128" },
            ],
          }],
          stateMutability: "view",
        }],
        functionName: "getSlug",
        args: [poolKeyHash, BigInt(i)],
      });
      if (slug.liquidity === 0n && i > 5) break;
      const priceRange = Math.pow(1.0001, slug.tickUpper - slug.tickLower);
      console.log(`  Slug ${i}: [${slug.tickLower}, ${slug.tickUpper}] Δ${slug.tickUpper - slug.tickLower} liq=${slug.liquidity.toString()} (${priceRange.toFixed(2)}x range)`);
    } catch {
      if (i === 0) console.log("  getSlug not available");
      break;
    }
  }
}

main().catch(console.error);
