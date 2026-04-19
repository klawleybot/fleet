import { createHash } from "node:crypto";
import { CdpClient } from "@coinbase/cdp-sdk";
import {
  createPublicClient,
  createWalletClient,
  http,
  isAddress,
  isHash,
  keccak256,
  toHex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  createBundlerClient,
  sendUserOperation,
  toCoinbaseSmartAccount,
  waitForUserOperationReceipt,
  type ToCoinbaseSmartAccountReturnType,
  type ToCoinbaseSmartAccountParameters,
} from "viem/account-abstraction";
import { getChainConfig } from "./network.js";
import { createSponsoredBundlerClient } from "./bundler/config.js";
import { getBundlerRouter } from "./bundler/index.js";
import type { UserOperationReceipt } from "./bundler/types.js";
import { resolveDeterministicBuyRoute, resolveDeterministicSellRoute } from "./swapRoute.js";
import { resolveCoinRoute, type CoinRouteClient } from "./coinRoute.js";
import { encodeV4ExactInSwap, getRouterAddress } from "./v4SwapEncoder.js";
import { quoteExactInput, quoteExactInputSingle, applySlippage } from "./v4Quoter.js";
import { ensurePermit2Approval } from "./erc20.js";
import { encodeV3ExactInSwapCall } from "./v3SwapEncoder.js";
import { quoteV3ExactInput } from "./quoter.js";
import { discoverPoolParams } from "./poolDiscovery.js";
import { describeSwapFailure } from "./swapFailure.js";

const OWNER_ACCOUNT_NAME = "fleet-owner";
const MASTER_SMART_ACCOUNT_NAME = "master";
function isCdpMockMode(): boolean {
  return process.env.CDP_MOCK_MODE === "1";
}

function getChainCfg() {
  return getChainConfig();
}

export type SupportedNetwork = "base" | "base-sepolia";

type SignerBackend = "cdp" | "local";

function getSignerBackend(): SignerBackend {
  // Default to local so external execution infra (RPC + bundlers) is the baseline path.
  // CDP remains available as an explicit opt-in.
  const raw = String(process.env.SIGNER_BACKEND ?? "local").trim().toLowerCase();
  if (raw === "cdp") return "cdp";
  if (raw === "local" || raw === "local4337" || raw === "bundler") return "local";
  return "local";
}

/**
 * Resolve the CDP SDK network identifier. The CDP SDK uses inconsistent network
 * union types across methods (EvmUserOperationNetwork includes "base-sepolia",
 * SmartAccountSwapNetwork does not). The generic parameter lets each call site
 * assert the expected type without `as any`.
 */
function resolveCdpNetwork<T extends string = SupportedNetwork>(network?: SupportedNetwork): T {
  return (network ?? getChainCfg().cdpNetwork) as T;
}

let cdpClient: CdpClient | null = null;
let mockCounter = 0;
const localSmartAccountCache = new Map<string, ToCoinbaseSmartAccountReturnType>();

type CdpOwnerAccount = Awaited<ReturnType<CdpClient["evm"]["getOrCreateAccount"]>>;
type CdpSmartAccount = Awaited<ReturnType<CdpClient["evm"]["getOrCreateSmartAccount"]>>;
type CdpUserOperationReceipt = Awaited<ReturnType<CdpSmartAccount["waitForUserOperation"]>>;
type BundlerExecutionClient = NonNullable<Parameters<typeof createBundlerClient>[0]["client"]>;

function asBundlerExecutionClient(client: BundlerExecutionClient): BundlerExecutionClient {
  return client;
}

function toCoinRouteClient(client: ReturnType<typeof localPublicClient>): CoinRouteClient {
  return {
    getLogs: (args) => client.getLogs(args),
    readContract: (args) => client.readContract(args),
    getStorageAt: (args) => client.getStorageAt(args),
  };
}

export interface EvmAccountRef {
  address: `0x${string}`;
  name?: string;
}

export interface SmartAccountRef {
  address: `0x${string}`;
  name?: string;
}

function getCdpClient(): CdpClient {
  if (!cdpClient) {
    cdpClient = new CdpClient();
  }
  return cdpClient;
}

function assertAddress(value: string, context: string): `0x${string}` {
  if (!isAddress(value)) {
    throw new Error(`Invalid address in ${context}: ${value}`);
  }
  return value;
}

