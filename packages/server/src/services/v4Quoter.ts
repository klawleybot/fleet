import { encodeAbiParameters, decodeAbiParameters, encodeFunctionData, type Address, type PublicClient } from "viem";
import type { HopPoolParams } from "./swapRoute.js";

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
  client: PublicClient;
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

const returnTypes = [
  { type: "int128[]" as const },
  { type: "uint160[]" as const },
  { type: "uint32[]" as const },
] as const;

/** Get a quote for an exact-input swap via eth_call. */
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
