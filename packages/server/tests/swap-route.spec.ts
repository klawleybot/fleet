import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { Address } from "viem";
import type { CoinRouteClient } from "../src/services/coinRoute.js";
import {
  resolveDeterministicBuyRoute,
  resolveDeterministicSellRoute,
  resolvePreferredBuyRoute,
} from "../src/services/swapRoute.js";

const ROOT = "0x4200000000000000000000000000000000000006";
const ZORA = "0x1111111111166b7fe7bd91427724b487980afc69";
const COIN_A = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const NATIVE_ETH = "0x0000000000000000000000000000000000000000";
const DOPPLER_HOOK = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

describe("resolveDeterministicSellRoute", () => {
  let origRoot: string | undefined;
  let origAnchor: string | undefined;
  let origParentMap: string | undefined;

  beforeEach(() => {
    origRoot = process.env.SWAP_ROUTE_ROOT_TOKEN;
    origAnchor = process.env.ZORA_ANCHOR_TOKEN;
    origParentMap = process.env.ZORA_PARENT_TOKEN_MAP_JSON;

    process.env.SWAP_ROUTE_ROOT_TOKEN = ROOT;
    process.env.ZORA_ANCHOR_TOKEN = ZORA;
    process.env.ZORA_PARENT_TOKEN_MAP_JSON = JSON.stringify({
      [COIN_A]: ZORA,
    });
  });

  afterEach(() => {
    process.env.SWAP_ROUTE_ROOT_TOKEN = origRoot;
    process.env.ZORA_ANCHOR_TOKEN = origAnchor;
    process.env.ZORA_PARENT_TOKEN_MAP_JSON = origParentMap;
  });

  it("returns reversed buy route for sell", () => {
    const sell = resolveDeterministicSellRoute({
      fromToken: COIN_A as `0x${string}`,
      toToken: ROOT as `0x${string}`,
    });

    const buy = resolveDeterministicBuyRoute({
      fromToken: ROOT as `0x${string}`,
      toToken: COIN_A as `0x${string}`,
    });

    expect(sell.path).toEqual([...buy.path].reverse());
    expect(sell.hops).toBe(buy.hops);
  });

  it("throws if toToken is not root", () => {
    expect(() =>
      resolveDeterministicSellRoute({
        fromToken: COIN_A as `0x${string}`,
        toToken: COIN_A as `0x${string}`,
      }),
    ).toThrow("toToken");
  });

  it("returns single-element path when selling root to root", () => {
    const route = resolveDeterministicSellRoute({
      fromToken: ROOT as `0x${string}`,
      toToken: ROOT as `0x${string}`,
    });
    expect(route.path).toEqual([ROOT.toLowerCase()]);
    expect(route.hops).toBe(0);
  });

  it("prefers on-chain route discovery for preview-compatible buys", async () => {
    const zeroSlot = ("0x" + "0".repeat(64)) as `0x${string}`;
    const client: CoinRouteClient = {
      getLogs: async () => [],
      getStorageAt: async () => zeroSlot,
      readContract: async ({ address, functionName }) => {
        if (functionName === "currency" && address.toLowerCase() === COIN_A) {
          return ZORA as Address;
        }
        if (functionName === "getPoolKey" && address.toLowerCase() === COIN_A) {
          return {
            currency0: ZORA as Address,
            currency1: COIN_A as Address,
            fee: 10_000,
            tickSpacing: 200,
            hooks: DOPPLER_HOOK as Address,
          };
        }
        throw new Error(`Unexpected readContract for ${address}`);
      },
    };

    const route = await resolvePreferredBuyRoute({
      client,
      chainId: 8453,
      fromToken: ROOT as `0x${string}`,
      toToken: COIN_A as `0x${string}`,
      maxHops: 2,
    });

    expect(route.path).toEqual([
      NATIVE_ETH,
      ZORA.toLowerCase(),
      COIN_A,
    ]);
    expect(route.hops).toBe(2);
    expect(route.poolParams).toHaveLength(2);
    expect(route.poolParams?.[0]).toEqual({
      fee: 3000,
      tickSpacing: 60,
      hooks: NATIVE_ETH,
      hookData: "0x",
    });
    expect(route.poolParams?.[1]).toEqual({
      fee: 10_000,
      tickSpacing: 200,
      hooks: DOPPLER_HOOK,
      hookData: "0x",
    });
  });

  it("falls back to deterministic routing when on-chain route discovery fails", async () => {
    const client: CoinRouteClient = {
      getLogs: async () => {
        throw new Error("logs unavailable");
      },
      getStorageAt: async () => undefined,
      readContract: async () => {
        throw new Error("currency unavailable");
      },
    };

    const route = await resolvePreferredBuyRoute({
      client,
      chainId: 8453,
      fromToken: ROOT as `0x${string}`,
      toToken: COIN_A as `0x${string}`,
      maxHops: 2,
    });

    expect(route.path).toEqual([
      ROOT.toLowerCase(),
      ZORA.toLowerCase(),
      COIN_A,
    ]);
    expect(route.hops).toBe(2);
    expect(route.poolParams).toBeUndefined();
  });
});