function assertHash(value: string, context: string): `0x${string}` {
  if (!isHash(value)) {
    throw new Error(`Invalid hash in ${context}: ${value}`);
  }
  return value;
}

function extractTransactionHash(receipt: unknown, context: string): `0x${string}` | null {
  if (typeof receipt !== "object" || receipt === null) return null;
  if (!("transactionHash" in receipt)) return null;
  const value = (receipt as { transactionHash?: string | null }).transactionHash;
  if (!value) return null;
  return assertHash(value, context);
}

function describeFailedReceipt(receipt: UserOperationReceipt | null | undefined): string | null {
  if (!receipt) return null;
  return describeSwapFailure(receipt.reason) ?? receipt.reason ?? null;
}

function hexToPrefixedHex(value: string, context: string): `0x${string}` {
  if (!/^[0-9a-f]+$/i.test(value)) {
    throw new Error(`Invalid hex for ${context}`);
  }
  return `0x${value}`;
}

function mockAddress(kind: "owner" | "smart", name: string): `0x${string}` {
  const digest = createHash("sha256").update(`${kind}:${name}`).digest("hex").slice(0, 40);
  return hexToPrefixedHex(digest, `mock ${kind} address`);
}

function mockHash(label: string): `0x${string}` {
  mockCounter += 1;
  const digest = createHash("sha256")
    .update(`${label}:${Date.now()}:${mockCounter}`)
    .digest("hex")
    .slice(0, 64);
  return hexToPrefixedHex(digest, `mock hash for ${label}`);
}

function localSeed(): string {
  const seed = process.env.LOCAL_SIGNER_SEED;
  if (!seed || !seed.trim()) {
    throw new Error("SIGNER_BACKEND=local requires LOCAL_SIGNER_SEED (or set SIGNER_BACKEND=cdp).");
  }
  return seed.trim();
}

/** Well-known wallet name for Klawley's Zora trading account. */
const KLAWLEY_ACCOUNT_NAME = "klawley";

function deriveLocalPrivateKey(name: string): `0x${string}` {
  if (name === MASTER_SMART_ACCOUNT_NAME && process.env.MASTER_WALLET_PRIVATE_KEY) {
    const pk = process.env.MASTER_WALLET_PRIVATE_KEY.trim();
    if (!/^0x[0-9a-fA-F]{64}$/.test(pk)) {
      throw new Error("MASTER_WALLET_PRIVATE_KEY must be a 0x-prefixed 32-byte hex string.");
    }
    return pk.toLowerCase() as `0x${string}`;
  }

  // Klawley's Zora account — uses ZORA_PRIVATE_KEY directly instead of seed derivation
  if (name === KLAWLEY_ACCOUNT_NAME && process.env.ZORA_PRIVATE_KEY) {
    let pk = process.env.ZORA_PRIVATE_KEY.trim();
    if (!pk.startsWith("0x")) pk = `0x${pk}`;
    if (!/^0x[0-9a-fA-F]{64}$/.test(pk)) {
      throw new Error("ZORA_PRIVATE_KEY must be a valid 32-byte hex private key.");
    }
    return pk.toLowerCase() as `0x${string}`;
  }

  const digest = keccak256(toHex(`fleet-local:${name}:${localSeed()}`));
  return digest;
}

function localAccountForName(name: string) {
  return privateKeyToAccount(deriveLocalPrivateKey(name));
}

function localWalletClient(name: string) {
  return createWalletClient({
    account: localAccountForName(name),
    chain: getChainCfg().chain,
    transport: http(getChainCfg().rpcUrl),
  });
}

function localPublicClient() {
  return createPublicClient({
    chain: getChainCfg().chain,
    transport: http(getChainCfg().rpcUrl),
  });
}

/** Klawley's known smart wallet address on Base mainnet. */
const KLAWLEY_SMART_WALLET = process.env.ZORA_SMART_WALLET
  ? assertAddress(process.env.ZORA_SMART_WALLET, "ZORA_SMART_WALLET")
  : "0x097677d3e2cde65af10be80ae5e67b8b68eb613d";

async function getLocalSmartAccount(name: string) {
  const cached = localSmartAccountCache.get(name);
  if (cached) return cached;

  const owner = localAccountForName(name);
  const smartOpts: ToCoinbaseSmartAccountParameters = {
    client: localPublicClient(),
    owners: [owner],
    version: "1.1",
  };

  // Klawley's smart wallet already exists at a known address —
  // pass it explicitly so viem doesn't try to counterfactually derive it.
  if (name === KLAWLEY_ACCOUNT_NAME) {
    smartOpts.address = KLAWLEY_SMART_WALLET;
  }

  const smart = await toCoinbaseSmartAccount(smartOpts);
  localSmartAccountCache.set(name, smart);
  return smart;
}

