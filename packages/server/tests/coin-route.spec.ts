import { describe, it, expect } from "vitest";
import { createPublicClient, encodeAbiParameters, encodeEventTopics, http, type Address, type Log } from "viem";
import { base } from "viem/chains";
import { resolveCoinRoute, type CoinRouteClient } from "../src/services/coinRoute.js";
import { zoraFactoryAbi, ZORA_FACTORY_ADDRESSES } from "../src/services/coinLauncher.js";

const runE2e = process.env.E2E_BASE_MAINNET === "1";

const CHAIN_ID = 8453;
const FACTORY = ZORA_FACTORY_ADDRESSES[CHAIN_ID]!;
const NATIVE_ETH: Address = "0x0000000000000000000000000000000000000000";
const TEST_COIN: Address = "0x40c6db1e8115f74eca045921710b25ab20a2c076";
const KELLEY_COIN: Address = "0xe44060e9BDcaA469460fcE4D3F7264E2a7b287D8";
const ZORA_TOKEN: Address = "0x1111111111166b7FE7bd91427724B487980aFc69";
const KELLEY_HOOKS: Address = "0x5e5d19d22c85a4aef7c1fdf25fb22a5a38f71040";
const TEST_HOOKS: Address = "0xc8d077444625eb300a427a6dfb2b1dbf9b159040";
const DYNAMIC_FEE = 8_388_608;

function makeCoinCreatedV4Log(input: {
  coin: Address;
  currency: Address;
  fee: number;
  tickSpacing: number;
  hooks: Address;
}): Log {
  const data = encodeAbiParameters(
    [
      { type: "address", name: "currency" },
      { type: "string", name: "uri" },
      { type: "string", name: "name" },
      { type: "string", name: "symbol" },
      { type: "address", name: "coin" },
      {
        type: "tuple",
        name: "poolKey",
        components: [
          { type: "address", name: "currency0" },
          { type: "address", name: "currency1" },
          { type: "uint24", name: "fee" },
          { type: "int24", name: "tickSpacing" },
          { type: "address", name: "hooks" },
        ],
      },
      { type: "bytes32", name: "poolKeyHash" },
      { type: "string", name: "version" },
    ],
    [
      input.currency,
      "https://example.com",
      "TestCoin",
      "TST",
      input.coin,
      {
        currency0:
          input.currency.toLowerCase() < input.coin.toLowerCase() ? input.currency : input.coin,
        currency1:
          input.currency.toLowerCase() < input.coin.toLowerCase() ? input.coin : input.currency,
        fee: input.fee,
        tickSpacing: input.tickSpacing,
        hooks: input.hooks,
      },
      "0x0000000000000000000000000000000000000000000000000000000000000001",
      "4",
    ],
  );

  const topics = encodeEventTopics({
    abi: zoraFactoryAbi,
    eventName: "CoinCreatedV4",
    args: {
      caller: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      payoutRecipient: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      platformReferrer: "0xcccccccccccccccccccccccccccccccccccccccc",
    },
  });

  return {
    address: FACTORY,
    blockHash: "0x0000000000000000000000000000000000000000000000000000000000000001",
    blockNumber: 1n,
    data,
    logIndex: 0,
    transactionHash: "0x0000000000000000000000000000000000000000000000000000000000000001",
    transactionIndex: 0,
    removed: false,
    topics: topics as [`0x${string}`, ...`0x${string}`[]],
  };
}

function splitLayoutParamsSlot(fee: number, tickSpacing: number, extra = 0x1f04): `0x${string}` {
  const bytes = "0".repeat(50) +
    tickSpacing.toString(16).padStart(2, "0") +
    fee.toString(16).padStart(6, "0") +
    extra.toString(16).padStart(6, "0");
  return `0x${bytes}` as `0x${string}`;
}

