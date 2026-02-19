import { describe, expect, it } from "vitest";

describe("local signer backend", () => {
  it("derives deterministic master + owner addresses without CDP", async () => {
    process.env.SIGNER_BACKEND = "local";
    process.env.LOCAL_SIGNER_SEED = "fleet-test-seed";
    process.env.APP_NETWORK = "base-sepolia";
    process.env.BASE_SEPOLIA_RPC_URL = "http://127.0.0.1:8545";

    const svc = await import("../src/services/cdp.js");
    const owner = await svc.getOrCreateOwnerAccount();
    const masterA = await svc.getOrCreateMasterSmartAccount();
    const masterB = await svc.getOrCreateMasterSmartAccount();

    delete process.env.SIGNER_BACKEND;
    const backendInfo = svc.getSignerBackendInfo();

    expect(owner.address).toMatch(/^0x[a-fA-F0-9]{40}$/);
    expect(masterA.smartAccount.address).toMatch(/^0x[a-fA-F0-9]{40}$/);
    expect(masterA.smartAccount.address).toEqual(masterB.smartAccount.address);
    expect(masterA.smartAccount.address).not.toEqual(owner.address);
    expect(backendInfo.backend).toBe("local");
  });
});