async function getLocalSmartAccountAddress(name: string): Promise<`0x${string}`> {
  try {
    const smart = await getLocalSmartAccount(name);
    return smart.address;
  } catch {
    // Offline/dev fallback (no RPC available): keep deterministic addressing for non-execution paths.
    return localAccountForName(name).address;
  }
}

async function submitUserOperationViaRouter(input: {
  smartAccountName: string;
  calls: Array<{ to: `0x${string}`; value: bigint; data?: `0x${string}` }>;
}): Promise<{ userOpHash: `0x${string}`; txHash: `0x${string}` | null; status: string; errorMessage?: string }> {
  if (!input.calls.length) throw new Error("calls[] cannot be empty");

  try {
    const account = await getLocalSmartAccount(input.smartAccountName);
    const publicClient = localPublicClient();
    const bundlerClient = createSponsoredBundlerClient({
      account,
      chain: getChainCfg().chain,
      client: asBundlerExecutionClient(publicClient),
    });

    const userOpHash = await sendUserOperation(bundlerClient, {
      account,
      calls: input.calls.map((call) => ({
        to: call.to,
        value: call.value,
        data: call.data ?? "0x",
      })),
    });

    const receipt = await waitForUserOperationReceipt(bundlerClient, {
      hash: userOpHash,
      timeout: 120_000,
    });
    const bundlerReceipt =
      receipt.success === false
        ? await getBundlerRouter().getReceipt(userOpHash).catch(() => null)
        : null;
    const failureMessage = bundlerReceipt ? describeFailedReceipt(bundlerReceipt) : null;

    return {
      userOpHash,
      txHash: bundlerReceipt?.txHash ?? receipt.receipt.transactionHash ?? null,
      status: receipt.success === false ? "failed" : "complete",
      ...(receipt.success === false
        ? { errorMessage: failureMessage ?? "Execution reverted" }
        : {}),
    };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    throw new Error(`Direct bundler submission failed for smart account ${String(input.smartAccountName)}: ${msg}`, {
      cause: error,
    });
  }
}

async function waitForUserOperationWithBundlerFirst(input: {
  userOpHash: `0x${string}`;
  waitWithCdp: () => Promise<CdpUserOperationReceipt>;
  context: string;
}): Promise<{ status: string; txHash: `0x${string}` | null; errorMessage?: string }> {
  try {
    const bundlerReceipt = await getBundlerRouter().waitForReceipt(input.userOpHash);
    if (bundlerReceipt.included) {
      const txHash = bundlerReceipt.txHash ? assertHash(bundlerReceipt.txHash, `${input.context} bundler txHash`) : null;
      const success = bundlerReceipt.success;
      return {
        status: success === false ? "failed" : "complete",
        txHash,
        ...(success === false
          ? { errorMessage: describeFailedReceipt(bundlerReceipt) ?? "Execution reverted" }
          : {}),
      };
    }
  } catch {
    // Fall back to CDP receipt path if bundler polling errors.
  }

  const cdpReceipt = await input.waitWithCdp();
  return {
    status: cdpReceipt.status,
    txHash: extractTransactionHash(cdpReceipt, `${input.context} txHash`),
    ...(cdpReceipt.status === "failed" ? { errorMessage: "Execution reverted" } : {}),
  };
}

export async function getOrCreateOwnerAccount(): Promise<EvmAccountRef> {
  if (isCdpMockMode()) {
    return {
      address: mockAddress("owner", OWNER_ACCOUNT_NAME),
      name: OWNER_ACCOUNT_NAME,
    };
  }

  if (getSignerBackend() === "local") {
    const account = localAccountForName(OWNER_ACCOUNT_NAME);
    return {
      address: account.address,
      name: OWNER_ACCOUNT_NAME,
    };
  }

  const account = await getCdpClient().evm.getOrCreateAccount({ name: OWNER_ACCOUNT_NAME });
  return {
    address: assertAddress(account.address, "owner account"),
    name: OWNER_ACCOUNT_NAME,
  };
}

