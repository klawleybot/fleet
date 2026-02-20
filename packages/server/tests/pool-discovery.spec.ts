import { describe, it, expect } from "vitest";
import { discoverPoolParams } from "../src/services/poolDiscovery.js";
import { encodeEventTopics, encodeAbiParameters, type Address, type Hex, type Log } from "viem";
import { zoraFactoryAbi, ZORA_FACTORY_ADDRESSES } from "../src/services/coinLauncher.js";

const COIN = "0xE82926789a63001d7C60dEa790DFBe0cD80541c2" as Address;
const CHAIN_ID = 84532;
const FACTORY = ZORA_FACTORY_ADDRESSES[CHAIN_ID]!;

function makeMockLog(): Log {
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
      "0x1111111111111111111111111111111111111111",
      "https://example.com",
      "TestCoin",
      "TC",
      COIN,
      {
        currency0: "0x1111111111111111111111111111111111111111",
        currency1: COIN,
        fee: 500,
        tickSpacing: 10,
        hooks: "0x2222222222222222222222222222222222222222",
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

// ---------------------------------------------------------------------------
// Storage slot mock helpers
// ---------------------------------------------------------------------------

/**
 * Build a packed storage slot matching the Zora coin layout:
 *   [12 bytes padding][tickSpacing:1byte][pad:1byte][fee:2bytes][currency:20bytes]
 */
function packPoolSlot(fee: number, tickSpacing: number, currency: Address): Hex {
  const padding = "0".repeat(16); // 8 bytes
  const ts = tickSpacing.toString(16).padStart(2, "0");
  const pad = "00";
  const f = fee.toString(16).padStart(4, "0");
  const addr = currency.slice(2).toLowerCase();
  return ("0x" + padding + ts + pad + f + addr) as Hex;
}

function packHookSlot(hooks: Address): Hex {
  const padding = "0".repeat(24);
  return ("0x" + padding + hooks.slice(2).toLowerCase()) as Hex;
}

const CURRENCY = "0xaabbccddee1111111111111111111111111111aa" as Address;
const HOOKS = "0xff00ff00ff00ff00ff00ff00ff00ff00ff001040" as Address;
const ZERO_SLOT = ("0x" + "0".repeat(64)) as Hex;

function makeStorageClient(slots: Record<number, Hex>) {
  return {
    getLogs: async () => [] as Log[],
    getStorageAt: async (args: { address: Address; slot: Hex }) => {
      const idx = parseInt(args.slot.slice(2), 16);
      return slots[idx] ?? ZERO_SLOT;
    },
    readContract: async () => CURRENCY as unknown,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("poolDiscovery", () => {
  it("extracts pool params from mock CoinCreatedV4 event", async () => {
    const mockLog = makeMockLog();
    const mockClient = {
      getLogs: async () => [mockLog],
    };

    const params = await discoverPoolParams({
      client: mockClient,
      chainId: CHAIN_ID,
      coinAddress: COIN,
    });

    expect(params.fee).toBe(500);
    expect(params.tickSpacing).toBe(10);
    expect(params.hooks).toBe("0x2222222222222222222222222222222222222222");
    expect(params.hookData).toBe("0x");
  });

  it("falls back to storage slots when no events found", async () => {
    const client = makeStorageClient({
      3: packPoolSlot(10000, 200, CURRENCY),
      4: packHookSlot(HOOKS),
    });

    const params = await discoverPoolParams({
      client,
      chainId: CHAIN_ID,
      coinAddress: COIN,
    });

    expect(params.fee).toBe(10000);
    expect(params.tickSpacing).toBe(200);
    expect(params.hooks).toBe(HOOKS.toLowerCase());
    expect(params.hookData).toBe("0x");
  });

  it("falls back to storage when event query throws", async () => {
    const client = {
      getLogs: async () => { throw new Error("RPC error"); },
      getStorageAt: async (args: { address: Address; slot: Hex }) => {
        const idx = parseInt(args.slot.slice(2), 16);
        if (idx === 5) return packPoolSlot(30000, 200, CURRENCY);
        if (idx === 6) return packHookSlot(HOOKS);
        return ZERO_SLOT;
      },
      readContract: async () => CURRENCY as unknown,
    };

    const params = await discoverPoolParams({
      client,
      chainId: CHAIN_ID,
      coinAddress: COIN,
    });

    expect(params.fee).toBe(30000);
    expect(params.tickSpacing).toBe(200);
  });

  it("storage fallback returns hookless pool when no hook slot found", async () => {
    // Pool slot at 3, but slots 4-5 are zero (no hooks)
    const client = makeStorageClient({
      3: packPoolSlot(3000, 60, CURRENCY),
    });

    const params = await discoverPoolParams({
      client,
      chainId: CHAIN_ID,
      coinAddress: COIN,
    });

    expect(params.fee).toBe(3000);
    expect(params.tickSpacing).toBe(60);
    expect(params.hooks).toBe("0x0000000000000000000000000000000000000000");
  });

  it("throws when both strategies fail (no events, no storage)", async () => {
    const client = {
      getLogs: async () => [] as Log[],
      getStorageAt: async () => ZERO_SLOT,
      readContract: async () => { throw new Error("not a coin"); },
    };

    await expect(
      discoverPoolParams({
        client,
        chainId: CHAIN_ID,
        coinAddress: COIN,
      }),
    ).rejects.toThrow("Could not discover pool params");
  });

  it("throws when no storage methods available and no events", async () => {
    const client = {
      getLogs: async () => [] as Log[],
    };

    await expect(
      discoverPoolParams({
        client,
        chainId: CHAIN_ID,
        coinAddress: COIN,
      }),
    ).rejects.toThrow("Could not discover pool params");
  });

  it("throws for unknown chain", async () => {
    const mockClient = {
      getLogs: async () => [] as Log[],
    };

    await expect(
      discoverPoolParams({
        client: mockClient,
        chainId: 999999,
        coinAddress: COIN,
      }),
    ).rejects.toThrow("No ZoraFactory address");
  });
});
