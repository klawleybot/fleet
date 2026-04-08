/**
 * Reusable Price Quoter Service
 *
 * Extracts the sequential single-hop quoting pattern from fleet-ops.ts
 * into a reusable service. Uses quoteExactInputSingle per-hop because
 * multi-hop quoteExactInput fails on Doppler hooks (HookNotImplemented).
 */
import {
  createPublicClient,
  encodeFunctionData,
  decodeAbiParameters,
  http,
  type Address,
} from "viem";
import { base } from "viem/chains";
import { resolveCoinRoute } from "./coinRoute.js";
import { quoteExactInputSingle } from "./v4Quoter.js";
import { getChainConfig } from "./network.js";

// ---------------------------------------------------------------------------
// Pool key helper (extracted from fleet-ops.ts)
// ---------------------------------------------------------------------------

export function makePoolKey(
  tokenIn: Address,
  tokenOut: Address,
  params: { fee: number; tickSpacing: number; hooks: Address },
) {
  const [c0, c1] =
    tokenIn.toLowerCase() < tokenOut.toLowerCase()
      ? [tokenIn, tokenOut]
      : [tokenOut, tokenIn];
  return {
    poolKey: {
      currency0: c0,
      currency1: c1,
      fee: params.fee,
      tickSpacing: params.tickSpacing,
      hooks: params.hooks,
    },
    zeroForOne: tokenIn.toLowerCase() === c0.toLowerCase(),
  };
}

// ---------------------------------------------------------------------------
// Sequential single-hop quoting (extracted from fleet-ops.ts)
// ---------------------------------------------------------------------------

export interface QuoterClient {
  call(args: { to: Address; data: `0x${string}` }): Promise<{ data?: `0x${string}` | undefined }>;
}

export async function quoteMultiHop(
  client: QuoterClient,
  chainId: number,
  path: Address[],
  poolParams: Array<{ fee: number; tickSpacing: number; hooks: Address; hookData: string }>,
  amountIn: bigint,
): Promise<bigint> {
  let currentAmount = amountIn;
  for (let i = 0; i < path.length - 1; i++) {
    const pk = makePoolKey(path[i]!, path[i + 1]!, poolParams[i]!);
    const quote = await quoteExactInputSingle({
      chainId,
      client,
      poolKey: pk.poolKey,
      zeroForOne: pk.zeroForOne,
      amountIn: currentAmount,
    });
    currentAmount = quote.amountOut;
  }
  return currentAmount;
}

// ---------------------------------------------------------------------------
// High-level: quote coin → ETH
// ---------------------------------------------------------------------------

export async function quoteCoinToEth(params: {
  coinAddress: Address;
  amount: bigint;
  chainId?: number;
}): Promise<bigint> {
  const chainId = params.chainId ?? 8453;
  const cfg = getChainConfig();
  const client = createPublicClient({ chain: base, transport: http(cfg.rpcUrl) });

  const route = await resolveCoinRoute({
    client,
    coinAddress: params.coinAddress,
  });

  return quoteMultiHop(
    client,
    chainId,
    route.sellPath,
    route.sellPoolParams,
    params.amount,
  );
}

// ---------------------------------------------------------------------------
// V3 QuoterV2 — WETH → USDC (or any V3 single-hop)
// ---------------------------------------------------------------------------

/** V3 QuoterV2 addresses per chain. */
export const V3_QUOTER_ADDRESSES: Record<number, Address> = {
  8453: "0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a",
  84532: "0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a", // same on Sepolia — update if needed
};

const quoteExactInputSingleV3Abi = [
  {
    name: "quoteExactInputSingle",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      {
        name: "params",
        type: "tuple",
        components: [
          { name: "tokenIn", type: "address" },
          { name: "tokenOut", type: "address" },
          { name: "amountIn", type: "uint256" },
          { name: "fee", type: "uint24" },
          { name: "sqrtPriceLimitX96", type: "uint160" },
        ],
      },
    ],
    outputs: [
      { name: "amountOut", type: "uint256" },
      { name: "sqrtPriceX96After", type: "uint160" },
      { name: "initializedTicksCrossed", type: "uint32" },
      { name: "gasEstimate", type: "uint256" },
    ],
  },
] as const;

export interface V3QuoteParams {
  /** e.g. 8453 */
  chainId: number;
  /** viem public client */
  client: QuoterClient;
  tokenIn: Address;
  tokenOut: Address;
  /** V3 fee tier (500, 3000, 10000) */
  fee: number;
  amountIn: bigint;
}

export interface V3QuoteResult {
  amountOut: bigint;
  sqrtPriceX96After: bigint;
  gasEstimate: bigint;
}

/**
 * Quote a single-hop V3 exact-input swap using UniswapV3 QuoterV2.
 * Primary use: WETH → USDC at 500 fee tier on Base.
 */
export async function quoteV3ExactInput(params: V3QuoteParams): Promise<V3QuoteResult> {
  const quoterAddress = V3_QUOTER_ADDRESSES[params.chainId];
  if (!quoterAddress) {
    throw new Error(`No V3 QuoterV2 address for chainId ${params.chainId}`);
  }

  const data = encodeFunctionData({
    abi: quoteExactInputSingleV3Abi,
    functionName: "quoteExactInputSingle",
    args: [
      {
        tokenIn: params.tokenIn,
        tokenOut: params.tokenOut,
        amountIn: params.amountIn,
        fee: params.fee,
        sqrtPriceLimitX96: 0n,
      },
    ],
  });

  const result = await params.client.call({ to: quoterAddress, data });

  if (!result.data) {
    throw new Error("V3 QuoterV2 returned empty response");
  }

  const [amountOut, sqrtPriceX96After, , gasEstimate] = decodeAbiParameters(
    [
      { type: "uint256" },
      { type: "uint160" },
      { type: "uint32" },
      { type: "uint256" },
    ],
    result.data,
  );

  return { amountOut, sqrtPriceX96After, gasEstimate };
}

