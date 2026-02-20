/**
 * Reusable Price Quoter Service
 *
 * Extracts the sequential single-hop quoting pattern from fleet-ops.ts
 * into a reusable service. Uses quoteExactInputSingle per-hop because
 * multi-hop quoteExactInput fails on Doppler hooks (HookNotImplemented).
 */
import { createPublicClient, http, type Address } from "viem";
import { base } from "viem/chains";
import { resolveCoinRoute, type CoinRouteClient } from "./coinRoute.js";
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
      currency0: c0 as Address,
      currency1: c1 as Address,
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
    client: client as unknown as CoinRouteClient,
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