describe("coinRoute", () => {
  it("recovers nested hop hooks from CoinCreatedV4 events when storage is hookless", async () => {
    const logs = [
      makeCoinCreatedV4Log({
        coin: KELLEY_COIN,
        currency: ZORA_TOKEN,
        fee: 30000,
        tickSpacing: 200,
        hooks: KELLEY_HOOKS,
      }),
      makeCoinCreatedV4Log({
        coin: TEST_COIN,
        currency: KELLEY_COIN,
        fee: 10000,
        tickSpacing: 200,
        hooks: TEST_HOOKS,
      }),
    ];

    const client: CoinRouteClient = {
      getLogs: async () => logs,
      getStorageAt: async () => ("0x" + "0".repeat(64)) as `0x${string}`,
      readContract: async ({ address, functionName }) => {
        if (functionName === "currency") {
          if (address.toLowerCase() === TEST_COIN.toLowerCase()) return KELLEY_COIN;
          if (address.toLowerCase() === KELLEY_COIN.toLowerCase()) return ZORA_TOKEN;
        }
        throw new Error(`Unexpected readContract for ${address}`);
      },
    };

    const route = await resolveCoinRoute({
      client,
      chainId: CHAIN_ID,
      coinAddress: TEST_COIN,
    });

    expect(route.ancestry).toEqual([TEST_COIN, KELLEY_COIN, ZORA_TOKEN]);
    expect(route.buyPath).toEqual([NATIVE_ETH, ZORA_TOKEN, KELLEY_COIN, TEST_COIN]);
    expect(route.buyPoolParams[1]?.hooks.toLowerCase()).toBe(KELLEY_HOOKS.toLowerCase());
    expect(route.buyPoolParams[2]?.hooks.toLowerCase()).toBe(TEST_HOOKS.toLowerCase());
  });

  it("prefers coin-native getPoolKey over storage-derived fee guesses", async () => {
    const client: CoinRouteClient = {
      getLogs: async () => {
        throw new Error("logs unavailable");
      },
      getStorageAt: async () => ("0x" + "0".repeat(64)) as `0x${string}`,
      readContract: async ({ address, functionName }) => {
        if (functionName === "currency") {
          if (address.toLowerCase() === TEST_COIN.toLowerCase()) return KELLEY_COIN;
          if (address.toLowerCase() === KELLEY_COIN.toLowerCase()) return ZORA_TOKEN;
        }
        if (functionName === "getPoolKey") {
          if (address.toLowerCase() === TEST_COIN.toLowerCase()) {
            return {
              currency0: KELLEY_COIN,
              currency1: TEST_COIN,
              fee: DYNAMIC_FEE,
              tickSpacing: 200,
              hooks: TEST_HOOKS,
            };
          }
          if (address.toLowerCase() === KELLEY_COIN.toLowerCase()) {
            return {
              currency0: ZORA_TOKEN,
              currency1: KELLEY_COIN,
              fee: 30000,
              tickSpacing: 200,
              hooks: KELLEY_HOOKS,
            };
          }
        }
        throw new Error(`Unexpected readContract for ${address}`);
      },
    };

    const route = await resolveCoinRoute({
      client,
      chainId: CHAIN_ID,
      coinAddress: TEST_COIN,
    });

    expect(route.buyPoolParams[1]?.fee).toBe(30000);
    expect(route.buyPoolParams[2]?.fee).toBe(DYNAMIC_FEE);
    expect(route.buyPoolParams[2]?.hooks.toLowerCase()).toBe(TEST_HOOKS.toLowerCase());
  });

  it("parses nested split-layout storage without needing factory logs", async () => {
    const zero = ("0x" + "0".repeat(64)) as `0x${string}`;
    const client: CoinRouteClient = {
      getLogs: async () => {
        throw new Error("logs unavailable");
      },
      getStorageAt: async ({ address, slot }) => {
        const idx = parseInt(slot.slice(2), 16);
        if (address.toLowerCase() === TEST_COIN.toLowerCase()) {
          if (idx === 2) return ("0x" + "0".repeat(24) + KELLEY_COIN.slice(2).toLowerCase()) as `0x${string}`;
          if (idx === 3) return ("0x" + "0".repeat(24) + TEST_COIN.slice(2).toLowerCase()) as `0x${string}`;
          if (idx === 4) return ("0x" + "0".repeat(24) + TEST_HOOKS.slice(2).toLowerCase()) as `0x${string}`;
          if (idx === 5) return splitLayoutParamsSlot(10000, 200);
        }
        if (address.toLowerCase() === KELLEY_COIN.toLowerCase()) {
          if (idx === 2) return ("0x" + "0".repeat(24) + ZORA_TOKEN.slice(2).toLowerCase()) as `0x${string}`;
          if (idx === 3) return ("0x" + "0".repeat(24) + KELLEY_COIN.slice(2).toLowerCase()) as `0x${string}`;
          if (idx === 4) return ("0x" + "0".repeat(24) + KELLEY_HOOKS.slice(2).toLowerCase()) as `0x${string}`;
          if (idx === 5) return splitLayoutParamsSlot(30000, 200);
        }
        return zero;
      },
      readContract: async ({ address, functionName }) => {
        if (functionName === "currency") {
          if (address.toLowerCase() === TEST_COIN.toLowerCase()) return KELLEY_COIN;
          if (address.toLowerCase() === KELLEY_COIN.toLowerCase()) return ZORA_TOKEN;
        }
        throw new Error(`Unexpected readContract for ${address}`);
      },
    };

    const route = await resolveCoinRoute({
      client,
      chainId: CHAIN_ID,
      coinAddress: TEST_COIN,
    });

    expect(route.buyPoolParams[1]?.hooks.toLowerCase()).toBe(KELLEY_HOOKS.toLowerCase());
    expect(route.buyPoolParams[2]?.hooks.toLowerCase()).toBe(TEST_HOOKS.toLowerCase());
    expect(route.buyPoolParams[1]?.fee).toBe(30000);
    expect(route.buyPoolParams[2]?.fee).toBe(10000);
  });
});

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
