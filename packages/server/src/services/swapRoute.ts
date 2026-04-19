import { isAddress, type Address } from "viem";
import { resolveCoinRoute, type CoinRouteClient } from "./coinRoute.js";

const WETH_BASE = "0x4200000000000000000000000000000000000006" as const;
const NATIVE_ETH = "0x0000000000000000000000000000000000000000" as const;

function normalize(address: string): `0x${string}` {
  return address.toLowerCase() as `0x${string}`;
}

function getZoraAnchorToken(): `0x${string}` {
  const raw = process.env.ZORA_ANCHOR_TOKEN?.trim();
  if (!raw || !isAddress(raw)) {
    throw new Error("ZORA_ANCHOR_TOKEN must be set to the ZORA token address for deterministic swap routing");
  }
  return normalize(raw);
}

function getRootToken(): `0x${string}` {
  const raw = process.env.SWAP_ROUTE_ROOT_TOKEN?.trim();
  if (!raw) return WETH_BASE;
  if (!isAddress(raw)) {
    throw new Error("SWAP_ROUTE_ROOT_TOKEN must be a valid EVM address");
  }
  return normalize(raw);
}

function getParentMap(): Map<`0x${string}`, `0x${string}`> {
  const raw = process.env.ZORA_PARENT_TOKEN_MAP_JSON?.trim();
  if (!raw) {
    return new Map();
  }

  let parsed: Record<string, string>;
  try {
    parsed = JSON.parse(raw) as Record<string, string>;
  } catch {
    throw new Error("ZORA_PARENT_TOKEN_MAP_JSON must be valid JSON object of child->parent token addresses");
  }

  const map = new Map<`0x${string}`, `0x${string}`>();
  for (const [child, parent] of Object.entries(parsed)) {
    if (!isAddress(child) || !isAddress(parent)) {
      throw new Error("ZORA_PARENT_TOKEN_MAP_JSON contains an invalid token address");
    }
    map.set(normalize(child), normalize(parent));
  }
  return map;
}

export interface HopPoolParams {
  fee: number;
  tickSpacing: number;
  hooks: `0x${string}`;
  hookData: `0x${string}`;
}

export interface DeterministicRoute {
  path: `0x${string}`[];
  hops: number;
  poolParams?: HopPoolParams[];
}

function formatErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isEthLike(address: `0x${string}`): boolean {
  const normalized = normalize(address);
  return normalized === normalize(WETH_BASE) || normalized === normalize(NATIVE_ETH);
}

export async function resolvePreferredBuyRoute(input: {
  client: CoinRouteClient;
  fromToken: `0x${string}`;
  toToken: `0x${string}`;
  chainId?: number;
  maxHops?: number;
}): Promise<DeterministicRoute> {
  const from = normalize(input.fromToken);
  const to = normalize(input.toToken);
  let routeDiscoveryError: unknown = null;

  if (from !== to && isEthLike(from)) {
    try {
      const coinRoute = await resolveCoinRoute({
        client: input.client,
        coinAddress: to as Address,
        ...(input.chainId != null && { chainId: input.chainId }),
      });
      return {
        path: coinRoute.buyPath.map((address) => normalize(address)),
        hops: coinRoute.buyPath.length - 1,
        poolParams: coinRoute.buyPoolParams,
      };
    } catch (error) {
      routeDiscoveryError = error;
    }
  }

  try {
    return resolveDeterministicBuyRoute({
      fromToken: input.fromToken,
      toToken: input.toToken,
      ...(input.maxHops != null && { maxHops: input.maxHops }),
    });
  } catch (fallbackError) {
    if (routeDiscoveryError) {
      throw new Error(
        `Route discovery failed: ${formatErrorMessage(routeDiscoveryError)}. ` +
        `Deterministic fallback failed: ${formatErrorMessage(fallbackError)}`,
      );
    }
    throw fallbackError;
  }
}

/**
 * Resolve deterministic route rule:
 * - Walk "up" from target token using child->parent map
 * - Must reach ZORA anchor within maxHops
 * - Once at ZORA, upstream root is always ETH/WETH root
 */
/**
 * Resolve a sell route (coin→root) by computing the buy route (root→coin) and reversing it.
 */
export function resolveDeterministicSellRoute(input: {
  fromToken: `0x${string}`;
  toToken: `0x${string}`;
  maxHops?: number;
}): DeterministicRoute {
  const root = getRootToken();
  const from = normalize(input.fromToken);
  const to = normalize(input.toToken);

  if (to !== root) {
    throw new Error(`Deterministic sell route requires toToken=${root} (got ${to})`);
  }

  if (from === root) {
    return { path: [root], hops: 0 };
  }

  // Resolve the buy route (root→coin), then reverse for sell (coin→root)
  const buyRoute = resolveDeterministicBuyRoute({
    fromToken: root,
    toToken: from,
    ...(input.maxHops != null && { maxHops: input.maxHops }),
  });

  const reversedPath = [...buyRoute.path].reverse();
  return {
    path: reversedPath,
    hops: reversedPath.length - 1,
    ...(buyRoute.poolParams && { poolParams: [...buyRoute.poolParams].reverse() }),
  };
}

export function resolveDeterministicBuyRoute(input: {
  fromToken: `0x${string}`;
  toToken: `0x${string}`;
  maxHops?: number;
}): DeterministicRoute {
  const root = getRootToken();
  const zora = getZoraAnchorToken();
  const parent = getParentMap();

  const from = normalize(input.fromToken);
  const to = normalize(input.toToken);
  if (from !== root) {
    throw new Error(`Deterministic route currently requires fromToken=${root} (got ${from})`);
  }

  if (to === root) {
    return { path: [root], hops: 0 };
  }

  const maxHops = Math.max(1, Math.min(8, input.maxHops ?? 4));
  const USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913" as `0x${string}`;
  const WETH = "0x4200000000000000000000000000000000000006" as `0x${string}`;
  const anchors = new Set([zora, USDC, WETH]);

  const ancestry: `0x${string}`[] = [to];
  let cursor = to;
  let foundAnchor = anchors.has(cursor);

  for (let i = 0; i < maxHops && !foundAnchor; i += 1) {
    const next = parent.get(cursor);
    if (!next) break;
    ancestry.push(next);
    cursor = next;
    if (anchors.has(cursor)) {
      foundAnchor = true;
      break;
    }
  }

  if (!foundAnchor) {
    throw new Error(`Deterministic route failed: did not reach ZORA, USDC, or WETH anchor within ${maxHops} hop(s)`);
  }

  // ancestry is [to,...,anchor]; forward route is [root,anchor,...,to]
  // If anchor is USDC and root is WETH, the path is [WETH, USDC, ..., to]
  const forward = [root, ...ancestry.reverse()];
  return {
    path: forward,
    hops: forward.length - 1,
  };
}
