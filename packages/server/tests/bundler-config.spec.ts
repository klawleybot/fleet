import { afterEach, describe, expect, it } from "vitest";
import { loadBundlerConfigFromEnv } from "../src/services/bundler/config.js";

const ENV_KEYS = [
  "BUNDLER_PRIMARY_URL",
  "BUNDLER_PRIMARY_NAME",
  "BUNDLER_SECONDARY_URL",
  "BUNDLER_SECONDARY_NAME",
  "BUNDLER_ENTRYPOINT",
  "APP_NETWORK",
  "PIMLICO_BASE_BUNDLER_URL",
  "PIMLICO_BASE_SEPOLIA_BUNDLER_URL",
] as const;
const ORIGINAL_ENV = new Map<string, string | undefined>(
  ENV_KEYS.map((key) => [key, process.env[key]]),
);

function resetEnv() {
  for (const key of ENV_KEYS) {
    const original = ORIGINAL_ENV.get(key);
    if (original === undefined) delete process.env[key];
    else process.env[key] = original;
  }
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
