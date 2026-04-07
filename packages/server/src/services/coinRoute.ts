/**
 * Zora Coin Route Resolver
 *
 * Automatically discovers the full swap path for any Zora coin by:
 * 1. Walking the coin ancestry via currency() calls (coin → parent → ... → ZORA)
 * 2. Reading pool params from each coin's storage slots (EIP-1167 proxy pattern)
 * 3. Prepending the ETH/ZORA standard V4 pool hop
 *
 * Returns a complete buy/sell route with pool params for each hop.
 */
import { type Address, type Hex } from "viem";
import type { HopPoolParams } from "./swapRoute.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const NATIVE_ETH = "0x0000000000000000000000000000000000000000";
const ZORA_TOKEN: Address = "0x1111111111166b7FE7bd91427724B487980aFc69";
const USDC_BASE: Address = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const WETH_BASE: Address = "0x4200000000000000000000000000000000000006";

/** Known terminal anchor tokens — any of these ends the ancestry walk. */
const TERMINAL_ANCHORS = new Set([
  ZORA_TOKEN.toLowerCase(),
  USDC_BASE.toLowerCase(),
  WETH_BASE.toLowerCase(),
]);

/** ETH(native) / ZORA standard V4 pool — discovered via on-chain quoting. */
const ETH_ZORA_HOP: HopPoolParams = {
  fee: 3000,
  tickSpacing: 60,
  hooks: NATIVE_ETH as `0x${string}`,
  hookData: "0x",
};

/** USDC / ETH standard Uniswap V3 pool on Base (0.05% fee, no hooks). */
const ETH_USDC_HOP: HopPoolParams = {
  fee: 500,
  tickSpacing: 10,
  hooks: NATIVE_ETH as `0x${string}`,
  hookData: "0x",
};

