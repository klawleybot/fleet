import { createBundlerClient, createPaymasterClient } from "viem/account-abstraction";
import { http, type Chain, type Client } from "viem";
import type { SmartAccount } from "viem/account-abstraction";
import { getChainConfig } from "../network.js";
import type { BundlerRouterConfig, Hex } from "./types.js";

export interface BundlerProviderConfig {
  name: string;
  rpcUrl: string;
  entryPoint: Hex;
}

export interface BundlerConfig {
  primary: BundlerProviderConfig;
  secondary: BundlerProviderConfig | null;
  router: BundlerRouterConfig;
}

function requiredEnv(name: string): string {
  const v = process.env[name]?.trim();
  if (!v) throw new Error(`${name} is required`);
  return v;
}

function parseIntWithDefault(value: string | undefined, fallback: number): number {
  if (!value?.trim()) return fallback;
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function parseHex(value: string | undefined, fallback: Hex): Hex {
  const v = value?.trim();
  if (!v) return fallback;
  return v as Hex;
}

function resolvePrimaryUrl(primaryName: string): string {
  const explicit = process.env.BUNDLER_PRIMARY_URL?.trim();
  if (explicit) return explicit;

  if (primaryName.toLowerCase() === "pimlico") {
    const { chainId } = getChainConfig();
    const pimlicoByChain =
      chainId === 84532
        ? process.env.PIMLICO_BASE_SEPOLIA_BUNDLER_URL?.trim()
        : process.env.PIMLICO_BASE_BUNDLER_URL?.trim();

    if (pimlicoByChain) return pimlicoByChain;

    const missingVar = chainId === 84532 ? "PIMLICO_BASE_SEPOLIA_BUNDLER_URL" : "PIMLICO_BASE_BUNDLER_URL";
    throw new Error(
      `BUNDLER_PRIMARY_URL is not set and BUNDLER_PRIMARY_NAME=pimlico but ${missingVar} is missing for chainId=${chainId}`,
    );
  }

  return requiredEnv("BUNDLER_PRIMARY_URL");
}

export function loadBundlerConfigFromEnv(): BundlerConfig {
  const primaryName = process.env.BUNDLER_PRIMARY_NAME?.trim() || "primary";
  const primaryUrl = resolvePrimaryUrl(primaryName);
  const secondaryUrl = process.env.BUNDLER_SECONDARY_URL?.trim() || null;

  const secondaryName = process.env.BUNDLER_SECONDARY_NAME?.trim() || "secondary";

  const entryPoint = parseHex(
    process.env.BUNDLER_ENTRYPOINT,
    "0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789",
  );

  return {
    primary: {
      name: primaryName,
      rpcUrl: primaryUrl,
      entryPoint,
    },
    secondary: secondaryUrl
      ? {
          name: secondaryName,
          rpcUrl: secondaryUrl,
          entryPoint,
        }
      : null,
    router: {
      sendTimeoutMs: parseIntWithDefault(process.env.BUNDLER_SEND_TIMEOUT_MS, 2_000),
      hedgeDelayMs: parseIntWithDefault(process.env.BUNDLER_HEDGE_DELAY_MS, 700),
      receiptPollMs: parseIntWithDefault(process.env.BUNDLER_RECEIPT_POLL_MS, 2_000),
      receiptTimeoutMs: parseIntWithDefault(process.env.BUNDLER_RECEIPT_TIMEOUT_MS, 120_000),
    },
  };
}

export function getBundlerChainId(): number {
  return getChainConfig().chainId;
}

/**
 * Creates a bundler client with optional Pimlico gas sponsorship.
 * When PIMLICO_GAS_POLICY_ID is set, user operations are sponsored
 * (no per-wallet ETH needed for gas).
 */
export function createSponsoredBundlerClient(opts: {
  account: SmartAccount;
  chain: Chain;
  client: Client;
  bundlerUrl?: string;
}) {
  const bundlerCfg = loadBundlerConfigFromEnv();
  const rpcUrl = opts.bundlerUrl ?? bundlerCfg.primary.rpcUrl;
  const gasPolicyId = process.env.PIMLICO_GAS_POLICY_ID?.trim();

  const paymasterOpts = gasPolicyId
    ? {
        paymaster: createPaymasterClient({
          transport: http(rpcUrl),
        }),
        paymasterContext: {
          sponsorshipPolicyId: gasPolicyId,
        },
      }
    : {};

  return createBundlerClient({
    account: opts.account,
    chain: opts.chain,
    client: opts.client,
    transport: http(rpcUrl),
    ...paymasterOpts,
  });
}
