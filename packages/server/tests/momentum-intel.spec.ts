import { beforeEach, describe, expect, it } from "vitest";
import {
  detectPumpSignals,
  detectDipSignals,
  discountOwnActivity,
} from "../src/services/zoraSignals.js";
import { seedCoin, seedAnalytics, seedWatchlist, seedSwap, cleanIntelDb } from "./intel-fixtures.js";

const COIN_A = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as `0x${string}`;
const COIN_B = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" as `0x${string}`;
const WALLET_1 = "0x1111111111111111111111111111111111111111";
const WALLET_2 = "0x2222222222222222222222222222222222222222";
const EXTERNAL = "0x9999999999999999999999999999999999999999";

beforeEach(() => cleanIntelDb());

describe("detectPumpSignals", () => {
  it("returns coins with high acceleration and positive net flow", () => {
    seedCoin(COIN_A, { symbol: "PUMP", name: "PumpCoin" });
    seedAnalytics(COIN_A, { momentumAcceleration1h: 5.0, netFlowUsdc1h: 200, swapCount24h: 500 });
    seedCoin(COIN_B, { symbol: "SLOW", name: "SlowCoin" });
    seedAnalytics(COIN_B, { momentumAcceleration1h: 1.0, netFlowUsdc1h: 50, swapCount24h: 100 });

    const signals = detectPumpSignals({
      coinAddresses: [COIN_A, COIN_B],
      accelerationThreshold: 3.0,
    });

    expect(signals).toHaveLength(1);
    expect(signals[0]!.coinAddress).toBe(COIN_A.toLowerCase());
    expect(signals[0]!.momentumAcceleration1h).toBe(5.0);
    expect(signals[0]!.netFlowUsdc1h).toBe(200);
  });

  it("returns empty when no coins match", () => {
    seedAnalytics(COIN_A, { momentumAcceleration1h: 1.0, netFlowUsdc1h: -50 });

    const signals = detectPumpSignals({
      coinAddresses: [COIN_A],
      accelerationThreshold: 3.0,
    });
    expect(signals).toHaveLength(0);
  });

  it("returns empty for empty input", () => {
    expect(detectPumpSignals({ coinAddresses: [] })).toHaveLength(0);
  });
});

describe("detectDipSignals", () => {
  it("returns watchlist coins with deceleration and negative flow", () => {
    seedCoin(COIN_A, { symbol: "DIP", name: "DipCoin" });
    seedAnalytics(COIN_A, { momentumAcceleration1h: 0.3, netFlowUsdc1h: -150, swapCount24h: 200 });
    seedWatchlist(COIN_A);

    const signals = detectDipSignals({
      accelerationThreshold: 0.5,
      minSwapCount24h: 10,
    });

    expect(signals).toHaveLength(1);
    expect(signals[0]!.coinAddress).toBe(COIN_A.toLowerCase());
    expect(signals[0]!.momentumAcceleration1h).toBe(0.3);
    expect(signals[0]!.netFlowUsdc1h).toBe(-150);
  });

  it("returns previously traded coins with dip signals", () => {
    seedCoin(COIN_B, { symbol: "OLD", name: "OldCoin" });
    seedAnalytics(COIN_B, { momentumAcceleration1h: 0.2, netFlowUsdc1h: -100, swapCount24h: 150 });

    const signals = detectDipSignals({
      previouslyTradedAddresses: [COIN_B],
      accelerationThreshold: 0.5,
      minSwapCount24h: 10,
    });

    expect(signals).toHaveLength(1);
    expect(signals[0]!.coinAddress).toBe(COIN_B.toLowerCase());
  });

  it("ignores coins with positive net flow", () => {
    seedCoin(COIN_A, { symbol: "UP", name: "UpCoin" });
    seedAnalytics(COIN_A, { momentumAcceleration1h: 0.3, netFlowUsdc1h: 150 });
    seedWatchlist(COIN_A);

    const signals = detectDipSignals({ accelerationThreshold: 0.5 });
    expect(signals).toHaveLength(0);
  });

  it("deduplicates coins appearing in both watchlist and traded", () => {
    seedCoin(COIN_A, { symbol: "DUP", name: "DupCoin" });
    seedAnalytics(COIN_A, { momentumAcceleration1h: 0.3, netFlowUsdc1h: -150, swapCount24h: 200 });
    seedWatchlist(COIN_A);

    const signals = detectDipSignals({
      previouslyTradedAddresses: [COIN_A],
      accelerationThreshold: 0.5,
      minSwapCount24h: 10,
    });

    expect(signals).toHaveLength(1);
  });
});

describe("discountOwnActivity", () => {
  it("returns 1.0 when no swaps exist", () => {
    expect(discountOwnActivity(COIN_A, [WALLET_1])).toBe(1.0);
  });

  it("returns 1.0 when no own swaps", () => {
    seedSwap("swap1", COIN_A, EXTERNAL, { txHash: "0xabc" });
    seedSwap("swap2", COIN_A, EXTERNAL, { txHash: "0xdef" });

    expect(discountOwnActivity(COIN_A, [WALLET_1])).toBe(1.0);
  });

  it("discounts when own wallets make swaps", () => {
    seedSwap("s1", COIN_A, WALLET_1, { txHash: "0x1" });
    seedSwap("s2", COIN_A, WALLET_2, { txHash: "0x2" });
    seedSwap("s3", COIN_A, EXTERNAL, { txHash: "0x3" });
    seedSwap("s4", COIN_A, EXTERNAL, { txHash: "0x4" });

    expect(discountOwnActivity(COIN_A, [WALLET_1, WALLET_2])).toBe(0.5);
  });

  it("returns 0.0 when all swaps are own", () => {
    seedSwap("s1", COIN_A, WALLET_1, { txHash: "0x1" });

    expect(discountOwnActivity(COIN_A, [WALLET_1])).toBe(0);
  });

  it("returns 1.0 with empty wallet list", () => {
    expect(discountOwnActivity(COIN_A, [])).toBe(1.0);
  });
});