// Minimal ABIs
const currencyAbi = [
  {
    name: "currency",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
] as const;

const balanceOfAbi = [
  {
    name: "balanceOf",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

// ---------------------------------------------------------------------------
// Minimal client interface (no `as any`)
// ---------------------------------------------------------------------------

export interface CoinRouteClient {
  readContract(args: {
    address: Address;
    abi: readonly Record<string, unknown>[];
    functionName: string;
    args?: readonly unknown[];
  }): Promise<unknown>;
  getStorageAt(args: { address: Address; slot: Hex }): Promise<Hex | undefined>;
}

// ---------------------------------------------------------------------------
// Storage slot parsing
// ---------------------------------------------------------------------------

/**
 * Read Doppler pool params from a Zora coin's storage slots.
 *
 * Zora coins are EIP-1167 minimal proxies. Their storage layout packs:
 * - One slot contains: [padding][tickSpacing:2bytes][fee:2bytes][currency:20bytes]
 * - A nearby slot contains the hook address
 *
 * The exact slot positions depend on the coin version. We scan slots 2-10
 * to find the pattern.
 */
async function readPoolParamsFromStorage(
  client: CoinRouteClient,
  coinAddress: Address,
): Promise<HopPoolParams | null> {
  // Read slots 2-14 (covers known Zora coin layouts)
  const slots: (Hex | undefined)[] = [];
  for (let i = 0; i <= 14; i++) {
    const slot = ("0x" + i.toString(16).padStart(64, "0")) as Hex;
    slots.push(await client.getStorageAt({ address: coinAddress, slot }));
  }

  // Find the slot that contains the currency address packed with fee/tickSpacing.
  // Pattern: last 20 bytes = an address, bytes before = fee + tickSpacing
  // We look for slots where the last 20 bytes match a known currency.

  // First, get the currency via the view function
  let currency: Address;
  try {
    currency = (await client.readContract({
      address: coinAddress,
      abi: currencyAbi,
      functionName: "currency",
    })) as Address;
  } catch {
    return null;
  }

  const currencyLower = currency.toLowerCase().slice(2); // remove 0x
  const coinLower = coinAddress.toLowerCase().slice(2);

  // Find the slot containing currency OR the coin's own address packed with fee/tickSpacing.
  //
  // Zora coin storage layout (32 bytes):
  //   [12 bytes padding] [1 byte tickSpacing] [1 byte padding] [2 bytes fee] [20 bytes currency]
  //
  // In hex (64 chars):
  //   chars [0..23]  = padding
  //   chars [16..17] = tickSpacing (uint8, e.g. 0xc8 = 200)
  //   chars [18..19] = padding (0x00)
  //   chars [20..23] = fee (uint16, e.g. 0x2710 = 10000)
  //   chars [24..63] = currency address
  //
  // The hooks address is in the next non-zero slot (last 20 bytes).

  for (let i = 0; i < slots.length; i++) {
    const val = slots[i];
    if (!val || val === "0x" + "0".repeat(64)) continue;

    const hex = val.slice(2); // remove 0x
    const last20 = hex.slice(24).toLowerCase();
    // Check if last 20 bytes match currency OR the coin itself (different layout variants)
    if (last20 !== currencyLower && last20 !== coinLower) continue;

    const prefix = hex.slice(0, 24);
    // Extract fee (chars 20-23) and tickSpacing (chars 16-17)
    const fee = parseInt(prefix.slice(20, 24), 16);
    const tickSpacing = parseInt(prefix.slice(16, 18), 16);

    // Validate
    if (fee <= 0 || fee > 100000 || tickSpacing <= 0 || tickSpacing > 16384) continue;

    // Find hooks address in the next non-zero slot
    for (let j = i + 1; j < Math.min(i + 3, slots.length); j++) {
      const hookSlot = slots[j];
      if (!hookSlot || hookSlot === "0x" + "0".repeat(64)) continue;
      const hookHex = hookSlot.slice(2);
      const hookAddr = hookHex.slice(24);
      if (hookAddr.length === 40 && hookAddr !== "0".repeat(40)) {
        return {
          fee,
          tickSpacing,
          hooks: `0x${hookAddr}`,
          hookData: "0x",
        };
      }
    }

    // No hook found — standard pool
    return { fee, tickSpacing, hooks: NATIVE_ETH, hookData: "0x" };
  }

  return null;
}

// ---------------------------------------------------------------------------
// Route types
// ---------------------------------------------------------------------------

export interface CoinRoute {
  /** Full token path for buy: [ETH(native), ZORA, ...parents, coin] */
  buyPath: Address[];
  /** Pool params per hop (aligned with buyPath hops) */
  buyPoolParams: HopPoolParams[];
  /** Full token path for sell: reverse of buyPath */
  sellPath: Address[];
  /** Pool params per hop for sell: reverse of buyPoolParams */
  sellPoolParams: HopPoolParams[];
  /** The coin's ancestry: [coin, parent, ..., ZORA] */
  ancestry: Address[];
}

// ---------------------------------------------------------------------------
// Main resolver
// ---------------------------------------------------------------------------

/**
 * Resolve the complete buy/sell route for a Zora coin.
 *
 * Walks the coin ancestry (coin → parent → ... → terminal anchor) via
 * currency() calls, reads pool params from storage for each hop, and
 * prepends the appropriate ETH bridge hop(s).
 *
 * Terminal anchors:
 * - ZORA token → prepend ETH/ZORA hop
 * - USDC → prepend ETH/USDC hop (Base app content coins default to USDC
 *   when the creator has no creator coin)
 *
 * Supports up to 6 hops (coin → coin → coin → creator → ZORA → ETH)
 * to handle deep nesting of content coins.
 *
 * @param maxDepth - Maximum ancestry depth (default 6, prevents infinite loops)
 */
export async function resolveCoinRoute(params: {
  client: CoinRouteClient;
  coinAddress: Address;
  maxDepth?: number;
}): Promise<CoinRoute> {
  const { client, coinAddress, maxDepth = 6 } = params;

  // Walk ancestry: coin → parent → ... → terminal anchor
  const ancestry: Address[] = [coinAddress];
  const hopParams: HopPoolParams[] = [];

  let current = coinAddress;
  for (let depth = 0; depth < maxDepth; depth++) {
    // Read currency() to get parent
    let parentCurrency: Address;
    try {
      parentCurrency = (await client.readContract({
        address: current,
        abi: currencyAbi,
        functionName: "currency",
      })) as Address;
    } catch {
      // No currency() function — this is not a Zora coin (maybe a base token)
      break;
    }

    // Read pool params from storage
    let params = await readPoolParamsFromStorage(client, current);
    if (!params) {
      // Storage layout doesn't match known Zora coin patterns.
      // This coin might be a non-standard contract (e.g. manually deployed
      // token with a currency() view but different storage layout).
      // Try common pool param combinations that work on Base V4 pools.
      const COMMON_POOL_PARAMS: HopPoolParams[] = [
        { fee: 10000, tickSpacing: 200, hooks: NATIVE_ETH, hookData: "0x" },
        { fee: 3000, tickSpacing: 60, hooks: NATIVE_ETH, hookData: "0x" },
        { fee: 500, tickSpacing: 10, hooks: NATIVE_ETH, hookData: "0x" },
      ];
      // Just use the most common Zora default — the quoter will validate it.
      // If wrong, the swap will fail at quote time (not silently).
      params = COMMON_POOL_PARAMS[0]!;
    }
    hopParams.push(params);
    ancestry.push(parentCurrency);

    // If parent is a terminal anchor (ZORA or USDC), we're done
    if (TERMINAL_ANCHORS.has(parentCurrency.toLowerCase())) {
      break;
    }

    current = parentCurrency;
  }

  // Determine which terminal anchor we reached
  const lastAncestor = ancestry[ancestry.length - 1]!;
  const lastAncestorLower = lastAncestor.toLowerCase();

  if (!TERMINAL_ANCHORS.has(lastAncestorLower)) {
    throw new Error(
      `Coin ancestry did not reach a known anchor (ZORA or USDC). ` +
      `Last ancestor: ${lastAncestor}. Ancestry: ${ancestry.join(" → ")}`,
    );
  }

  // Build the ETH bridge hop(s) based on which anchor we reached
  let ethBridgePath: Address[];
  let ethBridgeParams: HopPoolParams[];

  if (lastAncestorLower === ZORA_TOKEN.toLowerCase()) {
    // Standard path: ETH → ZORA
    ethBridgePath = [NATIVE_ETH, ZORA_TOKEN];
    ethBridgeParams = [ETH_ZORA_HOP];
  } else if (lastAncestorLower === USDC_BASE.toLowerCase()) {
    // USDC-backed coin: ETH → USDC
    ethBridgePath = [NATIVE_ETH, USDC_BASE];
    ethBridgeParams = [ETH_USDC_HOP];
  } else if (lastAncestorLower === WETH_BASE.toLowerCase()) {
    // WETH-backed coin: ETH is WETH, no bridge needed — just start from native ETH.
    // The coin pairs directly against WETH, so the path is [ETH(native), coin]
    // with the coin's own pool params.
    ethBridgePath = [NATIVE_ETH];
    ethBridgeParams = [];
  } else {
    // Shouldn't reach here given the TERMINAL_ANCHORS check above
    throw new Error(`Unhandled terminal anchor: ${lastAncestor}`);
  }

  // Build buy path: [ETH, anchor, ...parents_reversed, coin]
  // ancestry is [coin, parent1, parent2, ..., anchor]
  // We need [ETH, anchor, ..., parent2, parent1, coin]
  const buyPath: Address[] = [...ethBridgePath, ...ancestry.slice(0, -1).reverse()];
  const buyPoolParams: HopPoolParams[] = [
    ...ethBridgeParams,
    ...hopParams.slice().reverse(),
  ];

  // Sell path: exact reverse
  const sellPath = buyPath.slice().reverse();
  const sellPoolParams = buyPoolParams.slice().reverse();

  return {
    buyPath,
    buyPoolParams,
    sellPath,
    sellPoolParams,
    ancestry,
  };
}

/**
 * Get the ERC20 balance of a coin for a given address.
 */
export async function getCoinBalance(
  client: CoinRouteClient,
  coinAddress: Address,
  holder: Address,
): Promise<bigint> {
  return (await client.readContract({
    address: coinAddress,
    abi: balanceOfAbi,
    functionName: "balanceOf",
    args: [holder],
  })) as bigint;
}

export { NATIVE_ETH, ZORA_TOKEN, USDC_BASE, WETH_BASE, ETH_ZORA_HOP, ETH_USDC_HOP, TERMINAL_ANCHORS };
