import { afterEach, describe, expect, it } from "vitest";
import { loadBundlerConfigFromEnv } from "../src/services/bundler/config.js";

const ORIGINAL_ENV = { ...process.env };

function resetEnv() {
  process.env = { ...ORIGINAL_ENV };
  delete process.env.BUNDLER_PRIMARY_URL;
  delete process.env.BUNDLER_PRIMARY_NAME;
  delete process.env.BUNDLER_SECONDARY_URL;
  delete process.env.BUNDLER_SECONDARY_NAME;
  delete process.env.BUNDLER_ENTRYPOINT;
  delete process.env.APP_NETWORK;
  delete process.env.PIMLICO_BASE_BUNDLER_URL;
  delete process.env.PIMLICO_BASE_SEPOLIA_BUNDLER_URL;
}

afterEach(() => {
  resetEnv();
});

describe("loadBundlerConfigFromEnv", () => {
  it("uses Pimlico Base URL when primary name is pimlico on base", () => {
    resetEnv();
    process.env.APP_NETWORK = "base";
    process.env.BUNDLER_PRIMARY_NAME = "pimlico";
    process.env.PIMLICO_BASE_BUNDLER_URL = "https://api.pimlico.io/v2/8453/rpc?apikey=test";

    const cfg = loadBundlerConfigFromEnv();
    expect(cfg.primary.name).toBe("pimlico");
    expect(cfg.primary.rpcUrl).toBe("https://api.pimlico.io/v2/8453/rpc?apikey=test");
  });

  it("uses Pimlico Base Sepolia URL when primary name is pimlico on base-sepolia", () => {
    resetEnv();
    process.env.APP_NETWORK = "base-sepolia";
    process.env.BUNDLER_PRIMARY_NAME = "pimlico";
    process.env.PIMLICO_BASE_SEPOLIA_BUNDLER_URL = "https://api.pimlico.io/v2/84532/rpc?apikey=test";

    const cfg = loadBundlerConfigFromEnv();
    expect(cfg.primary.name).toBe("pimlico");
    expect(cfg.primary.rpcUrl).toBe("https://api.pimlico.io/v2/84532/rpc?apikey=test");
  });

  it("prefers explicit BUNDLER_PRIMARY_URL when provided", () => {
    resetEnv();
    process.env.APP_NETWORK = "base-sepolia";
    process.env.BUNDLER_PRIMARY_NAME = "pimlico";
    process.env.BUNDLER_PRIMARY_URL = "https://override.example/rpc";
    process.env.PIMLICO_BASE_BUNDLER_URL = "https://api.pimlico.io/v2/8453/rpc?apikey=test";
    process.env.PIMLICO_BASE_SEPOLIA_BUNDLER_URL = "https://api.pimlico.io/v2/84532/rpc?apikey=test";

    const cfg = loadBundlerConfigFromEnv();
    expect(cfg.primary.rpcUrl).toBe("https://override.example/rpc");
  });

  it("throws helpful error when pimlico URL for active chain is missing", () => {
    resetEnv();
    process.env.APP_NETWORK = "base-sepolia";
    process.env.BUNDLER_PRIMARY_NAME = "pimlico";

    expect(() => loadBundlerConfigFromEnv()).toThrow(/PIMLICO_BASE_SEPOLIA_BUNDLER_URL/);
  });
});