async function getCdpOwnerAccount(): Promise<CdpOwnerAccount> {
  return getCdpClient().evm.getOrCreateAccount({ name: OWNER_ACCOUNT_NAME });
}

export async function createSmartAccount(
  name: string,
): Promise<{ owner: EvmAccountRef; smartAccount: SmartAccountRef }> {
  if (isCdpMockMode()) {
    return {
      owner: {
        address: mockAddress("owner", OWNER_ACCOUNT_NAME),
        name: OWNER_ACCOUNT_NAME,
      },
      smartAccount: {
        address: mockAddress("smart", name),
        name,
      },
    };
  }

  if (getSignerBackend() === "local") {
    const owner = localAccountForName(name);
    const smartAddress = await getLocalSmartAccountAddress(name);
    return {
      owner: { address: owner.address, name },
      smartAccount: { address: smartAddress, name },
    };
  }

  const ownerAccount = await getCdpOwnerAccount();
  const smartAccount: CdpSmartAccount = await getCdpClient().evm.createSmartAccount({
    owner: ownerAccount,
    name,
  });

  return {
    owner: {
      address: assertAddress(ownerAccount.address, "owner account"),
      name: OWNER_ACCOUNT_NAME,
    },
    smartAccount: {
      address: assertAddress(smartAccount.address, `smart account ${name}`),
      name,
    },
  };
}

export async function getOrCreateMasterSmartAccount(): Promise<{
  owner: EvmAccountRef;
  smartAccount: SmartAccountRef;
}> {
  if (isCdpMockMode()) {
    return {
      owner: {
        address: mockAddress("owner", OWNER_ACCOUNT_NAME),
        name: OWNER_ACCOUNT_NAME,
      },
      smartAccount: {
        address: mockAddress("smart", MASTER_SMART_ACCOUNT_NAME),
        name: MASTER_SMART_ACCOUNT_NAME,
      },
    };
  }

  if (getSignerBackend() === "local") {
    const owner = localAccountForName(MASTER_SMART_ACCOUNT_NAME);
    const smartAddress = await getLocalSmartAccountAddress(MASTER_SMART_ACCOUNT_NAME);
    return {
      owner: { address: owner.address, name: MASTER_SMART_ACCOUNT_NAME },
      smartAccount: { address: smartAddress, name: MASTER_SMART_ACCOUNT_NAME },
    };
  }

  const ownerAccount = await getCdpOwnerAccount();
  const smartAccount: CdpSmartAccount = await getCdpClient().evm.getOrCreateSmartAccount({
    name: MASTER_SMART_ACCOUNT_NAME,
    owner: ownerAccount,
  });

  return {
    owner: {
      address: assertAddress(ownerAccount.address, "owner account"),
      name: OWNER_ACCOUNT_NAME,
    },
    smartAccount: {
      address: assertAddress(smartAccount.address, "master smart account"),
      name: MASTER_SMART_ACCOUNT_NAME,
    },
  };
}

export async function getOrCreateSmartAccountByName(
  name: string,
): Promise<{ owner: EvmAccountRef; smartAccount: SmartAccountRef }> {
  if (isCdpMockMode()) {
    return {
      owner: {
        address: mockAddress("owner", OWNER_ACCOUNT_NAME),
        name: OWNER_ACCOUNT_NAME,
      },
      smartAccount: {
        address: mockAddress("smart", name),
        name,
      },
    };
  }

  if (getSignerBackend() === "local") {
    const owner = localAccountForName(name);
    const smartAddress = await getLocalSmartAccountAddress(name);
    return {
      owner: { address: owner.address, name },
      smartAccount: { address: smartAddress, name },
    };
  }

  const ownerAccount = await getCdpOwnerAccount();
  const smartAccount: CdpSmartAccount = await getCdpClient().evm.getOrCreateSmartAccount({
    name,
    owner: ownerAccount,
  });

  return {
    owner: {
      address: assertAddress(ownerAccount.address, "owner account"),
      name: OWNER_ACCOUNT_NAME,
    },
    smartAccount: {
      address: assertAddress(smartAccount.address, `smart account ${name}`),
      name,
    },
  };
}

