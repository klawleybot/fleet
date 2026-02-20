import { describe, it, expect, beforeAll } from "vitest";
import { sweepFleet, createFleet, getFleetByName } from "../src/services/fleet.js";

describe("sweep", () => {
  it("sweeps from source fleet to explicit address", async () => {
    const { fleet } = await createFleet({ name: `sw-${Date.now()}-a`, walletCount: 2 });
    const target = "0x000000000000000000000000000000000000bEEF" as `0x${string}`;
    const result = await sweepFleet({ sourceFleetName: fleet.name, targetAddress: target });

    expect(result.sourceFleet).toBe(fleet.name);
    // In mock mode, all wallets have 0 balance → all skipped
    expect(result.transfers).toHaveLength(2);
    for (const t of result.transfers) {
      expect(t.status).toBe("skipped");
    }
    expect(result.totalSwept).toBe(0n);
  });

  it("sweeps from source to target fleet", async () => {
    const ts = Date.now();
    const { fleet: src } = await createFleet({ name: `sw-${ts}-src`, walletCount: 2 });
    const { fleet: dst } = await createFleet({ name: `sw-${ts}-dst`, walletCount: 3 });

    const result = await sweepFleet({
      sourceFleetName: src.name,
      targetFleetName: dst.name,
    });
    expect(result.sourceFleet).toBe(src.name);
    expect(result.targetAddress).toBe(dst.wallets[0]!.address);
  });

  it("sweeps from source to arbitrary address", async () => {
    const { fleet } = await createFleet({ name: `sw-${Date.now()}-arb`, walletCount: 1 });
    const target = "0x000000000000000000000000000000000000dEaD" as `0x${string}`;

    const result = await sweepFleet({
      sourceFleetName: fleet.name,
      targetAddress: target,
    });
    expect(result.targetAddress.toLowerCase()).toBe(target.toLowerCase());
  });

  it("throws for nonexistent source fleet", async () => {
    await expect(sweepFleet({ sourceFleetName: "nope-never" })).rejects.toThrow("not found");
  });

  it("throws for same source and target fleet", async () => {
    const { fleet } = await createFleet({ name: `sw-${Date.now()}-same`, walletCount: 1 });
    await expect(
      sweepFleet({ sourceFleetName: fleet.name, targetFleetName: fleet.name }),
    ).rejects.toThrow("cannot be the same");
  });

  it("throws for nonexistent target fleet", async () => {
    const { fleet } = await createFleet({ name: `sw-${Date.now()}-src2`, walletCount: 1 });
    await expect(
      sweepFleet({ sourceFleetName: fleet.name, targetFleetName: "nope-never" }),
    ).rejects.toThrow("not found");
  });
});
