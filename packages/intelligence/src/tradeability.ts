/**
 * tradeability.ts — Detect whether a Zora coin can be traded via our V4 pipeline.
 *
 * Problem: Some coins (especially WETH-backed) use Uniswap V3 pools instead of V4.
 * Our swap infrastructure only supports V4. Attempting to trade V3-only coins fails
 * at quote time with cryptic reverts.
 *
 * Detection: For WETH-backed coins, check if the stored pool address is a V3 pool
 * (responds to token0()). If it is, and no V4 pool exists, the coin is untradeable
 * via our pipeline.
 *
 * Results are cached in the intelligence DB to avoid repeated on-chain checks.
 */

import { createPublicClient, http, type Address } from "viem";
import { base } from "viem/chains";
import Database from "better-sqlite3";
import { env } from "./config.js";

const WETH: Address = "0x4200000000000000000000000000000000000006";

const currencyAbi = [
  { name: "currency", type: "function", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "address" }] },
] as const;

const token0Abi = [
  { name: "token0", type: "function", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "address" }] },
] as const;

// ---------------------------------------------------------------------------
// DB Cache
// ---------------------------------------------------------------------------

let _db: Database.Database | null = null;

function getDb(): Database.Database {
  if (!_db) {
    _db = new Database(process.env.ZORA_INTEL_DB_PATH || env.DB_PATH);
    _db.exec(`
      CREATE TABLE IF NOT EXISTS coin_tradeability (
        coin_address TEXT PRIMARY KEY,
        tradeable INTEGER NOT NULL,       -- 1 = tradeable (V4), 0 = not (V3-only)
        reason TEXT,
        checked_at TEXT NOT NULL
      )
    `);
  }
  return _db;
}

export function closeTradeabilityDb(): void {
  _db?.close();
  _db = null;
}

// ---------------------------------------------------------------------------
// Check cache
// ---------------------------------------------------------------------------

interface TradeabilityResult {
  tradeable: boolean;
  reason: string;
  cached: boolean;
}

/**
 * Check if a coin is tradeable via our V4 pipeline.
 * Returns cached result if available (< 24h old), otherwise checks on-chain.
 */
export async function checkTradeability(
  coinAddress: string,
  opts?: { skipCache?: boolean; rpcUrl?: string },
): Promise<TradeabilityResult> {
  const addr = coinAddress.toLowerCase();

  // Check cache first
  if (!opts?.skipCache) {
    const db = getDb();
    const cached = db.prepare(
      "SELECT tradeable, reason, checked_at FROM coin_tradeability WHERE coin_address = ?"
    ).get(addr) as { tradeable: number; reason: string; checked_at: string } | undefined;

    if (cached) {
      const ageMs = Date.now() - new Date(cached.checked_at).getTime();
      const MAX_CACHE_MS = 24 * 60 * 60 * 1000; // 24 hours
      if (ageMs < MAX_CACHE_MS) {
        return { tradeable: cached.tradeable === 1, reason: cached.reason, cached: true };
      }
    }
  }

  // On-chain check
  const result = await probeTradeability(coinAddress, opts?.rpcUrl);

  // Cache result
  const db = getDb();
  db.prepare(
    `INSERT OR REPLACE INTO coin_tradeability (coin_address, tradeable, reason, checked_at)
     VALUES (?, ?, ?, ?)`
  ).run(addr, result.tradeable ? 1 : 0, result.reason, new Date().toISOString());

  return { ...result, cached: false };
}

/**
 * Batch check tradeability for multiple coins.
 * Only probes coins not already cached.
 */
export async function checkTradeabilityBatch(
  coinAddresses: string[],
  opts?: { rpcUrl?: string },
): Promise<Map<string, TradeabilityResult>> {
  const results = new Map<string, TradeabilityResult>();
  const toProbe: string[] = [];

  const db = getDb();
  const MAX_CACHE_MS = 24 * 60 * 60 * 1000;

  for (const addr of coinAddresses) {
    const lower = addr.toLowerCase();
    const cached = db.prepare(
      "SELECT tradeable, reason, checked_at FROM coin_tradeability WHERE coin_address = ?"
    ).get(lower) as { tradeable: number; reason: string; checked_at: string } | undefined;

    if (cached && (Date.now() - new Date(cached.checked_at).getTime()) < MAX_CACHE_MS) {
      results.set(lower, { tradeable: cached.tradeable === 1, reason: cached.reason, cached: true });
    } else {
      toProbe.push(addr);
    }
  }

  // Probe uncached coins in batches of 5
  const BATCH = 5;
  for (let i = 0; i < toProbe.length; i += BATCH) {
    const batch = toProbe.slice(i, i + BATCH);
    const probes = await Promise.allSettled(
      batch.map(addr => probeTradeability(addr, opts?.rpcUrl))
    );

    for (let j = 0; j < batch.length; j++) {
      const addr = batch[j].toLowerCase();
      const probe = probes[j];
      if (probe.status === "fulfilled") {
        const result = probe.value;
        results.set(addr, { ...result, cached: false });
        db.prepare(
          `INSERT OR REPLACE INTO coin_tradeability (coin_address, tradeable, reason, checked_at)
           VALUES (?, ?, ?, ?)`
        ).run(addr, result.tradeable ? 1 : 0, result.reason, new Date().toISOString());
      } else {
        // Probe failed — assume tradeable to avoid false negatives
        results.set(addr, { tradeable: true, reason: "probe_error", cached: false });
      }
    }

    if (i + BATCH < toProbe.length) {
      await new Promise(r => setTimeout(r, 300));
    }
  }

  return results;
}