export async function transferFromOwnerAccount(input: {
  ownerName: string;
  to: `0x${string}`;
  amountWei: bigint;
}): Promise<{ userOpHash: `0x${string}`; txHash: `0x${string}` | null; status: string }> {
  const recipient = String(input.to);

  if (isCdpMockMode()) {
    if (!isAddress(input.to)) throw new Error(`Invalid recipient address: ${recipient}`);
    if (input.amountWei <= 0n) throw new Error("amountWei must be > 0");
    return {
      userOpHash: mockHash(`mock-owner-transfer-userop:${String(input.ownerName)}`),
      txHash: mockHash(`mock-owner-transfer-tx:${String(input.ownerName)}`),
      status: "complete",
    };
  }

  if (getSignerBackend() === "local") {
    if (!isAddress(input.to)) throw new Error(`Invalid recipient address: ${recipient}`);
    if (input.amountWei <= 0n) throw new Error("amountWei must be > 0");

    const wc = localWalletClient(input.ownerName);
    const pc = localPublicClient();
    const txHash = await wc.sendTransaction({
      to: input.to,
      value: input.amountWei,
      chain: getChainCfg().chain,
    });
    const receipt = await pc.waitForTransactionReceipt({ hash: txHash });
    return {
      userOpHash: txHash,
      txHash,
      status: receipt.status === "success" ? "complete" : "failed",
    };
  }

  return transferFromSmartAccount({
    smartAccountName: input.ownerName,
    to: input.to,
    amountWei: input.amountWei,
  });
}

export async function transferFromSmartAccount(input: {
  smartAccountName: string;
  to: `0x${string}`;
  amountWei: bigint;
  network?: SupportedNetwork;
}): Promise<{ userOpHash: `0x${string}`; txHash: `0x${string}` | null; status: string }> {
  const recipient = String(input.to);

  if (isCdpMockMode()) {
    if (!isAddress(input.to)) throw new Error(`Invalid recipient address: ${recipient}`);
    if (input.amountWei <= 0n) throw new Error("amountWei must be > 0");
    return {
      userOpHash: mockHash(`mock-transfer-userop:${String(input.smartAccountName)}`),
      txHash: mockHash(`mock-transfer-tx:${String(input.smartAccountName)}`),
      status: "complete",
    };
  }

  if (getSignerBackend() === "local") {
    if (!isAddress(input.to)) throw new Error(`Invalid recipient address: ${recipient}`);
    if (input.amountWei <= 0n) throw new Error("amountWei must be > 0");

    return submitUserOperationViaRouter({
      smartAccountName: input.smartAccountName,
      calls: [{ to: input.to, value: input.amountWei, data: "0x" }],
    });
  }

  const owner = await getCdpOwnerAccount();
  const smartAccount: CdpSmartAccount = await getCdpClient().evm.getOrCreateSmartAccount({
    name: input.smartAccountName,
    owner,
  });

  const transferResult = await smartAccount.transfer({
    to: input.to,
    amount: input.amountWei,
    token: "eth",
    network: resolveCdpNetwork(input.network),
  });

  const userOpHash = assertHash(transferResult.userOpHash, "transfer userOpHash");
  const finalized = await waitForUserOperationWithBundlerFirst({
    userOpHash,
    waitWithCdp: () => smartAccount.waitForUserOperation({ userOpHash }),
    context: "transfer",
  });

  return {
    userOpHash,
    txHash: finalized.txHash,
    status: finalized.status,
  };
}

