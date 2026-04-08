/**
 * Custom Doppler Multicurve pool config encoder for Zora content coins.
 *
 * Replaces Zora's getContentCoinPoolConfig() API with custom curve profiles.
 *
 * ENCODING FORMAT (Zora CoinConfigurationVersions):
 *   abi.encode(
 *     uint8 version,          // 4 = DOPPLER_MULTICURVE_UNI_V4_POOL_VERSION
 *     address currency,        // backing token (creator coin, ZORA, WETH, USDC)
 *     int24[] tickLower,       // lower tick for each discovery curve
 *     int24[] tickUpper,       // upper tick for each discovery curve
 *     uint16[] numPositions,   // positions per curve (typ. 11)
 *     uint256[] shares         // supply share per curve (in WAD, sum < 1e18)
 *   )
 *
 * TICK MATH:
 *   price_in_currency = 1.0001^tick
 *   To convert market cap range to ticks:
 *     tick = log(mc / (supply * currency_price)) / log(1.0001)
 *
 * CALL PATH:
 *   EntryPoint.handleOps → CoinbaseSmartWallet.executeBatch → ZoraFactory.deploy
 */

import { encodeAbiParameters, decodeAbiParameters, parseAbiParameters, type Hex, type Address } from "viem";

const DOPPLER_MULTICURVE_VERSION = 4;
const WAD = BigInt("1000000000000000000"); // 1e18
const LOG_1_0001 = Math.log(1.0001);

export interface CurveSpec {
  /** Price multiple vs launch (1 = launch price) */
  rangeStart: number;
  /** Price multiple vs launch */
  rangeEnd: number;
  /** Percentage of LP supply in this segment (e.g. 15 = 15%) */
  sharePercent: number;
  /** Number of discrete LP positions (default 11) */
  numPositions?: number;
}

export interface ProfileSpec {
  name: string;
  curves: CurveSpec[];
  description?: string;
}

// ─── BUILT-IN PROFILES ─────────────────────────────────────────────────────────

export const PROFILES: Record<string, ProfileSpec> = {
  /**
   * Current Zora default for creator-coin-backed content coins.
   * 70% discovery / 30% tail. Sells most supply before 10×.
   */
  gradual: {
    name: "Gradual",
    curves: [
      { rangeStart: 1, rangeEnd: 2.72, sharePercent: 25, numPositions: 11 },
      { rangeStart: 2.23, rangeEnd: 9.02, sharePercent: 30, numPositions: 11 },
      { rangeStart: 2.72, rangeEnd: 9.02, sharePercent: 15, numPositions: 11 },
    ],
    description: "Zora default: 3-curve, 70% disc / 30% tail",
  },

  /**
   * Balanced Rocket — 30% discovery / 70% tail.
   * Pumps to 5× with ~50% less buy pressure than Gradual.
   * Still enough initial liquidity for trading.
   */
  rocket: {
    name: "Balanced Rocket",
    curves: [
      { rangeStart: 1, rangeEnd: 3, sharePercent: 15, numPositions: 10 },
      { rangeStart: 2, rangeEnd: 8, sharePercent: 15, numPositions: 10 },
    ],
    description: "2-curve, 30% disc / 70% tail — fast pump, thick tail",
  },

  /**
   * Steep Rocket — 20% discovery / 80% tail.
   * Very thin early liquidity, extreme pump speed.
   */
  steep: {
    name: "Steep Rocket",
    curves: [
      { rangeStart: 1, rangeEnd: 3, sharePercent: 10, numPositions: 8 },
      { rangeStart: 2, rangeEnd: 5, sharePercent: 10, numPositions: 8 },
    ],
    description: "2-curve, 20% disc / 80% tail — thin launch, max pump",
  },

  /**
   * Midcurve — 50% discovery / 50% tail.
   * Halfway between Gradual and Rocket. Enough early liquidity
   * to absorb moderate sells, but still pumps meaningfully on buys.
   */
  midcurve: {
    name: "Midcurve",
    curves: [
      { rangeStart: 1, rangeEnd: 2.5, sharePercent: 20, numPositions: 10 },
      { rangeStart: 2, rangeEnd: 6, sharePercent: 18, numPositions: 10 },
      { rangeStart: 4, rangeEnd: 9, sharePercent: 12, numPositions: 10 },
    ],
    description: "3-curve, 50% disc / 50% tail — balanced pump with buffer",
  },

  /**
   * Deep Tail — 30% discovery spread over 1×–50×, 70% tail.
   * Better for sustained long-term growth.
   */
  deep: {
    name: "Deep Tail",
    curves: [
      { rangeStart: 1, rangeEnd: 5, sharePercent: 10, numPositions: 11 },
      { rangeStart: 3, rangeEnd: 10, sharePercent: 10, numPositions: 11 },
      { rangeStart: 8, rangeEnd: 50, sharePercent: 10, numPositions: 11 },
    ],
    description: "3-curve, 30% disc / 70% tail — wide discovery range",
  },
};

// ─── TICK MATH ──────────────────────────────────────────────────────────────────

/**
 * Convert a price multiple (vs launch) to a tick offset.
 * tick = log(multiple) / log(1.0001)
 */
