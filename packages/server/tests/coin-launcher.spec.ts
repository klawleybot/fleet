import { describe, it, expect } from "vitest";
import { decodeFunctionData, zeroAddress, getAddress, type Address } from "viem";
import {
  zoraFactoryAbi,
  buildDeployCalldata,
  parseCoinCreatedLogs,
  ZORA_FACTORY_ADDRESS,
} from "../src/services/coinLauncher.js";
import { encodeEventTopics, encodeAbiParameters } from "viem";

describe("coinLauncher", () => {
  const RECIPIENT: Address = "0x1111111111111111111111111111111111111111";
  const REFERRAL: Address = "0x2222222222222222222222222222222222222222";

  describe("buildDeployCalldata", () => {
    it("encodes a minimal deploy call (ETH, no referral)", () => {
      const data = buildDeployCalldata({
        payoutRecipient: RECIPIENT,
        name: "TestCoin",
        symbol: "TC",
        tokenURI: "https://example.com/meta.json",
      });

      const decoded = decodeFunctionData({
        abi: zoraFactoryAbi,
        data,
      });

      expect(decoded.functionName).toBe("deploy");
      expect(decoded.args[0]).toBe(RECIPIENT); // payoutRecipient
      expect(decoded.args[1]).toEqual([]); // owners
      expect(decoded.args[2]).toBe("https://example.com/meta.json"); // uri
      expect(decoded.args[3]).toBe("TestCoin"); // name
      expect(decoded.args[4]).toBe("TC"); // symbol
      expect(decoded.args[5]).toBe(zeroAddress); // platformReferrer
      expect(decoded.args[6]).toBe(zeroAddress); // currency (ETH)
      expect(decoded.args[7]).toBe(0); // tickSpacing
      expect(decoded.args[8]).toBe(0n); // initialPurchase
    });

    it("encodes deploy with all optional params", () => {
      const data = buildDeployCalldata({
        payoutRecipient: RECIPIENT,
        name: "FancyCoin",
        symbol: "FC",
        tokenURI: "ipfs://Qm123",
        platformReferral: REFERRAL,
        currency: "0x4200000000000000000000000000000000000006" as Address,
        initialPurchaseWei: 1_000_000_000_000_000n,
      });

      const decoded = decodeFunctionData({
        abi: zoraFactoryAbi,
        data,
      });

      expect(decoded.functionName).toBe("deploy");
      expect(decoded.args[5]).toBe(REFERRAL);
      expect(decoded.args[6]).toBe(
        "0x4200000000000000000000000000000000000006",
      );
      expect(decoded.args[8]).toBe(1_000_000_000_000_000n);
    });
  });

  describe("parseCoinCreatedLogs", () => {
    it("extracts coin + pool from CoinCreated event", () => {
      const COIN: Address = getAddress("0x3333333333333333333333333333333333333333");
      const POOL: Address = getAddress("0x4444444444444444444444444444444444444444");

      const topics = encodeEventTopics({
        abi: zoraFactoryAbi,
        eventName: "CoinCreated",
        args: {
          caller: RECIPIENT,
          payoutRecipient: RECIPIENT,
          platformReferrer: zeroAddress,
        },
      });

      const data = encodeAbiParameters(
        [
          { type: "address" }, // currency
          { type: "string" }, // uri
          { type: "string" }, // name
          { type: "string" }, // symbol
          { type: "address" }, // coin
          { type: "address" }, // pool
          { type: "string" }, // version
        ],
        [zeroAddress, "https://example.com", "Test", "TST", COIN, POOL, "1"],
      );

      const logs = [
        {
          address: ZORA_FACTORY_ADDRESS,
          topics: topics as [`0x${string}`, ...`0x${string}`[]],
          data,
        },
      ];

      const result = parseCoinCreatedLogs(logs);
      expect(result.coinAddress).toBe(COIN);
      expect(result.poolAddress).toBe(POOL);
    });

    it("throws when no matching events found", () => {
      expect(() => parseCoinCreatedLogs([])).toThrow(
        /No CoinCreated or CoinCreatedV4 event/,
      );
    });
  });

  describe("constants", () => {
    it("ZORA_FACTORY_ADDRESS is correct", () => {
      expect(ZORA_FACTORY_ADDRESS).toBe(
        "0x777777751622c0d3258f214F9DF38E35BF45baF3",
      );
    });
  });
});
