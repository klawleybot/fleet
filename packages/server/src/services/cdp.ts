import { createHash } from "node:crypto";
import { CdpClient } from "@coinbase/cdp-sdk";
import {
  createPublicClient,
  createWalletClient,
  http,
  isAddress,
  isHash,
  keccak256,
  parseEther,
  toHex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  createBundlerClient,
  sendUserOperation,
  toCoinbaseSmartAccount,
  waitForUserOperationReceipt,
} from "viem/account-abstraction";
import { getChainConfig } from "./network.js";
import { loadBundlerConfigFromEnv } from "./bundler/config.js";
import { getBundlerRouter } from "./bundler/index.js";
import { resolveDeterministicBuyRoute, resolveDeterministicSellRoute } from "./swapRoute.js";
import { resolveCoinRoute, type CoinRouteClient } from "./coinRoute.js";
import { encodeV4ExactInSwap, getRouterAddress } from "./v4SwapEncoder.js";
import { quoteExactInput, quoteExactInputSingle, applySlippage, getQuoterAddress } from "./v4Quoter.js";
import { ensurePermit2Approval } from "./erc20.js";
import { discoverPoolParams } from "./poolDiscovery.js";

const OWNER_ACCOUNT_NAME = "fleet-owner";
const MASTER_SMART_ACCOUNT_NAME = "master";
const CDP_MOCK_MODE = process.env.CDP_MOCK_MODE === "1";
const chainCfg = getChainConfig();

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
  return (network ?? chainCfg.cdpNetwork) as T;
}

let cdpClient: CdpClient | null = null;
let mockCounter = 0;
const localSmartAccountCache = new Map<string, Awaited<ReturnType<typeof toCoinbaseSmartAccount>>>();

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

function mockAddress(kind: "owner" | "smart", name: string): `0x${string}` {
  const digest = createHash("sha256").update(`${kind}:${name}`).digest("hex").slice(0, 40);
  return `0x${digest}` as `0x${string}`;
}

function mockHash(label: string): `0x${string}` {
  mockCounter += 1;
  const digest = createHash("sha256")
    .update(`${label}:${Date.now()}:${mockCounter}`)
    .digest("hex")
    .slice(0, 64);
  return `0x${digest}` as `0x${string}`;
}

function localSeed(): string {
  const seed = process.env.LOCAL_SIGNER_SEED;
  if (!seed || !seed.trim()) {
    throw new Error("SIGNER_BACKEND=local requires LOCAL_SIGNER_SEED (or set SIGNER_BACKEND=cdp).");
  }
  return seed.trim();
}

function deriveLocalPrivateKey(name: string): `0x${string}` {
  if (name === MASTER_SMART_ACCOUNT_NAME && process.env.MASTER_WALLET_PRIVATE_KEY) {
    const pk = process.env.MASTER_WALLET_PRIVATE_KEY.trim();
    if (!/^0x[0-9a-fA-F]{64}$/.test(pk)) {
      throw new Error("MASTER_WALLET_PRIVATE_KEY must be a 0x-prefixed 32-byte hex string.");
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
    chain: chainCfg.chain,
    transport: http(chainCfg.rpcUrl),
  });
}

function localPublicClient() {
  return createPublicClient({
    chain: chainCfg.chain,
    transport: http(chainCfg.rpcUrl),
  });
}

