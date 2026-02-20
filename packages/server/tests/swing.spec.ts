import { describe, it, expect } from "vitest";
import { db } from "../src/db/index.js";
import { calculatePnlBps, checkTrigger } from "../src/services/swing.js";
import type { SwingConfigRecord } from "../src/types.js";

describe("swing — DB operations", () => {
  let counter = 0;
  function uniqueCoin(): `0x${string}` {
    counter++;
    const hex = counter.toString(16).padStart(40, "b");
    return `0x${hex}` as `0x${string}`;
  }
  function uniqueFleet(): string {
    counter++;
    return `swing-test-${Date.now()}-${counter}`;
  }

  it("creates and retrieves a swing config", () => {
    const COIN = uniqueCoin();
    const fleetName = uniqueFleet();
    const config = db.createSwingConfig({
      fleetName,
      coinAddress: COIN,
      takeProfitBps: 2000,
      stopLossBps: 1000,
    });

    expect(config.fleetName).toBe(fleetName);
    expect(config.coinAddress).toBe(COIN.toLowerCase());
    expect(config.takeProfitBps).toBe(2000);
    expect(config.stopLossBps).toBe(1000);
    expect(config.trailingStopBps).toBeNull();
    expect(config.cooldownSec).toBe(300);
    expect(config.slippageBps).toBe(500);
    expect(config.enabled).toBe(true);
    expect(config.peakPnlBps).toBeNull();

    const fetched = db.getSwingConfig(fleetName, COIN);
    expect(fetched).not.toBeNull();
    expect(fetched!.id).toBe(config.id);
  });

  it("lists swing configs (all and enabled only)", () => {
    const COIN2 = uniqueCoin();
    const fn = uniqueFleet();
    db.createSwingConfig({ fleetName: fn, coinAddress: COIN2 });

    const all = db.listSwingConfigs();
    expect(all.length).toBeGreaterThanOrEqual(1);

    // Disable one
    const c = db.getSwingConfig(fn, COIN2)!;
    db.updateSwingConfig(c.id, { enabled: false });

    const enabledOnly = db.listSwingConfigs(true);
    expect(enabledOnly.find((x) => x.id === c.id)).toBeUndefined();
  });

  it("updates swing config fields", () => {
    const COIN3 = uniqueCoin();
    const config = db.createSwingConfig({ fleetName: uniqueFleet(), coinAddress: COIN3 });

    const updated = db.updateSwingConfig(config.id, {
      takeProfitBps: 3000,
      peakPnlBps: 1200,
      lastActionAt: "2025-01-01T00:00:00Z",
    });

    expect(updated.takeProfitBps).toBe(3000);
    expect(updated.peakPnlBps).toBe(1200);
    expect(updated.lastActionAt).toBe("2025-01-01T00:00:00Z");
    // Unchanged fields
    expect(updated.stopLossBps).toBe(2000);
    expect(updated.enabled).toBe(true);
  });

  it("deletes a swing config", () => {
    const COIN4 = uniqueCoin();
    const config = db.createSwingConfig({ fleetName: uniqueFleet(), coinAddress: COIN4 });

    const deleted = db.deleteSwingConfig(config.id);
    expect(deleted).toBe(true);

    const fetched = db.getSwingConfig(config.fleetName, COIN4);
    expect(fetched).toBeNull();

    // Double delete returns false
    expect(db.deleteSwingConfig(config.id)).toBe(false);
  });

  it("enforces unique(fleet_name, coin_address)", () => {
    const COIN5 = uniqueCoin();
    const fn = uniqueFleet();
    db.createSwingConfig({ fleetName: fn, coinAddress: COIN5 });

    expect(() =>
      db.createSwingConfig({ fleetName: fn, coinAddress: COIN5 }),
    ).toThrow();
  });
});

describe("swing — P&L calculation", () => {
  it("calculates positive P&L in bps", () => {
    // cost = 1 ETH, current = 1.15 ETH → +1500 bps
    const pnl = calculatePnlBps(1_150_000_000_000_000_000n, 1_000_000_000_000_000_000n);
    expect(pnl).toBe(1500);
  });

  it("calculates negative P&L in bps", () => {
    // cost = 1 ETH, current = 0.8 ETH → -2000 bps
    const pnl = calculatePnlBps(800_000_000_000_000_000n, 1_000_000_000_000_000_000n);
    expect(pnl).toBe(-2000);
  });

  it("returns 0 for zero cost basis", () => {
    expect(calculatePnlBps(100n, 0n)).toBe(0);
  });

  it("handles breakeven", () => {
    expect(calculatePnlBps(1_000_000n, 1_000_000n)).toBe(0);
  });
});

describe("swing — trigger logic", () => {
  function makeConfig(overrides: Partial<SwingConfigRecord> = {}): SwingConfigRecord {
    return {
      id: 1,
      fleetName: "test",
      coinAddress: "0xaaa" as `0x${string}`,
      takeProfitBps: 1500,
      stopLossBps: 2000,
      trailingStopBps: null,
      cooldownSec: 300,
      slippageBps: 500,
      enabled: true,
      peakPnlBps: null,
      lastActionAt: null,
      createdAt: "2025-01-01",
      ...overrides,
    };
  }

  it("triggers take profit", () => {
    const result = checkTrigger(1500, makeConfig());
    expect(result.trigger).toBe("take_profit");
  });

  it("triggers take profit above threshold", () => {
    const result = checkTrigger(2000, makeConfig());
    expect(result.trigger).toBe("take_profit");
  });

  it("triggers stop loss", () => {
    const result = checkTrigger(-2000, makeConfig());
    expect(result.trigger).toBe("stop_loss");
  });

  it("triggers stop loss below threshold", () => {
    const result = checkTrigger(-3000, makeConfig());
    expect(result.trigger).toBe("stop_loss");
  });

  it("no trigger in neutral range", () => {
    const result = checkTrigger(500, makeConfig());
    expect(result.trigger).toBe("none");
  });

  it("no trigger at slight loss", () => {
    const result = checkTrigger(-500, makeConfig());
    expect(result.trigger).toBe("none");
  });

  it("triggers trailing stop", () => {
    const config = makeConfig({ trailingStopBps: 500, peakPnlBps: 2000 });
    // Current P&L 1400, dropped 600 from peak 2000 (> trailing 500)
    const result = checkTrigger(1400, config);
    expect(result.trigger).toBe("trailing_stop");
  });

  it("no trailing stop if drop is small", () => {
    const config = makeConfig({ takeProfitBps: 5000, trailingStopBps: 500, peakPnlBps: 2000 });
    // Current P&L 1800, dropped only 200 from peak 2000 (< trailing 500)
    const result = checkTrigger(1800, config);
    expect(result.trigger).toBe("none");
  });

  it("no trailing stop without peak", () => {
    const config = makeConfig({ trailingStopBps: 500, peakPnlBps: null });
    const result = checkTrigger(1000, config);
    expect(result.trigger).toBe("none");
  });

  it("take profit takes precedence over trailing stop", () => {
    // P&L 1500, which triggers take profit. Even with trailing stop configured.
    const config = makeConfig({ trailingStopBps: 500, peakPnlBps: 2000 });
    const result = checkTrigger(1500, config);
    expect(result.trigger).toBe("take_profit");
  });
});
