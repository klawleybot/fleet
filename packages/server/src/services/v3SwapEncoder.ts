/**
 * Universal Router V3_SWAP_EXACT_IN command encoder.
 *
 * Encodes the V3 swap command for the Universal Router. Returns only the
 * commands bytes and inputs array — not the full execute() call — so callers
 * can compose multiple commands into one transaction if needed.
 */
import { encodeAbiParameters, encodeFunctionData, type Address, type Hex } from "viem";

// V3_SWAP_EXACT_IN command ID
const V3_SWAP_EXACT_IN_COMMAND = 0x00;

// Universal Router execute ABI (same as v4SwapEncoder)
const executeAbi = [
  {
    name: "execute",
    type: "function",
    stateMutability: "payable",
    inputs: [
      { name: "commands", type: "bytes" },
      { name: "inputs", type: "bytes[]" },
      { name: "deadline", type: "uint256" },
    ],
    outputs: [],
  },
] as const;

// Router addresses per chain (same as v4SwapEncoder)
export const UNIVERSAL_ROUTER_ADDRESSES_V3: Record<number, Address> = {
  8453: "0x6ff5693b99212da76ad316178a184ab56d299b43",
  84532: "0x492e6456d9528771018deb9e87ef7750ef184104",
};

export interface V3ExactInSwapParams {
  /** Chain ID (e.g. 8453 for Base). */
  chainId: number;
  /** Recipient of the output tokens. */
  recipient: Address;
  /** Input token address. */
  tokenIn: Address;
  /** Output token address. */
  tokenOut: Address;
  /** V3 fee tier (e.g. 500, 3000, 10000). */
  fee: number;
  /** Exact input amount. */
  amountIn: bigint;
  /** Minimum acceptable output amount (slippage-protected). */
  minAmountOut: bigint;
  /**
   * Whether the payer is the user (via Permit2) rather than the router.
   * Use `true` when the smart account is paying via Permit2.
   * Use `false` when the router already holds the tokens (same-tx composition).
   */
  payerIsUser: boolean;
  /** Optional deadline (defaults to now + 30 min). */
  deadline?: bigint;
}

export interface V3SwapCommandParts {
  /** Single byte: 0x00 for V3_SWAP_EXACT_IN. */
  commands: Hex;
  /** ABI-encoded inputs for the command. */
  inputs: Hex[];
}

/**
 * Encode a V3 SWAP_EXACT_IN command for the Universal Router.
 *
 * Returns `{ commands, inputs }` for composing into a `router.execute()` call.
 * Does NOT produce the final execute() calldata — use `encodeV3ExactInSwapCall`
 * for a standalone router call.
 */
export function encodeV3ExactInSwap(params: V3ExactInSwapParams): V3SwapCommandParts {
  // Encode the V3 path: tokenIn (20 bytes) + fee (3 bytes) + tokenOut (20 bytes)
  const tokenInHex = params.tokenIn.toLowerCase().replace(/^0x/, "");
  const tokenOutHex = params.tokenOut.toLowerCase().replace(/^0x/, "");
  const feeHex = params.fee.toString(16).padStart(6, "0"); // 3 bytes = 6 hex chars
  const pathHex = `0x${tokenInHex}${feeHex}${tokenOutHex}` as Hex;

  // ABI-encode the V3_SWAP_EXACT_IN input:
  // (address recipient, uint256 amountIn, uint256 amountOutMinimum, bytes path, bool payerIsUser)
  const encodedInput = encodeAbiParameters(
    [
      { type: "address", name: "recipient" },
      { type: "uint256", name: "amountIn" },
      { type: "uint256", name: "amountOutMinimum" },
      { type: "bytes", name: "path" },
      { type: "bool", name: "payerIsUser" },
    ],
    [
      params.recipient,
      params.amountIn,
      params.minAmountOut,
      pathHex,
      params.payerIsUser,
    ],
  );

  const commands: Hex = `0x${Buffer.from([V3_SWAP_EXACT_IN_COMMAND]).toString("hex")}`;

  return { commands, inputs: [encodedInput] };
}

export interface EncodedV3SwapCall {
  to: Address;
  data: Hex;
  value: bigint;
}

/**
 * Encode a standalone V3 SWAP_EXACT_IN execute() call for the Universal Router.
 * Use this when the V3 swap is its own router call (not composed with V4).
 */
export function encodeV3ExactInSwapCall(params: V3ExactInSwapParams): EncodedV3SwapCall {
  const routerAddress = UNIVERSAL_ROUTER_ADDRESSES_V3[params.chainId];
  if (!routerAddress) {
    throw new Error(`No Universal Router address for chainId ${params.chainId}`);
  }

  const deadline = params.deadline ?? BigInt(Math.floor(Date.now() / 1000) + 1800);
  const { commands, inputs } = encodeV3ExactInSwap(params);

  const data = encodeFunctionData({
    abi: executeAbi,
    functionName: "execute",
    args: [commands, inputs, deadline],
  });

  return { to: routerAddress, data, value: 0n };
}