async function getLocalSmartAccount(name: string) {
  const cached = localSmartAccountCache.get(name);
  if (cached) return cached;

  const owner = localAccountForName(name);
  const smart = await toCoinbaseSmartAccount({
    client: localPublicClient(),
    owners: [owner],
    version: "1.1",
  });
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
}): Promise<{ userOpHash: `0x${string}`; txHash: `0x${string}` | null; status: string }> {
  if (!input.calls.length) throw new Error("calls[] cannot be empty");

  try {
    const account = await getLocalSmartAccount(input.smartAccountName);
    const bundlerCfg = loadBundlerConfigFromEnv();
    const bundlerClient = createBundlerClient({
      chain: chainCfg.chain,
      client: localPublicClient(),
      transport: http(bundlerCfg.primary.rpcUrl),
      account,
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

    return {
      userOpHash,
      txHash: receipt.receipt.transactionHash ?? null,
      status: receipt.success === false ? "failed" : "complete",
    };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    throw new Error(`Direct bundler submission failed for ${input.smartAccountName}: ${msg}`);
  }
}

async function waitForUserOperationWithBundlerFirst(input: {
  userOpHash: `0x${string}`;
  waitWithCdp: () => Promise<any>;
  context: string;
}): Promise<{ status: string; txHash: `0x${string}` | null }> {
  try {
    const bundlerReceipt = await getBundlerRouter().waitForReceipt(input.userOpHash);
    if (bundlerReceipt.included) {
      const txHash = bundlerReceipt.txHash ? assertHash(bundlerReceipt.txHash, `${input.context} bundler txHash`) : null;
      const success = bundlerReceipt.success;
      return {
        status: success === false ? "failed" : "complete",
        txHash,
      };
    }
  } catch {
    // Fall back to CDP receipt path if bundler polling errors.
  }

  const cdpReceipt = await input.waitWithCdp();
  return {
    status: cdpReceipt.status,
    txHash: extractTransactionHash(cdpReceipt, `${input.context} txHash`),
  };
}

export async function getOrCreateOwnerAccount(): Promise<EvmAccountRef> {
  if (CDP_MOCK_MODE) {
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

async function getOwnerAccountInternal(): Promise<any> {
  if (CDP_MOCK_MODE) {
    return { address: mockAddress("owner", OWNER_ACCOUNT_NAME), name: OWNER_ACCOUNT_NAME };
  }

  if (getSignerBackend() === "local") {
    return {
      address: localAccountForName(OWNER_ACCOUNT_NAME).address,
      name: OWNER_ACCOUNT_NAME,
    };
  }

  return getCdpClient().evm.getOrCreateAccount({ name: OWNER_ACCOUNT_NAME });
}

export async function createSmartAccount(
  name: string,
): Promise<{ owner: EvmAccountRef; smartAccount: SmartAccountRef }> {
  if (CDP_MOCK_MODE) {
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

  const ownerAccount = await getOwnerAccountInternal();
  const smartAccount = await getCdpClient().evm.createSmartAccount({
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
  if (CDP_MOCK_MODE) {
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

  const ownerAccount = await getOwnerAccountInternal();
  const smartAccount = await getCdpClient().evm.getOrCreateSmartAccount({
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
  if (CDP_MOCK_MODE) {
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

  const ownerAccount = await getOwnerAccountInternal();
  const smartAccount = await getCdpClient().evm.getOrCreateSmartAccount({
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
  if (CDP_MOCK_MODE) {
    if (!isAddress(input.to)) throw new Error(`Invalid recipient address: ${input.to}`);
    if (input.amountWei <= 0n) throw new Error("amountWei must be > 0");
    return {
      userOpHash: mockHash(`mock-owner-transfer-userop:${input.ownerName}`),
      txHash: mockHash(`mock-owner-transfer-tx:${input.ownerName}`),
      status: "complete",
    };
  }

  if (getSignerBackend() === "local") {
    if (!isAddress(input.to)) throw new Error(`Invalid recipient address: ${input.to}`);
    if (input.amountWei <= 0n) throw new Error("amountWei must be > 0");

    const wc = localWalletClient(input.ownerName);
    const pc = localPublicClient();
    const txHash = await wc.sendTransaction({
      to: input.to,
      value: input.amountWei,
      chain: chainCfg.chain,
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
  if (CDP_MOCK_MODE) {
    if (!isAddress(input.to)) throw new Error(`Invalid recipient address: ${input.to}`);
    if (input.amountWei <= 0n) throw new Error("amountWei must be > 0");
    return {
      userOpHash: mockHash(`mock-transfer-userop:${input.smartAccountName}`),
      txHash: mockHash(`mock-transfer-tx:${input.smartAccountName}`),
      status: "complete",
    };
  }

  if (getSignerBackend() === "local") {
    if (!isAddress(input.to)) throw new Error(`Invalid recipient address: ${input.to}`);
    if (input.amountWei <= 0n) throw new Error("amountWei must be > 0");

    return submitUserOperationViaRouter({
      smartAccountName: input.smartAccountName,
      calls: [{ to: input.to, value: input.amountWei, data: "0x" }],
    });
  }

  const owner = await getOwnerAccountInternal();
  const smartAccount = await getCdpClient().evm.getOrCreateSmartAccount({
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
}): Promise<{ userOpHash: `0x${string}`; txHash: `0x${string}` | null; status: string; amountOut?: string }> {
  if (CDP_MOCK_MODE) {
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
      chain: chainCfg.chain,
      transport: http(chainCfg.rpcUrl),
    });

    // Determine the coin address (the non-ETH/WETH token)
    const coinAddress = isSell ? input.fromToken : input.toToken;

    // Try on-chain route discovery first (coinRoute), fall back to env-var routing
    let routePath: `0x${string}`[];
    let routePoolParams: import("./swapRoute.js").HopPoolParams[] | undefined;

    try {
      const coinRoute = await resolveCoinRoute({
        client: publicClient as unknown as CoinRouteClient,
        coinAddress,
      });
      routePath = isSell ? coinRoute.sellPath : coinRoute.buyPath;
      routePoolParams = isSell ? coinRoute.sellPoolParams : coinRoute.buyPoolParams;
    } catch {
      // Fall back to env-var-based deterministic routing
      const route = isSell
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
      routePath = route.path;
      routePoolParams = route.poolParams;

      // Discover pool params if still missing
      if (!routePoolParams || routePoolParams.length === 0) {
        const target = isSell ? route.path[0]! : route.path[route.path.length - 1]!;
        if (target.toLowerCase() !== root && target.toLowerCase() !== WETH) {
          try {
            const params = await discoverPoolParams({
              client: publicClient,
              chainId: chainCfg.chainId,
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
        chainId: chainCfg.chainId,
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
          chainId: chainCfg.chainId,
          client: publicClient,
          poolKey: {
            currency0: currency0 as `0x${string}`,
            currency1: currency1 as `0x${string}`,
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
      chainId: chainCfg.chainId,
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
      const routerAddress = getRouterAddress(chainCfg.chainId);
      const permit2Calls = await ensurePermit2Approval({
        client: publicClient,
        token: input.fromToken,
        owner: smartAccount.address,
        router: routerAddress,
      });
      calls.push(...permit2Calls);
    }

    calls.push({ to: encoded.to, value: encoded.value, data: encoded.data });

    const opResult = await submitUserOperationViaRouter({
      smartAccountName: input.smartAccountName,
      calls,
    });
    return { ...opResult, amountOut: quotedAmountOut.toString() };
  }

  const owner = await getOwnerAccountInternal();
  const smartAccount = await getCdpClient().evm.getOrCreateSmartAccount({
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
  if (CDP_MOCK_MODE) {
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

  const owner = await getOwnerAccountInternal();
  const smartAccount = await getCdpClient().evm.getOrCreateSmartAccount({
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
    chainId: chainCfg.chainId,
    rpcUrl: chainCfg.rpcUrl,
  };
}
