import { decodeAbiParameters, decodeErrorResult, encodeFunctionData, type Address, type Hex } from "viem";
import type { HopPoolParams } from "./swapRoute.js";

/** Minimal client interface — only needs `call()` for eth_call quotes. */
export interface QuoteClient {
  call(args: { to: Address; data: `0x${string}` }): Promise<{ data?: `0x${string}` | undefined }>;
}

// --- Quoter addresses per chain ---
export const V4_QUOTER_ADDRESSES: Record<number, Address> = {
  8453: "0x0d5e0f971ed27fbff6c2837bf31316121532048d",
  84532: "0x4a6513c898fe1b2d0e78d3b0e0a4a151589b1cba",
};

const WETH: Address = "0x4200000000000000000000000000000000000006";
const NATIVE_ETH: Address = "0x0000000000000000000000000000000000000000";

/** Map WETH to address(0) for V4 native ETH representation. */
function toCurrency(token: Address): Address {
  return token.toLowerCase() === WETH.toLowerCase() ? NATIVE_ETH : token;
}

export function getQuoterAddress(chainId: number): Address {
  const addr = V4_QUOTER_ADDRESSES[chainId];
  if (!addr) throw new Error(`No V4 Quoter address for chainId ${chainId}`);
  return addr;
}

// --- ABI ---
const quoteExactInputAbi = [
  {
    name: "quoteExactInput",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      {
        name: "params",
        type: "tuple",
        components: [
          { name: "exactCurrency", type: "address" },
          {
            name: "path",
            type: "tuple[]",
            components: [
              { name: "intermediateCurrency", type: "address" },
              { name: "fee", type: "uint24" },
              { name: "tickSpacing", type: "int24" },
              { name: "hooks", type: "address" },
              { name: "hookData", type: "bytes" },
            ],
          },
          { name: "exactAmount", type: "uint128" },
        ],
      },
    ],
    outputs: [
      { name: "deltaAmounts", type: "int128[]" },
      { name: "sqrtPriceX96AfterList", type: "uint160[]" },
      { name: "initializedTicksCrossedList", type: "uint32[]" },
    ],
  },
] as const;

// --- Interfaces ---
export interface QuoteParams {
  chainId: number;
  client: QuoteClient;
  path: Address[];
  poolParams: HopPoolParams[];
  amountIn: bigint;
  exactInput: boolean;
}

export interface QuoteResult {
  amountOut: bigint;
  sqrtPriceX96After: bigint[];
  initializedTicksCrossed: number[];
  gasEstimate: bigint;
}

/** Build the PathKey[] from path addresses and pool params. */
function buildPathKeys(
  path: Address[],
  poolParams: HopPoolParams[],
): Array<{
  intermediateCurrency: Address;
  fee: number;
  tickSpacing: number;
  hooks: Address;
  hookData: `0x${string}`;
}> {
  // path has N tokens, poolParams has N-1 entries
  // PathKey[i] uses path[i+1] as intermediateCurrency and poolParams[i] for pool config
  return poolParams.map((pp, i) => ({
    intermediateCurrency: toCurrency(path[i + 1]!),
    fee: pp.fee,
    tickSpacing: pp.tickSpacing,
    hooks: pp.hooks,
    hookData: pp.hookData,
  }));
}

/** Encode calldata for quoteExactInput. Exported for testing. */
export function encodeQuoteExactInputCalldata(params: {
  path: Address[];
  poolParams: HopPoolParams[];
  amountIn: bigint;
}): `0x${string}` {
  const exactCurrency = toCurrency(params.path[0]!);
  const pathKeys = buildPathKeys(params.path, params.poolParams);

  return encodeFunctionData({
    abi: quoteExactInputAbi,
    functionName: "quoteExactInput",
    args: [
      {
        exactCurrency,
        path: pathKeys,
        exactAmount: params.amountIn,
      },
    ],
  });
}

// --- quoteExactInputSingle ABI (for pools with custom hooks like Doppler) ---
const quoteExactInputSingleAbi = [
  {
    name: "quoteExactInputSingle",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      {
        name: "params",
        type: "tuple",
        components: [
          {
            name: "poolKey",
            type: "tuple",
            components: [
              { name: "currency0", type: "address" },
              { name: "currency1", type: "address" },
              { name: "fee", type: "uint24" },
              { name: "tickSpacing", type: "int24" },
              { name: "hooks", type: "address" },
            ],
          },
          { name: "zeroForOne", type: "bool" },
          { name: "exactAmount", type: "uint128" },
          { name: "hookData", type: "bytes" },
        ],
      },
    ],
    outputs: [
      { name: "deltaAmounts", type: "int128[]" },
      { name: "sqrtPriceX96After", type: "uint160" },
      { name: "initializedTicksCrossed", type: "uint32" },
    ],
  },
] as const;

const wrappedQuoterErrorAbi = [
  {
    name: "UnexpectedRevertBytes",
    type: "error",
    inputs: [{ name: "revertData", type: "bytes" }],
  },
] as const;

const knownV4QuoteErrorAbi = [
  {
    name: "PoolNotInitialized",
    type: "error",
    inputs: [],
  },
  {
    name: "HookNotImplemented",
    type: "error",
    inputs: [],
  },
] as const;

/** Parameters for a single-hop quote using the full PoolKey. */
export interface QuoteSingleParams {
  chainId: number;
  client: QuoteClient;
  poolKey: {
    currency0: Address;
    currency1: Address;
    fee: number;
    tickSpacing: number;
    hooks: Address;
  };
  zeroForOne: boolean;
  amountIn: bigint;
  hookData?: `0x${string}`;
}

