import { describe, it, expect } from "vitest";
import { decodeFunctionData, zeroAddress, getAddress, type Address } from "viem";
import {
  zoraFactoryAbi,
  buildDeployCalldata,
  parseCoinCreatedLogs,
  encodeDopplerPoolConfig,
  decodeDopplerPoolConfig,
  ZORA_FACTORY_ADDRESS,
  BLDR_TOKEN_SEPOLIA,
  DOPPLER_PRESET_LOW,
  DOPPLER_PRESET_HIGH,
  defaultCurrencyForChain,
} from "../src/services/coinLauncher.js";
import { encodeEventTopics, encodeAbiParameters } from "viem";

describe("coinLauncher", () => {
  const RECIPIENT: Address = "0x1111111111111111111111111111111111111111";
  const REFERRAL: Address = "0x2222222222222222222222222222222222222222";

  describe("encodeDopplerPoolConfig / decodeDopplerPoolConfig", () => {
    it("roundtrips with default LOW preset", () => {
      const encoded = encodeDopplerPoolConfig(
        BLDR_TOKEN_SEPOLIA,
        DOPPLER_PRESET_LOW.tickLower,
        DOPPLER_PRESET_LOW.tickUpper,
        DOPPLER_PRESET_LOW.numDiscoveryPositions,
        DOPPLER_PRESET_LOW.maxDiscoverySupplyShare,
      );

      expect(encoded).toMatch(/^0x[0-9a-fA-F]+$/);

      const decoded = decodeDopplerPoolConfig(encoded);
      expect(decoded.version).toBe(4);
      expect(decoded.currency.toLowerCase()).toBe(BLDR_TOKEN_SEPOLIA.toLowerCase());
      expect([...decoded.tickLower]).toEqual([29800, 45800, 49800]);
      expect([...decoded.tickUpper]).toEqual([49800, 51800, 51800]);
      expect([...decoded.numDiscoveryPositions]).toEqual([11, 11, 11]);
      expect([...decoded.maxDiscoverySupplyShare]).toEqual([
        250000000000000000n, 300000000000000000n, 150000000000000000n,
      ]);
    });

    it("roundtrips with HIGH preset and ETH currency", () => {
      const encoded = encodeDopplerPoolConfig(
        zeroAddress,
        DOPPLER_PRESET_HIGH.tickLower,
        DOPPLER_PRESET_HIGH.tickUpper,
        DOPPLER_PRESET_HIGH.numDiscoveryPositions,
        DOPPLER_PRESET_HIGH.maxDiscoverySupplyShare,
      );

      const decoded = decodeDopplerPoolConfig(encoded);
      expect(decoded.version).toBe(4);
      expect(decoded.currency).toBe(zeroAddress);
      expect([...decoded.tickLower]).toEqual([19800, 35800, 39800]);
    });
  });

  describe("defaultCurrencyForChain", () => {
    it("returns BLDR on Sepolia", () => {
      expect(defaultCurrencyForChain(84532)).toBe(BLDR_TOKEN_SEPOLIA);
    });

    it("returns address(0) on mainnet", () => {
      expect(defaultCurrencyForChain(8453)).toBe(zeroAddress);
    });
  });

  describe("buildDeployCalldata", () => {
    it("encodes a deploy call with poolConfig bytes (Sepolia defaults)", () => {
      const data = buildDeployCalldata({
        chainId: 84532,
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
      expect(decoded.args[1]).toEqual([RECIPIENT]); // owners (at least one required)
      expect(decoded.args[2]).toBe("https://example.com/meta.json"); // uri
      expect(decoded.args[3]).toBe("TestCoin"); // name
      expect(decoded.args[4]).toBe("TC"); // symbol
      // args[5] is poolConfig bytes — verify it decodes correctly
      const poolConfig = decodeDopplerPoolConfig(decoded.args[5] as `0x${string}`);
      expect(poolConfig.version).toBe(4);
      expect(poolConfig.currency.toLowerCase()).toBe(BLDR_TOKEN_SEPOLIA.toLowerCase());
      expect(decoded.args[6]).toBe(zeroAddress); // platformReferrer
      expect(decoded.args[7]).toBe(0n); // initialPurchase
    });

    it("encodes deploy with all optional params", () => {
      const data = buildDeployCalldata({
        chainId: 8453,
        payoutRecipient: RECIPIENT,
        name: "FancyCoin",
        symbol: "FC",
        tokenURI: "ipfs://Qm123",
        platformReferral: REFERRAL,
        currency: "0x4200000000000000000000000000000000000006" as Address,
        marketCapPreset: "high",
        initialPurchaseWei: 1_000_000_000_000_000n,
      });

      const decoded = decodeFunctionData({
        abi: zoraFactoryAbi,
        data,
      });

      expect(decoded.functionName).toBe("deploy");
      const poolConfig = decodeDopplerPoolConfig(decoded.args[5] as `0x${string}`);
      expect(poolConfig.currency.toLowerCase()).toBe(
        "0x4200000000000000000000000000000000000006",
      );
      expect([...poolConfig.tickLower]).toEqual(DOPPLER_PRESET_HIGH.tickLower);
      expect(decoded.args[6]).toBe(REFERRAL);
      expect(decoded.args[7]).toBe(1_000_000_000_000_000n);
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
