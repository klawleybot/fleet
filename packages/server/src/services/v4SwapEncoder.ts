import { encodeAbiParameters, encodeFunctionData, type Address } from "viem";

// --- Router addresses per chain ---
export const UNIVERSAL_ROUTER_ADDRESSES: Record<number, `0x${string}`> = {
  8453: "0x6ff5693b99212da76ad316178a184ab56d299b43",
  84532: "0x492e6456d9528771018deb9e87ef7750ef184104",
};

const NATIVE_ETH: Address = "0x0000000000000000000000000000000000000000";

// --- Command & Action IDs ---
const V4_SWAP_COMMAND = 0x10;
const SWAP_EXACT_IN = 0x07;
const SETTLE_ALL = 0x0c;
const TAKE_ALL = 0x0f;

// --- ABI fragments ---
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

// PathKey tuple type for ABI encoding
const pathKeyTupleType = {
  type: "tuple",
  components: [
    { name: "intermediateCurrency", type: "address" },
    { name: "fee", type: "uint24" },
    { name: "tickSpacing", type: "int24" },
    { name: "hooks", type: "address" },
    { name: "hookData", type: "bytes" },
  ],
} as const;

// ExactInputParams ABI type
const exactInputParamsType = {
  type: "tuple",
  components: [
    { name: "currencyIn", type: "address" },
    { name: "path", type: "tuple[]", components: pathKeyTupleType.components },
    { name: "amountIn", type: "uint128" },
    { name: "amountOutMinimum", type: "uint128" },
  ],
} as const;

export interface PoolParams {
  fee: number;
  tickSpacing: number;
  hooks: `0x${string}`;
  hookData: `0x${string}`;
}

export const DEFAULT_POOL_PARAMS: PoolParams = {
  fee: 3000,
  tickSpacing: 60,
  hooks: NATIVE_ETH, // address(0)
  hookData: "0x",
};

export interface EncodeV4ExactInSwapParams {
  chainId: number;
  path: `0x${string}`[];
  amountIn: bigint;
  minAmountOut: bigint;
  deadline?: bigint;
  poolParamsPerHop?: PoolParams[] | undefined;
}

export interface EncodedSwapCall {
  to: `0x${string}`;
  data: `0x${string}`;
  value: bigint;
}

export function getRouterAddress(chainId: number): `0x${string}` {
  const addr = UNIVERSAL_ROUTER_ADDRESSES[chainId];
  if (!addr) throw new Error(`No Universal Router address for chainId ${chainId}`);
  return addr;
}

export function encodeV4ExactInSwap(params: EncodeV4ExactInSwapParams): EncodedSwapCall {
  const { chainId, path, amountIn, minAmountOut, poolParamsPerHop } = params;

  if (path.length < 2) throw new Error("Path must have at least 2 tokens");

  const hops = path.length - 1;
  const routerAddress = getRouterAddress(chainId);
  const currencyIn = path[0]!;
  const currencyOut = path[path.length - 1]!;
  const deadline = params.deadline ?? BigInt(Math.floor(Date.now() / 1000) + 1800); // 30 min default

  // Build PathKey[]
  const pathKeys = [];
  for (let i = 0; i < hops; i++) {
    const pp = poolParamsPerHop?.[i] ?? DEFAULT_POOL_PARAMS;
    pathKeys.push({
      intermediateCurrency: path[i + 1]!,
      fee: pp.fee,
      tickSpacing: pp.tickSpacing,
      hooks: pp.hooks,
      hookData: pp.hookData,
    });
  }

  // Encode SWAP_EXACT_IN params
  const swapExactInEncoded = encodeAbiParameters(
    [exactInputParamsType],
    [
      {
        currencyIn,
        path: pathKeys,
        amountIn,
        amountOutMinimum: minAmountOut,
      },
    ],
  );

  // Encode SETTLE_ALL params: abi.encode(address, uint256)
  const settleAllEncoded = encodeAbiParameters(
    [
      { type: "address", name: "currency" },
      { type: "uint256", name: "maxAmount" },
    ],
    [currencyIn, amountIn],
  );

  // Encode TAKE_ALL params: abi.encode(address, uint256)
  const takeAllEncoded = encodeAbiParameters(
    [
      { type: "address", name: "currency" },
      { type: "uint256", name: "minAmount" },
    ],
    [currencyOut, minAmountOut],
  );

  // Pack actions as bytes: [0x07, 0x0c, 0x0f]
  const actionsBytes = `0x${Buffer.from([SWAP_EXACT_IN, SETTLE_ALL, TAKE_ALL]).toString("hex")}` as `0x${string}`;

  // Encode V4_SWAP input: abi.encode(bytes actions, bytes[] params)
  const v4SwapInput = encodeAbiParameters(
    [
      { type: "bytes", name: "actions" },
      { type: "bytes[]", name: "params" },
    ],
    [actionsBytes, [swapExactInEncoded, settleAllEncoded, takeAllEncoded]],
  );

  // commands = single byte 0x10
  const commands = `0x${Buffer.from([V4_SWAP_COMMAND]).toString("hex")}` as `0x${string}`;

  // Encode outer execute call
  const data = encodeFunctionData({
    abi: executeAbi,
    functionName: "execute",
    args: [commands, [v4SwapInput], deadline],
  });

  // Native ETH in → set value
  const isNativeIn = currencyIn.toLowerCase() === NATIVE_ETH.toLowerCase();

  return {
    to: routerAddress,
    data,
    value: isNativeIn ? amountIn : 0n,
  };
}
