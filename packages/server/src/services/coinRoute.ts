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
import {
  type Address,
  type PublicClient,
  encodeFunctionData,
  decodeFunctionResult,
  type Hex,
} from "viem";
import type { HopPoolParams } from "./swapRoute.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const NATIVE_ETH: Address = "0x0000000000000000000000000000000000000000";
const ZORA_TOKEN: Address = "0x1111111111166b7FE7bd91427724B487980aFc69";

/** ETH(native) / ZORA standard V4 pool — discovered via on-chain quoting. */
const ETH_ZORA_HOP: HopPoolParams = {
  fee: 3000,
  tickSpacing: 60,
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
          hooks: ("0x" + hookAddr) as `0x${string}`,
          hookData: "0x",
        };
      }
    }

    // No hook found — standard pool
    return { fee, tickSpacing, hooks: NATIVE_ETH as `0x${string}`, hookData: "0x" };
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
 * Walks the coin ancestry (coin → parent → ... → ZORA) via currency() calls,
 * reads pool params from storage for each hop, and prepends the ETH/ZORA hop.
 *
 * @param maxDepth - Maximum ancestry depth (default 5, prevents infinite loops)
 */
export async function resolveCoinRoute(params: {
  client: CoinRouteClient;
  coinAddress: Address;
  maxDepth?: number;
}): Promise<CoinRoute> {
  const { client, coinAddress, maxDepth = 5 } = params;

  // Walk ancestry: coin → parent → ... → ZORA
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
      // No currency() function — this is not a Zora coin (maybe ZORA token itself)
      break;
    }

    // Read pool params from storage
    const params = await readPoolParamsFromStorage(client, current);
    if (!params) {
      throw new Error(
        `Could not read pool params from storage for coin ${current}`,
      );
    }
    hopParams.push(params);
    ancestry.push(parentCurrency);

    // If parent is ZORA, we're done
    if (parentCurrency.toLowerCase() === ZORA_TOKEN.toLowerCase()) {
      break;
    }

    current = parentCurrency;
  }

  // Validate we reached ZORA
  const lastAncestor = ancestry[ancestry.length - 1]!;
  if (lastAncestor.toLowerCase() !== ZORA_TOKEN.toLowerCase()) {
    throw new Error(
      `Coin ancestry did not reach ZORA token. Last ancestor: ${lastAncestor}. ` +
        `Ancestry: ${ancestry.join(" → ")}`,
    );
  }

  // Build buy path: [ETH, ZORA, ...parents_reversed, coin]
  // ancestry is [coin, parent1, parent2, ..., ZORA]
  // We need [ETH, ZORA, ..., parent2, parent1, coin]
  const buyPath: Address[] = [NATIVE_ETH, ...ancestry.slice().reverse()];
  // Pool params: [ETH_ZORA_HOP, ...hopParams_reversed]
  // hopParams[0] = coin→parent1 pool, hopParams[1] = parent1→parent2 pool, etc.
  // For buy direction: first hop is ETH→ZORA, then ZORA→parentN, ..., parent1→coin
  const buyPoolParams: HopPoolParams[] = [
    ETH_ZORA_HOP,
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

export { NATIVE_ETH, ZORA_TOKEN, ETH_ZORA_HOP };
