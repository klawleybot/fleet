import { describe, it, expect } from "vitest";
import { jiggleAmounts } from "../src/services/trade.js";

describe("jiggleAmounts", () => {
  it("preserves total across wallets", () => {
    const total = 1000000000000000n; // 0.001 ETH
    const amounts = jiggleAmounts(total, 5, 0.15);

    expect(amounts.length).toBe(5);
    const sum = amounts.reduce((a, b) => a + b, 0n);
    expect(sum).toBe(total);
  });

  it("produces varied amounts (not all equal)", () => {
    const total = 10000000000000000n; // 0.01 ETH
    const amounts = jiggleAmounts(total, 5, 0.15);

    // With 15% jiggle across 5 wallets, at least some should differ
    const unique = new Set(amounts.map(String));
    // Could theoretically all be equal but astronomically unlikely
    expect(unique.size).toBeGreaterThanOrEqual(2);
  });

  it("respects factor bounds", () => {
    const total = 10000000000000000n;
    const amounts = jiggleAmounts(total, 5, 0.3);
    const avg = Number(total) / 5;

    for (const amt of amounts) {
      const ratio = Number(amt) / avg;
      // With 30% factor and normalization, individual ratios should be reasonable
      expect(ratio).toBeGreaterThan(0.3);
      expect(ratio).toBeLessThan(2.0);
    }
  });

  it("single wallet gets full amount", () => {
    const total = 5000000000000000n;
    const amounts = jiggleAmounts(total, 1, 0.15);
    expect(amounts).toEqual([total]);
  });

  it("handles large wallet count", () => {
    const total = 100000000000000000n; // 0.1 ETH
    const amounts = jiggleAmounts(total, 50, 0.15);

    expect(amounts.length).toBe(50);
    const sum = amounts.reduce((a, b) => a + b, 0n);
    expect(sum).toBe(total);
    // All amounts should be positive
    expect(amounts.every((a) => a > 0n)).toBe(true);
  });

  it("works with zero factor (equal split)", () => {
    const total = 9000000000000000n;
    const amounts = jiggleAmounts(total, 3, 0);

    expect(amounts.length).toBe(3);
    const sum = amounts.reduce((a, b) => a + b, 0n);
    expect(sum).toBe(total);
    // With factor=0, all amounts should be equal (within 1 wei for rounding)
    const avg = total / 3n;
    for (const amt of amounts) {
      expect(amt - avg).toBeLessThanOrEqual(1n);
      expect(avg - amt).toBeLessThanOrEqual(1n);
    }
  });
});
