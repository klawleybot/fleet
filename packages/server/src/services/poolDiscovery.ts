import { parseEventLogs, type AbiEvent, type Address, type Hex, type Log } from "viem";
import type { HopPoolParams } from "./swapRoute.js";
import { zoraFactoryAbi, ZORA_FACTORY_ADDRESSES } from "./coinLauncher.js";

/** Minimal client interface for reading logs + storage. */
export interface PoolDiscoveryClient {
  getLogs(args: {
    address: Address;
    event: AbiEvent;
    fromBlock: bigint;
    toBlock: "latest";
  }): Promise<Log[]>;
  /** Optional — needed for storage-slot fallback on older coins. */
  getStorageAt?(args: { address: Address; slot: Hex }): Promise<Hex | undefined>;
  /** Optional — needed for storage-slot fallback to read currency(). */
  readContract?(args: {
    address: Address;
    abi: readonly Record<string, unknown>[];
    functionName: string;
    args?: readonly unknown[];
  }): Promise<unknown>;
}

// Minimal ABI for currency() view
const currencyAbi = [
  {
    name: "currency",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
] as const;

// ---------------------------------------------------------------------------
// Storage-slot fallback
// ---------------------------------------------------------------------------

/**
 * Read Doppler pool params from a Zora coin's storage slots.
 *
 * Zora coins are EIP-1167 minimal proxies. Their storage layout packs:
 * - One slot: [padding][tickSpacing:1byte][pad:1byte][fee:2bytes][currency:20bytes]
 * - The next non-zero slot contains the hooks address (last 20 bytes)
 *
 * Scans slots 0-14 to find the pattern.
 */
async function readPoolParamsFromStorage(
  client: PoolDiscoveryClient,
  coinAddress: Address,
): Promise<HopPoolParams | null> {
  if (!client.getStorageAt || !client.readContract) return null;

  // Get expected currency via view function
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

  const currencyLower = currency.toLowerCase().slice(2);

  // Read slots 0-14
  const slots: (Hex | undefined)[] = [];
  for (let i = 0; i <= 14; i++) {
    const slot = ("0x" + i.toString(16).padStart(64, "0")) as Hex;
    slots.push(await client.getStorageAt({ address: coinAddress, slot }));
  }

  for (let i = 0; i < slots.length; i++) {
    const val = slots[i];
    if (!val || val === "0x" + "0".repeat(64)) continue;

    const hex = val.slice(2);
    const last20 = hex.slice(24).toLowerCase();
    if (last20 !== currencyLower) continue;

    // Extract fee (chars 20-23) and tickSpacing (chars 16-17)
    const prefix = hex.slice(0, 24);
    const fee = parseInt(prefix.slice(20, 24), 16);
    const tickSpacing = parseInt(prefix.slice(16, 18), 16);

    if (fee <= 0 || fee > 100000 || tickSpacing <= 0 || tickSpacing > 16384) continue;

    // Find hooks address in the next non-zero slot
    for (let j = i + 1; j < Math.min(i + 3, slots.length); j++) {
      const hookSlot = slots[j];
      if (!hookSlot || hookSlot === "0x" + "0".repeat(64)) continue;
      const hookAddr = hookSlot.slice(2).slice(24);
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
    return {
      fee,
      tickSpacing,
      hooks: "0x0000000000000000000000000000000000000000" as `0x${string}`,
      hookData: "0x",
    };
  }

  return null;
}

// ---------------------------------------------------------------------------
// Main discovery (events → storage fallback)
// ---------------------------------------------------------------------------

/**
 * Discover pool params for a Zora coin.
 *
 * Strategy:
 * 1. Try CoinCreatedV4 events from ZoraFactory (works for newer coins)
 * 2. Fall back to reading storage slots (works for older EIP-1167 proxy coins)
 */
export async function discoverPoolParams(params: {
  client: PoolDiscoveryClient;
  chainId: number;
  coinAddress: Address;
}): Promise<HopPoolParams> {
  const { client, chainId, coinAddress } = params;

  const factoryAddress = ZORA_FACTORY_ADDRESSES[chainId];
  if (!factoryAddress) {
    throw new Error(`No ZoraFactory address for chainId ${chainId}`);
  }

  // --- Strategy 1: CoinCreatedV4 events ---
  const coinCreatedV4Event = zoraFactoryAbi.find(
    (item) => item.type === "event" && item.name === "CoinCreatedV4",
  );
  if (coinCreatedV4Event) {
    try {
      const logs = await client.getLogs({
        address: factoryAddress,
        event: coinCreatedV4Event,
        fromBlock: 0n,
        toBlock: "latest",
      });

      const parsed = parseEventLogs({
        abi: zoraFactoryAbi,
        eventName: "CoinCreatedV4",
        logs,
      });

      const coinNorm = coinAddress.toLowerCase();
      const matching = parsed.find(
        (ev) => ev.args.coin.toLowerCase() === coinNorm,
      );

      if (matching) {
        const poolKey = matching.args.poolKey;
        return {
          fee: poolKey.fee,
          tickSpacing: poolKey.tickSpacing,
          hooks: poolKey.hooks,
          hookData: "0x",
        };
      }
    } catch {
      // Event query failed — try storage fallback
    }
  }

  // --- Strategy 2: Storage slot fallback ---
  const storageResult = await readPoolParamsFromStorage(client, coinAddress);
  if (storageResult) {
    return storageResult;
  }

  throw new Error(
    `Could not discover pool params for coin ${coinAddress} on chain ${chainId} ` +
      `(no CoinCreatedV4 event and storage slot reading failed)`,
  );
}