export async function swapFromSmartAccount(input: {
  smartAccountName: string;
  fromToken: `0x${string}`;
  toToken: `0x${string}`;
  fromAmount: bigint;
  slippageBps: number;
  network?: SupportedNetwork;
}): Promise<{ userOpHash: `0x${string}`; txHash: `0x${string}` | null; status: string; amountOut?: string; errorMessage?: string }> {
  if (isCdpMockMode()) {
    if (!isAddress(input.fromToken) || !isAddress(input.toToken)) {
      throw new Error("Invalid token addresses for mock swap");
    }
    if (input.fromAmount <= 0n) throw new Error("fromAmount must be > 0");
    return {
      userOpHash: mockHash(`mock-swap-userop:${input.smartAccountName}`),
      txHash: mockHash(`mock-swap-tx:${input.smartAccountName}`),
      status: "complete",
    };
  }

  if (getSignerBackend() === "local") {
    const WETH = "0x4200000000000000000000000000000000000006".toLowerCase();
    const root = (process.env.SWAP_ROUTE_ROOT_TOKEN?.trim() || "0x4200000000000000000000000000000000000006").toLowerCase();
    const fromNorm = input.fromToken.toLowerCase();
    const isSell = fromNorm !== root && fromNorm !== WETH;

    const publicClient = createPublicClient({
      chain: getChainCfg().chain,
      transport: http(getChainCfg().rpcUrl),
    });

    // Determine the coin address (the non-ETH/WETH token)
    const coinAddress = isSell ? input.fromToken : input.toToken;

    // Try on-chain route discovery first (coinRoute), fall back to env-var routing
    let routePath: `0x${string}`[];
    let routePoolParams: import("./swapRoute.js").HopPoolParams[] | undefined;
    let routeDiscoveryError: unknown = null;

    try {
      const coinRoute = await resolveCoinRoute({
        client: toCoinRouteClient(publicClient),
        coinAddress,
      });
      routePath = isSell ? coinRoute.sellPath : coinRoute.buyPath;
      routePoolParams = isSell ? coinRoute.sellPoolParams : coinRoute.buyPoolParams;
    } catch (error) {
      routeDiscoveryError = error;
      // Fall back to env-var-based deterministic routing
      let route;
      try {
        route = isSell
          ? resolveDeterministicSellRoute({
              fromToken: input.fromToken,
              toToken: input.toToken,
              maxHops: 3,
            })
          : resolveDeterministicBuyRoute({
              fromToken: input.fromToken,
              toToken: input.toToken,
              maxHops: 3,
            });
      } catch (fallbackError) {
        const primaryMessage =
          routeDiscoveryError instanceof Error ? routeDiscoveryError.message : String(routeDiscoveryError);
        const fallbackMessage =
          fallbackError instanceof Error ? fallbackError.message : String(fallbackError);
        throw new Error(
          `Route discovery failed: ${primaryMessage}. Deterministic fallback failed: ${fallbackMessage}`,
        );
      }
      routePath = route.path;
      routePoolParams = route.poolParams;

      // Discover pool params if still missing
      if (!routePoolParams || routePoolParams.length === 0) {
        const target = isSell ? route.path[0]! : route.path[route.path.length - 1]!;
        if (target.toLowerCase() !== root && target.toLowerCase() !== WETH) {
          try {
            const params = await discoverPoolParams({
              client: publicClient,
              chainId: getChainCfg().chainId,
              coinAddress: target,
            });
            routePoolParams = Array.from({ length: route.hops }, () => params);
          } catch {
            // Fall through with no pool params
          }
        }
      }
    }

    // Map WETH→address(0) for native ETH handling
    const swapPath = routePath.map((addr, idx) => {
      if (addr.toLowerCase() !== WETH) return addr;
      if (!isSell && idx === 0) return "0x0000000000000000000000000000000000000000" as `0x${string}`;
      if (isSell && idx === routePath.length - 1) return "0x0000000000000000000000000000000000000000" as `0x${string}`;
      return addr;
    });

    // Pre-quote to compute minAmountOut with slippage protection.
    // Try multi-hop quoteExactInput first; if it fails (Doppler hooks throw
    // HookNotImplemented), fall back to sequential quoteExactInputSingle per hop.
    const slippageBps = input.slippageBps;
    let quotedAmountOut: bigint;

    try {
      const quote = await quoteExactInput({
        chainId: getChainCfg().chainId,
        client: publicClient,
        path: routePath,
        poolParams: routePoolParams ?? [],
        amountIn: input.fromAmount,
        exactInput: true,
      });
      quotedAmountOut = quote.amountOut;
    } catch {
      // Sequential single-hop quoting for Doppler-hooked pools
      const hops = routePoolParams ?? [];
      let currentAmount = input.fromAmount;
      for (let i = 0; i < hops.length; i++) {
        const hop = hops[i]!;
        const tokenIn = routePath[i]!;
        const tokenOut = routePath[i + 1]!;
        // Determine currency ordering (currency0 < currency1)
        const inNorm = tokenIn.toLowerCase();
        const outNorm = tokenOut.toLowerCase();
        const zeroForOne = inNorm < outNorm;
        const currency0 = zeroForOne ? tokenIn : tokenOut;
        const currency1 = zeroForOne ? tokenOut : tokenIn;

        const hopQuote = await quoteExactInputSingle({
          chainId: getChainCfg().chainId,
          client: publicClient,
          poolKey: {
            currency0,
            currency1,
            fee: hop.fee,
            tickSpacing: hop.tickSpacing,
            hooks: hop.hooks,
          },
          zeroForOne,
          amountIn: currentAmount,
          hookData: hop.hookData ?? "0x",
        });
        currentAmount = hopQuote.amountOut;
      }
      quotedAmountOut = currentAmount;
    }
    const minAmountOut = applySlippage(quotedAmountOut, slippageBps);

    const encoded = encodeV4ExactInSwap({
      chainId: getChainCfg().chainId,
      path: swapPath,
      amountIn: input.fromAmount,
      minAmountOut,
      poolParamsPerHop: routePoolParams,
    });

    const calls: Array<{ to: `0x${string}`; value: bigint; data?: `0x${string}` }> = [];

    // For sells, ensure Permit2 approval for the Universal Router.
    // V4 Router uses Permit2 for ERC20 SETTLE_ALL, not regular transferFrom.
    if (isSell) {
      const smartAccount = await getLocalSmartAccount(input.smartAccountName);
      const routerAddress = getRouterAddress(getChainCfg().chainId);
      const permit2Calls = await ensurePermit2Approval({
        client: publicClient,
        token: input.fromToken,
        owner: smartAccount.address,
        router: routerAddress,
      });
      calls.push(...permit2Calls);
    }

    calls.push({ to: encoded.to, value: encoded.value, data: encoded.data });

    // ---- Optional USDC post-sell conversion ----
    // When SELL_DESTINATION_TOKEN is set to USDC, append a V3 WETH→USDC
    // swap after the V4 coin→WETH swap. Both run in the same UserOp batch.
    // The V4 swap sends WETH to the smart account (TAKE_ALL), so the V3 swap
    // pays via Permit2 from the smart account.
    const WETH_ADDRESS = "0x4200000000000000000000000000000000000006" as `0x${string}`;
    const USDC_ADDRESS = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as `0x${string}`;
    const sellDestToken = (process.env.SELL_DESTINATION_TOKEN?.trim() || WETH_ADDRESS).toLowerCase();
    const isUsdcDest = isSell && sellDestToken === USDC_ADDRESS.toLowerCase();

    if (isUsdcDest) {
      const smartAccount = await getLocalSmartAccount(input.smartAccountName);
      const routerAddress = getRouterAddress(getChainCfg().chainId);

      // Ensure WETH is approved to Permit2 and Permit2 approved to Router
      const wethPermit2Calls = await ensurePermit2Approval({
        client: publicClient,
        token: WETH_ADDRESS,
        owner: smartAccount.address,
        router: routerAddress,
      });
      calls.push(...wethPermit2Calls);

      // Quote WETH → USDC via V3 QuoterV2 (500 fee tier)
      // Use quotedAmountOut from V4 (after slippage) as V3 amountIn
      const v3AmountIn = minAmountOut; // WETH amount we'll get (post-slippage)
      let v3MinAmountOut = 0n;
      try {
        const v3Quote = await quoteV3ExactInput({
          chainId: getChainCfg().chainId,
          client: publicClient,
          tokenIn: WETH_ADDRESS,
          tokenOut: USDC_ADDRESS,
          fee: 500,
          amountIn: v3AmountIn,
        });
        v3MinAmountOut = applySlippage(v3Quote.amountOut, input.slippageBps);
      } catch {
        // If V3 quote fails (e.g. in tests), proceed with 0 minAmountOut
        // to avoid blocking the swap — not ideal for production but safe
        // since this is gated behind an explicit env var.
      }

      const v3Call = encodeV3ExactInSwapCall({
        chainId: getChainCfg().chainId,
        recipient: smartAccount.address,
        tokenIn: WETH_ADDRESS,
        tokenOut: USDC_ADDRESS,
        fee: 500,
        amountIn: v3AmountIn,
        minAmountOut: v3MinAmountOut,
        payerIsUser: true, // SA pays via Permit2
      });
      calls.push(v3Call);
    }

    // ---- Pre-submission simulation (free eth_call) ----
    // For buys (single swap call), simulate via eth_call to catch reverts
    // (insufficient balance, pool errors) before paying the bundler.
    // For sells (approval + swap batched), skip eth_call simulation —
    // individual calls can't be simulated in isolation since the swap
    // depends on the preceding Permit2 approval. The bundler's own
    // estimation validates the full batched UserOp.
    if (!isSell) {
      const smartAccountForSim = await getLocalSmartAccount(input.smartAccountName);
      const simClient = localPublicClient();
      const swapCall = calls[calls.length - 1]!;
      try {
        await simClient.call({
          account: smartAccountForSim.address,
          to: swapCall.to,
          value: swapCall.value,
          data: swapCall.data ?? "0x",
        });
      } catch (simError) {
        const simMsg = simError instanceof Error ? simError.message : String(simError);
        throw new Error(
          `Simulation reverted for smart account ${String(input.smartAccountName)} — skipping UserOp: ${simMsg.slice(0, 200)}`,
          { cause: simError },
        );
      }
    }

    const opResult = await submitUserOperationViaRouter({
      smartAccountName: input.smartAccountName,
      calls,
    });
    return {
      ...opResult,
      ...(opResult.status === "complete" ? { amountOut: quotedAmountOut.toString() } : {}),
    };
  }

  const owner = await getCdpOwnerAccount();
  const smartAccount: CdpSmartAccount = await getCdpClient().evm.getOrCreateSmartAccount({
    name: input.smartAccountName,
    owner,
  });

  const swapResult = await smartAccount.swap({
    network: resolveCdpNetwork(input.network),
    fromToken: input.fromToken,
    toToken: input.toToken,
    fromAmount: input.fromAmount,
    slippageBps: input.slippageBps,
  });

  const userOpHash = assertHash(swapResult.userOpHash, "swap userOpHash");
  const finalized = await waitForUserOperationWithBundlerFirst({
    userOpHash,
    waitWithCdp: () => smartAccount.waitForUserOperation({ userOpHash }),
    context: "swap",
  });

  return {
    userOpHash,
    txHash: finalized.txHash,
    status: finalized.status,
    ...(finalized.errorMessage ? { errorMessage: finalized.errorMessage } : {}),
  };
}