function extractRevertData(error: unknown): Hex | null {
  const queue: unknown[] = [error];
  const seen = new Set<object>();

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || typeof current !== "object") continue;
    if (seen.has(current)) continue;
    seen.add(current);

    const record = current as Record<string, unknown>;
    const data = record.data;
    if (typeof data === "string" && data.startsWith("0x")) {
      return data as Hex;
    }

    if (record.cause) queue.push(record.cause);
  }

  return null;
}

export function describeKnownV4QuoteFailure(params: {
  poolKey: QuoteSingleParams["poolKey"];
}, error: unknown): string | null {
  let revertData = extractRevertData(error);
  if (!revertData || revertData === "0x") return null;

  try {
    const wrapped = decodeErrorResult({
      abi: wrappedQuoterErrorAbi,
      data: revertData,
    });
    if (wrapped.errorName === "UnexpectedRevertBytes") {
      const nested = wrapped.args[0];
      if (typeof nested === "string" && nested.startsWith("0x")) {
        revertData = nested;
      }
    }
  } catch {
    // Not wrapped — keep the original revert payload.
  }

  try {
    const decoded = decodeErrorResult({
      abi: knownV4QuoteErrorAbi,
      data: revertData,
    });

    switch (decoded.errorName) {
      case "PoolNotInitialized":
        return (
          `V4 pool not initialized for ${params.poolKey.currency0} -> ${params.poolKey.currency1} ` +
          `(fee=${params.poolKey.fee}, tickSpacing=${params.poolKey.tickSpacing}, hooks=${params.poolKey.hooks})`
        );
      case "HookNotImplemented":
        return (
          `V4 hook does not support quoting for ${params.poolKey.currency0} -> ${params.poolKey.currency1} ` +
          `(hooks=${params.poolKey.hooks})`
        );
      default:
        return null;
    }
  } catch {
    return null;
  }
}

/** Encode calldata for quoteExactInputSingle. Exported for testing. */
export function encodeQuoteExactInputSingleCalldata(params: {
  poolKey: QuoteSingleParams["poolKey"];
  zeroForOne: boolean;
  amountIn: bigint;
  hookData?: `0x${string}`;
}): `0x${string}` {
  return encodeFunctionData({
    abi: quoteExactInputSingleAbi,
    functionName: "quoteExactInputSingle",
    args: [
      {
        poolKey: params.poolKey,
        zeroForOne: params.zeroForOne,
        exactAmount: params.amountIn,
        hookData: params.hookData !== undefined ? params.hookData : "0x",
      },
    ],
  });
}

// The V4 Quoter's quoteExactInputSingle returns two uint256 values:
// [0] = amountOut (positive output amount)
// [1] = gasEstimate
const singleReturnTypes = [
  { type: "uint256" as const },
  { type: "uint256" as const },
] as const;

/**
 * Get a quote for a single-hop exact-input swap via eth_call.
 * Uses quoteExactInputSingle which takes the full PoolKey — required for
 * pools with custom hooks (e.g. Zora Doppler) where quoteExactInput fails.
 */
export async function quoteExactInputSingle(params: QuoteSingleParams): Promise<QuoteResult> {
  const quoterAddress = getQuoterAddress(params.chainId);
  const hookData: `0x${string}` = params.hookData ?? "0x";
  const calldata = encodeQuoteExactInputSingleCalldata({
    poolKey: params.poolKey,
    zeroForOne: params.zeroForOne,
    amountIn: params.amountIn,
    hookData,
  });

  let data: `0x${string}` | undefined;
  try {
    ({ data } = await params.client.call({
      to: quoterAddress,
      data: calldata,
    }));
  } catch (error) {
    const knownFailure = describeKnownV4QuoteFailure(params, error);
    if (knownFailure) {
      throw new Error(knownFailure, { cause: error });
    }
    throw error;
  }

  if (!data) {
    throw new Error("V4 Quoter returned empty response");
  }

  const [amountOut, gasEstimate] =
    decodeAbiParameters(singleReturnTypes, data);

  return {
    amountOut,
    sqrtPriceX96After: [],
    initializedTicksCrossed: [],
    gasEstimate,
  };
}

const returnTypes = [
  { type: "int128[]" as const },
  { type: "uint160[]" as const },
  { type: "uint32[]" as const },
] as const;

/** Get a quote for an exact-input swap via eth_call (multi-hop path format). */
export async function quoteExactInput(params: QuoteParams): Promise<QuoteResult> {
  const quoterAddress = getQuoterAddress(params.chainId);
  const calldata = encodeQuoteExactInputCalldata({
    path: params.path,
    poolParams: params.poolParams,
    amountIn: params.amountIn,
  });

  const { data } = await params.client.call({
    to: quoterAddress,
    data: calldata,
  });

  if (!data) {
    throw new Error("V4 Quoter returned empty response");
  }

  const [deltaAmounts, sqrtPriceX96AfterList, initializedTicksCrossedList] =
    decodeAbiParameters(returnTypes, data);

  // For exact input, the output amount is the last deltaAmount (negative = output)
  const lastDelta = deltaAmounts[deltaAmounts.length - 1]!;
  const amountOut = lastDelta < 0n ? -lastDelta : lastDelta;

  return {
    amountOut,
    sqrtPriceX96After: sqrtPriceX96AfterList.map((v) => BigInt(v)),
    initializedTicksCrossed: initializedTicksCrossedList.map((v) => Number(v)),
    gasEstimate: 0n, // V4 quoter doesn't return gas; caller can estimate separately
  };
}

/** Apply slippage (in basis points) to get minimum acceptable output. */
export function applySlippage(amountOut: bigint, slippageBps: number): bigint {
  if (slippageBps < 0 || slippageBps > 10_000) {
    throw new Error("slippageBps must be between 0 and 10000");
  }
  return (amountOut * BigInt(10_000 - slippageBps)) / 10_000n;
}