// On-chain probe
// ---------------------------------------------------------------------------

async function probeTradeability(
  coinAddress: string,
  rpcUrl?: string,
): Promise<{ tradeable: boolean; reason: string }> {
  const client = createPublicClient({
    chain: base,
    transport: http(rpcUrl || process.env.BASE_RPC_URL),
  });

  // Step 1: Get currency
  let currency: string;
  try {
    currency = await client.readContract({
      address: coinAddress as Address,
      abi: currencyAbi,
      functionName: "currency",
    }) as string;
  } catch {
    // No currency() — not a Zora coin at all
    return { tradeable: false, reason: "no_currency_function" };
  }

  // Step 2: If currency is ZORA, it's standard — tradeable
  const ZORA = "0x1111111111166b7fe7bd91427724b487980afc69";
  if (currency.toLowerCase() === ZORA.toLowerCase()) {
    return { tradeable: true, reason: "zora_backed" };
  }

  // Step 3: If currency is WETH, check for V3 pool
  if (currency.toLowerCase() !== WETH.toLowerCase()) {
    // Some other currency — check if IT is backed by ZORA or WETH (nested coin)
    // For now, assume tradeable if it's a nested coin
    return { tradeable: true, reason: "nested_coin" };
  }

  // WETH-backed coin — need to determine if V3 or V4
  // Read storage slots to find pool address candidates
  const poolCandidates: string[] = [];
  for (let i = 2; i <= 8; i++) {
    const slot = ("0x" + i.toString(16).padStart(64, "0")) as `0x${string}`;
    const val = await client.getStorageAt({ address: coinAddress as Address, slot });
    if (!val || val === "0x" + "0".repeat(64)) continue;

    const hex = val.slice(2);
    const last20 = hex.slice(24);
    // Skip if it's WETH itself, zero, or not an address-like value
    if (last20 === WETH.toLowerCase().slice(2)) continue;
    if (last20 === "0".repeat(40)) continue;

    // Check if the leading bytes are all zeros (indicates a clean address, not packed data)
    const prefix = hex.slice(0, 24);
    if (prefix === "0".repeat(24)) {
      poolCandidates.push("0x" + last20);
    }
  }

  // Try each candidate: if token0() responds, it's a V3 pool
  let hasV3Pool = false;
  for (const candidate of poolCandidates) {
    try {
      const t0 = await client.readContract({
        address: candidate as Address,
        abi: token0Abi,
        functionName: "token0",
      });
      // token0 responded — this is a V3 pool
      if (typeof t0 === "string" && t0.length === 42) {
        hasV3Pool = true;
        break;
      }
    } catch {
      // Not a V3 pool, continue
    }
  }

  if (!hasV3Pool) {
    // No V3 pool found — likely V4 (Doppler). Assume tradeable.
    return { tradeable: true, reason: "weth_v4" };
  }

  // Has V3 pool — check if it ALSO has a V4 pool by looking for
  // the coin's own address packed with fee/tickSpacing in storage.
  // This is the V4 param fingerprint used by coinRoute's storage parser.
  const coinLower = coinAddress.toLowerCase().slice(2);
  for (let i = 0; i <= 14; i++) {
    const slot = ("0x" + i.toString(16).padStart(64, "0")) as `0x${string}`;
    const val = await client.getStorageAt({ address: coinAddress as Address, slot });
    if (!val || val === "0x" + "0".repeat(64)) continue;
    const hex = val.slice(2);
    const last20 = hex.slice(24).toLowerCase();
    if (last20 === coinLower) {
      const prefix = hex.slice(0, 24);
      const fee = parseInt(prefix.slice(20, 24), 16);
      const tickSpacing = parseInt(prefix.slice(16, 18), 16);
      if (fee > 0 && fee <= 100000 && tickSpacing > 0 && tickSpacing <= 16384) {
        return { tradeable: true, reason: "weth_v3_and_v4" };
      }
    }
  }

  // V3 pool found, no V4 fingerprint — mark as needs_probe.
  // The klawley-trader will attempt a buy and cache the real outcome.
  // This lets Base4E (which lacks the V4 fingerprint but works) get a chance.
  return { tradeable: true, reason: "weth_needs_probe" };
}
