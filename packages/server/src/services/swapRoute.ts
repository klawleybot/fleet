import { isAddress } from "viem";

const WETH_BASE = "0x4200000000000000000000000000000000000006" as const;

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

  const maxHops = Math.max(1, Math.min(8, input.maxHops ?? 3));

  const ancestry: `0x${string}`[] = [to];
  let cursor = to;
  let foundZora = cursor === zora;

  for (let i = 0; i < maxHops && !foundZora; i += 1) {
    const next = parent.get(cursor);
    if (!next) break;
    ancestry.push(next);
    cursor = next;
    if (cursor === zora) {
      foundZora = true;
      break;
    }
  }

  if (!foundZora) {
    throw new Error(`Deterministic route failed: did not reach ZORA anchor within ${maxHops} hop(s)`);
  }

  // ancestry is [to,...,zora]; forward route is [root,zora,...,to]
  const forward = [root, ...ancestry.reverse()];
  return {
    path: forward,
    hops: forward.length - 1,
  };
}
