import { describe, it, expect } from "vitest";
import { createPublicClient, http, type Address } from "viem";
import { base } from "viem/chains";
import { resolveCoinRoute, type CoinRouteClient } from "../src/services/coinRoute.js";

const runE2e = process.env.E2E_BASE_MAINNET === "1";

const TEST_COIN: Address = "0x40c6db1e8115f74eca045921710b25ab20a2c076";
const KELLEY_COIN: Address = "0xe44060e9BDcaA469460fcE4D3F7264E2a7b287D8";
const ZORA_TOKEN: Address = "0x1111111111166b7FE7bd91427724B487980aFc69";
const NATIVE_ETH: Address = "0x0000000000000000000000000000000000000000";

describe.skipIf(!runE2e)("coinRoute: resolve route for real Zora coin", () => {
  it("resolves 3-hop route for nested coin", async () => {
    const client = createPublicClient({
      chain: base,
      transport: http(process.env.BASE_RPC_URL),
    });

    const route = await resolveCoinRoute({
      client: client as unknown as CoinRouteClient,
      coinAddress: TEST_COIN,
    });

    console.log("Ancestry:", route.ancestry.join(" → "));
    console.log("Buy path:", route.buyPath.join(" → "));
    console.log("Buy params:", route.buyPoolParams.map((p, i) => `hop${i}: fee=${p.fee} ts=${p.tickSpacing} hooks=${p.hooks.slice(0, 10)}...`));

    // Ancestry: coin → kelley → ZORA
    expect(route.ancestry).toHaveLength(3);
    expect(route.ancestry[0]!.toLowerCase()).toBe(TEST_COIN.toLowerCase());
    expect(route.ancestry[1]!.toLowerCase()).toBe(KELLEY_COIN.toLowerCase());
    expect(route.ancestry[2]!.toLowerCase()).toBe(ZORA_TOKEN.toLowerCase());

    // Buy path: ETH → ZORA → kelley → coin (4 tokens, 3 hops)
    expect(route.buyPath).toHaveLength(4);
    expect(route.buyPath[0]!.toLowerCase()).toBe(NATIVE_ETH.toLowerCase());
    expect(route.buyPath[3]!.toLowerCase()).toBe(TEST_COIN.toLowerCase());
    expect(route.buyPoolParams).toHaveLength(3);

    // Hop 1: ETH/ZORA standard pool
    expect(route.buyPoolParams[0]!.fee).toBe(3000);
    expect(route.buyPoolParams[0]!.tickSpacing).toBe(60);

    // Hop 2: ZORA/kelley Doppler pool
    expect(route.buyPoolParams[1]!.fee).toBe(30000);
    expect(route.buyPoolParams[1]!.tickSpacing).toBe(200);
    expect(route.buyPoolParams[1]!.hooks).not.toBe(NATIVE_ETH);

    // Hop 3: kelley/coin Doppler pool
    expect(route.buyPoolParams[2]!.fee).toBe(10000);
    expect(route.buyPoolParams[2]!.tickSpacing).toBe(200);
    expect(route.buyPoolParams[2]!.hooks).not.toBe(NATIVE_ETH);

    // Sell path is reversed
    expect(route.sellPath).toHaveLength(4);
    expect(route.sellPath[0]!.toLowerCase()).toBe(TEST_COIN.toLowerCase());
    expect(route.sellPath[3]!.toLowerCase()).toBe(NATIVE_ETH.toLowerCase());
    expect(route.sellPoolParams).toHaveLength(3);
  }, 30_000);
});
