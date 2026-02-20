import { describe, it, expect } from "vitest";
import { getFleetDashboard, getGlobalDashboard } from "../src/services/dashboard.js";
import { createFleet } from "../src/services/fleet.js";
import { db } from "../src/db/index.js";
import { recordTradePosition } from "../src/services/monitor.js";

describe("dashboard", () => {
  it("returns global dashboard with master + fleets", async () => {
    const { fleet } = await createFleet({ name: `dash-${Date.now()}`, walletCount: 2 });
    const dashboard = await getGlobalDashboard();

    expect(dashboard.master).toBeDefined();
    expect(dashboard.master.address).toMatch(/^0x/);
    expect(dashboard.fleets.length).toBeGreaterThanOrEqual(1);
    expect(dashboard.totalAvailableEth).toBeDefined();
    expect(dashboard.globalRealizedPnl).toBeDefined();
  });

  it("returns fleet dashboard with wallet balances and P&L", async () => {
    const name = `dash-fleet-${Date.now()}`;
    const { fleet } = await createFleet({ name, walletCount: 3 });

    // Record a fake trade position
    const walletId = fleet.wallets[0]!.id;
    const coin = "0x000000000000000000000000000000000000abcd" as `0x${string}`;
    recordTradePosition({
      walletId,
      coinAddress: coin,
      isBuy: true,
      ethAmountWei: "1000000000000000",
      tokenAmount: "5000000000000000000",
    });
    recordTradePosition({
      walletId,
      coinAddress: coin,
      isBuy: false,
      ethAmountWei: "1200000000000000",
      tokenAmount: "5000000000000000000",
    });

    const dashboard = await getFleetDashboard(name);

    expect(dashboard.name).toBe(name);
    expect(dashboard.walletCount).toBe(3);
    expect(dashboard.wallets).toHaveLength(3);
    expect(dashboard.totalCostWei).toBe("1000000000000000");
    expect(dashboard.totalReceivedWei).toBe("1200000000000000");
    // Realized P&L = received - cost = +0.0002 ETH
    expect(BigInt(dashboard.realizedPnlWei)).toBe(200000000000000n);
    expect(dashboard.coinSummaries).toHaveLength(1);
    expect(dashboard.coinSummaries[0]!.coinAddress.toLowerCase()).toBe(coin.toLowerCase());
  });

  it("throws for nonexistent fleet", async () => {
    await expect(getFleetDashboard("nope-never")).rejects.toThrow("not found");
  });
});