function multipleToTickOffset(multiple: number): number {
  return Math.round(Math.log(multiple) / LOG_1_0001);
}

/**
 * Get the launch tick for a given currency price and total supply.
 * launchTick = log(launchPrice) / log(1.0001)
 * where launchPrice = targetLaunchMC / (totalSupply * currencyPriceUSD)
 *
 * For content coins, we DON'T know the creator coin's USD price at encode time.
 * Instead, we get the launch tick from Zora's API or compute it from existing pool state.
 *
 * For simplicity: pass the launch tick directly (extracted from Zora's config for the same currency).
 */
export function computeLaunchTick(currencyPriceUSD: number, targetLaunchMCUSD: number, totalSupply: number = 1e9): number {
  const launchPrice = targetLaunchMCUSD / (totalSupply * currencyPriceUSD);
  return Math.round(Math.log(launchPrice) / LOG_1_0001);
}

// ─── ENCODER ────────────────────────────────────────────────────────────────────

export interface EncodePoolConfigParams {
  /** Backing currency address (creator coin, ZORA, WETH) */
  currency: Address;
  /** The Doppler multicurve profile to use */
  profile: ProfileSpec;
  /** Launch tick — the tick corresponding to the initial price.
   *  For creator-coin backed: get this from Zora's getContentCoinPoolConfig response
   *  or from an existing coin with the same backing currency. */
  launchTick: number;
  /** Tick spacing (must match the pool's tick spacing, default 200 for Zora V4) */
  tickSpacing?: number;
}

/**
 * Encode a custom Doppler multicurve pool config for ZoraFactory.deploy().
 *
 * Returns the encoded bytes to pass as the `poolConfig` parameter.
 */
export function encodePoolConfig({
  currency,
  profile,
  launchTick,
  tickSpacing = 200,
}: EncodePoolConfigParams): Hex {
  const tickLowers: number[] = [];
  const tickUppers: number[] = [];
  const numPositions: number[] = [];
  const shares: bigint[] = [];

  for (const curve of profile.curves) {
    // Convert price multiples to tick offsets from launch
    const offsetLow = multipleToTickOffset(curve.rangeStart);
    const offsetHigh = multipleToTickOffset(curve.rangeEnd);

    // Absolute ticks = launchTick + offset
    let tl = launchTick + offsetLow;
    let tu = launchTick + offsetHigh;

    // Snap to tick spacing
    tl = Math.round(tl / tickSpacing) * tickSpacing;
    tu = Math.round(tu / tickSpacing) * tickSpacing;

    // Ensure minimum range
    if (tu <= tl) tu = tl + tickSpacing;

    tickLowers.push(tl);
    tickUppers.push(tu);
    numPositions.push(curve.numPositions ?? 11);

    // Convert percent to WAD (1e18 = 100% of LP supply)
    // BUT: shares represent fraction of TOTAL supply, not LP supply
    // For content coins (99% in LP): share = curvePercent / 100
    // The factory allocates shares as fraction of totalSupply
    const shareWad = BigInt(Math.round(curve.sharePercent / 100 * 1e18));
    shares.push(shareWad);
  }

  // Validate total shares < 1e18 (100%)
  const totalShares = shares.reduce((a, b) => a + b, 0n);
  if (totalShares >= WAD) {
    throw new Error(`Total discovery shares ${totalShares.toString()} exceed WAD. Max ~99%`);
  }

  const encoded = encodeAbiParameters(
    parseAbiParameters("uint8 version, address currency, int24[] tickLower, int24[] tickUpper, uint16[] numDiscoveryPositions, uint256[] maxDiscoverySupplyShare"),
    [
      DOPPLER_MULTICURVE_VERSION,
      currency,
      tickLowers,
      tickUppers,
      numPositions,
      shares,
    ]
  );

  return encoded;
}

/**
 * Extract the launch tick from a Zora-returned encodedConfig.
 * Useful for getting the correct launch tick for a given currency
 * without computing it ourselves.
 */
export function extractLaunchTick(encodedConfig: Hex): { launchTick: number; currency: Address; version: number } {
  const decoded = decodePoolConfig(encodedConfig);
  if (!decoded) throw new Error("Failed to decode pool config");

  // Launch tick is the lowest tickLower across all curves
  const launchTick = Math.min(...decoded.tickLowers);
  return { launchTick, currency: decoded.currency, version: decoded.version };
}

export function decodePoolConfig(encoded: Hex): {
  version: number;
  currency: Address;
  tickLowers: number[];
  tickUppers: number[];
  numPositions: number[];
  shares: bigint[];
} | null {
  try {
    const params = parseAbiParameters("uint8, address, int24[], int24[], uint16[], uint256[]");
    const [version, currency, tickLowers, tickUppers, numPositions, shares] = decodeAbiParameters(params, encoded);
    return {
      version: Number(version),
      currency,
      tickLowers: (tickLowers as readonly number[]).map(Number),
      tickUppers: (tickUppers as readonly number[]).map(Number),
      numPositions: (numPositions as readonly number[]).map(Number),
      shares: [...(shares as readonly bigint[])],
    };
  } catch {
    return null;
  }
}

