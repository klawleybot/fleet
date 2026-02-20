import { describe, it, expect } from "vitest";
import { buildDripSchedule, jiggleAmounts } from "../src/services/trade.js";

describe("buildDripSchedule", () => {
  it("creates correct number of events (wallets × intervals)", () => {
    const schedule = buildDripSchedule({
      walletIds: [1, 2, 3],
      amounts: [1000n, 2000n, 3000n],
      durationMs: 60_000,
      intervals: 4,
    });

    // 3 wallets × 4 intervals = 12 events
    expect(schedule.length).toBe(12);
  });

  it("preserves total amount per wallet", () => {
    const amounts = [1000000n, 2000000n];
    const schedule = buildDripSchedule({
      walletIds: [1, 2],
      amounts,
      durationMs: 30_000,
      intervals: 5,
    });

    // Sum per wallet should equal original
    const wallet1Sum = schedule
      .filter((e) => e.walletId === 1)
      .reduce((s, e) => s + e.amount, 0n);
    const wallet2Sum = schedule
      .filter((e) => e.walletId === 2)
      .reduce((s, e) => s + e.amount, 0n);

    expect(wallet1Sum).toBe(1000000n);
    expect(wallet2Sum).toBe(2000000n);
  });

  it("events are sorted by delay", () => {
    const schedule = buildDripSchedule({
      walletIds: [1, 2, 3],
      amounts: [1000n, 1000n, 1000n],
      durationMs: 60_000,
      intervals: 3,
    });

    for (let i = 1; i < schedule.length; i++) {
      expect(schedule[i]!.delayMs).toBeGreaterThanOrEqual(schedule[i - 1]!.delayMs);
    }
  });

  it("delays fall within duration", () => {
    const durationMs = 120_000;
    const schedule = buildDripSchedule({
      walletIds: [1, 2],
      amounts: [5000n, 5000n],
      durationMs,
      intervals: 10,
    });

    for (const event of schedule) {
      expect(event.delayMs).toBeGreaterThanOrEqual(0);
      expect(event.delayMs).toBeLessThanOrEqual(durationMs);
    }
  });

  it("interleaves wallets across time", () => {
    const schedule = buildDripSchedule({
      walletIds: [1, 2],
      amounts: [10000n, 10000n],
      durationMs: 60_000,
      intervals: 5,
    });

    // First half of events should contain both wallet 1 and 2
    const firstHalf = schedule.slice(0, Math.floor(schedule.length / 2));
    const walletsSeen = new Set(firstHalf.map((e) => e.walletId));
    expect(walletsSeen.size).toBe(2);
  });

  it("handles single interval", () => {
    const schedule = buildDripSchedule({
      walletIds: [1],
      amounts: [5000n],
      durationMs: 10_000,
      intervals: 1,
    });

    expect(schedule.length).toBe(1);
    expect(schedule[0]!.amount).toBe(5000n);
    expect(schedule[0]!.walletId).toBe(1);
  });

  it("no-jiggle produces equal sub-amounts", () => {
    const schedule = buildDripSchedule({
      walletIds: [1],
      amounts: [9000n],
      durationMs: 30_000,
      intervals: 3,
      jiggle: false,
    });

    expect(schedule.length).toBe(3);
    const sum = schedule.reduce((s, e) => s + e.amount, 0n);
    expect(sum).toBe(9000n);
  });
});