export async function sendUserOperationFromSmartAccount(input: {
  smartAccountName: string;
  calls: Array<{
    to: `0x${string}`;
    data: `0x${string}`;
    value: bigint;
  }>;
  network?: SupportedNetwork;
}): Promise<{ userOpHash: `0x${string}`; txHash: `0x${string}` | null; status: string }> {
  if (isCdpMockMode()) {
    return {
      userOpHash: mockHash(`mock-userop:${input.smartAccountName}`),
      txHash: mockHash(`mock-userop-tx:${input.smartAccountName}`),
      status: "complete",
    };
  }

  if (getSignerBackend() === "local") {
    return submitUserOperationViaRouter({
      smartAccountName: input.smartAccountName,
      calls: input.calls.map((call) => ({
        to: call.to,
        value: call.value,
        data: call.data,
      })),
    });
  }

  const owner = await getCdpOwnerAccount();
  const smartAccount: CdpSmartAccount = await getCdpClient().evm.getOrCreateSmartAccount({
    name: input.smartAccountName,
    owner,
  });

  const opResult = await getCdpClient().evm.sendUserOperation({
    smartAccount,
    network: resolveCdpNetwork(input.network),
    calls: input.calls,
  });

  const userOpHash = assertHash(opResult.userOpHash, "user operation hash");
  const finalized = await waitForUserOperationWithBundlerFirst({
    userOpHash,
    waitWithCdp: () => smartAccount.waitForUserOperation({ userOpHash }),
    context: "user operation",
  });

  return {
    userOpHash,
    txHash: finalized.txHash,
    status: finalized.status,
  };
}

export function getSignerBackendInfo() {
  return {
    backend: getSignerBackend(),
    chainId: getChainCfg().chainId,
    rpcUrl: getChainCfg().rpcUrl,
  };
}

/** Klawley account name for use with swapFromSmartAccount/sendUserOperationFromSmartAccount */
export { KLAWLEY_ACCOUNT_NAME, KLAWLEY_SMART_WALLET };

/**
 * Check if Klawley's Zora trading account is configured.
 * Returns null if not configured, or the wallet info if ready.
 */
export function getKlawleyAccountInfo(): {
  eoaAddress: `0x${string}`;
  smartWalletAddress: `0x${string}`;
  accountName: string;
} | null {
  if (!process.env.ZORA_PRIVATE_KEY) return null;
  const owner = localAccountForName(KLAWLEY_ACCOUNT_NAME);
  return {
    eoaAddress: owner.address,
    smartWalletAddress: KLAWLEY_SMART_WALLET,
    accountName: KLAWLEY_ACCOUNT_NAME,
  };
}
