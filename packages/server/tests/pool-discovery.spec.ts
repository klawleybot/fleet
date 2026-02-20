import { describe, it, expect } from "vitest";
import { discoverPoolParams } from "../src/services/poolDiscovery.js";
import { encodeEventTopics, encodeAbiParameters, type Address, type Log } from "viem";
import { zoraFactoryAbi, ZORA_FACTORY_ADDRESSES } from "../src/services/coinLauncher.js";

const COIN = "0xE82926789a63001d7C60dEa790DFBe0cD80541c2" as Address;
const CHAIN_ID = 84532;
const FACTORY = ZORA_FACTORY_ADDRESSES[CHAIN_ID]!;

function makeMockLog(): Log {
  // Encode the non-indexed args of CoinCreatedV4
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

  it("throws when no matching event found", async () => {
    const mockClient = {
      getLogs: async () => [],
    };

    await expect(
      discoverPoolParams({
        client: mockClient,
        chainId: CHAIN_ID,
        coinAddress: COIN,
      }),
    ).rejects.toThrow("No CoinCreatedV4 event found");
  });

  it("throws for unknown chain", async () => {
    const mockClient = {
      getLogs: async () => [],
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
