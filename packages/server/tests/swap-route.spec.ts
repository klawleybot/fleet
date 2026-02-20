import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { resolveDeterministicBuyRoute, resolveDeterministicSellRoute } from "../src/services/swapRoute.js";

const ROOT = "0x4200000000000000000000000000000000000006";
const ZORA = "0x1111111111111111111111111111111111111111";
const COIN_A = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

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
});
