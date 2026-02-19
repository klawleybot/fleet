import {
  type Address,
  type Chain,
  type Log,
  parseEventLogs,
  encodeFunctionData,
  encodeAbiParameters,
  decodeAbiParameters,
  zeroAddress,
} from "viem";

/** Minimal client interface — only needs waitForTransactionReceipt. */
export interface LaunchPublicClient {
  waitForTransactionReceipt(args: { hash: `0x${string}` }): Promise<{ logs: Log[]; status: "success" | "reverted" }>;
}

/** Minimal wallet client — needs sendTransaction, account, and chain. */
export interface LaunchWalletClient {
  account?: { address: Address } | undefined;
  chain?: Chain | undefined;
  sendTransaction(args: { chain: Chain | undefined; to: Address; data: `0x${string}`; value: bigint; account: { address: Address } }): Promise<`0x${string}`>;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** ZoraFactory addresses per chain (Base mainnet vs Base Sepolia differ). */
export const ZORA_FACTORY_ADDRESSES: Record<number, Address> = {
  8453: "0x777777751622c0d3258f214F9DF38E35BF45baF3",
  84532: "0xaF88840cb637F2684A9E460316b1678AD6245e4a",
};

/** @deprecated Use ZORA_FACTORY_ADDRESSES[chainId] instead */
export const ZORA_FACTORY_ADDRESS: Address =
  "0x777777751622c0d3258f214F9DF38E35BF45baF3";

/** $BLDR token on Base Sepolia (test backing currency). */
export const BLDR_TOKEN_SEPOLIA: Address =
  "0x1121c8e28dcf9C0C528f13A615840Df8D3CCF76B";

const ZERO_ADDRESS: Address = zeroAddress;

// ---------------------------------------------------------------------------
// Doppler Pool Config encode/decode
// ---------------------------------------------------------------------------

const POOL_CONFIG_ABI_PARAMS = [
  { type: "uint8", name: "version" },
  { type: "address", name: "currency" },
  { type: "int24[]", name: "tickLower" },
  { type: "int24[]", name: "tickUpper" },
  { type: "uint16[]", name: "numDiscoveryPositions" },
  { type: "uint256[]", name: "maxDiscoverySupplyShare" },
] as const;

export function decodeDopplerPoolConfig(poolConfig: `0x${string}`) {
  const [version, currency, tickLower, tickUpper, numDiscoveryPositions, maxDiscoverySupplyShare] =
    decodeAbiParameters(POOL_CONFIG_ABI_PARAMS, poolConfig);
  return { version, currency, tickLower, tickUpper, numDiscoveryPositions, maxDiscoverySupplyShare };
}

export function encodeDopplerPoolConfig(
  currency: `0x${string}`,
  tickLower: readonly number[],
  tickUpper: readonly number[],
  numDiscoveryPositions: readonly number[],
  maxDiscoverySupplyShare: readonly bigint[],
): `0x${string}` {
  return encodeAbiParameters(
    POOL_CONFIG_ABI_PARAMS,
    [4, currency, tickLower, tickUpper, numDiscoveryPositions, maxDiscoverySupplyShare],
  );
}

// ---------------------------------------------------------------------------
// Default pool config presets
// ---------------------------------------------------------------------------

export interface DopplerPoolPreset {
  tickLower: readonly number[];
  tickUpper: readonly number[];
  numDiscoveryPositions: readonly number[];
  maxDiscoverySupplyShare: readonly bigint[];
}

/** LOW starting market cap — from successful Base Sepolia deploys. */
export const DOPPLER_PRESET_LOW: DopplerPoolPreset = {
  tickLower: [29800, 45800, 49800],
  tickUpper: [49800, 51800, 51800],
  numDiscoveryPositions: [11, 11, 11],
  maxDiscoverySupplyShare: [250000000000000000n, 300000000000000000n, 150000000000000000n],
};

/** HIGH starting market cap — wider initial range. */
export const DOPPLER_PRESET_HIGH: DopplerPoolPreset = {
  tickLower: [19800, 35800, 39800],
  tickUpper: [39800, 41800, 41800],
  numDiscoveryPositions: [11, 11, 11],
  maxDiscoverySupplyShare: [250000000000000000n, 300000000000000000n, 150000000000000000n],
};

/** Default currency per chain. Sepolia uses $BLDR; mainnet uses native ETH (address(0)). */
export function defaultCurrencyForChain(chainId: number): Address {
  if (chainId === 84532) return BLDR_TOKEN_SEPOLIA;
  return ZERO_ADDRESS;
}

// ---------------------------------------------------------------------------
// ABI (minimal – only what we need)
// ---------------------------------------------------------------------------

/**
 * `deploy` overload 2 — takes `bytes poolConfig` (Doppler multi-curve encoding):
 *   deploy(payoutRecipient, owners[], uri, name, symbol, poolConfig, platformReferrer, initialPurchaseWei)
 *   → (coinAddress, amountOut)
 *
 * `CoinCreated` / `CoinCreatedV4` events carry the new coin + pool info.
 */
export const zoraFactoryAbi = [
  {
    type: "function",
    name: "deploy",
    inputs: [
      { name: "payoutRecipient", type: "address" },
      { name: "owners", type: "address[]" },
      { name: "uri", type: "string" },
      { name: "name", type: "string" },
      { name: "symbol", type: "string" },
      { name: "poolConfig", type: "bytes" },
      { name: "platformReferrer", type: "address" },
      { name: "", type: "uint256" },
    ],
    outputs: [
      { name: "", type: "address" },
      { name: "", type: "uint256" },
    ],
    stateMutability: "payable",
  },
  // CoinCreated (v3-style pool, has `pool` address)
  {
    type: "event",
    anonymous: false,
    name: "CoinCreated",
    inputs: [
      { name: "caller", type: "address", indexed: true },
      { name: "payoutRecipient", type: "address", indexed: true },
      { name: "platformReferrer", type: "address", indexed: true },
      { name: "currency", type: "address", indexed: false },
      { name: "uri", type: "string", indexed: false },
      { name: "name", type: "string", indexed: false },
      { name: "symbol", type: "string", indexed: false },
      { name: "coin", type: "address", indexed: false },
      { name: "pool", type: "address", indexed: false },
      { name: "version", type: "string", indexed: false },
    ],
  },
  // CoinCreatedV4 (v4-style pool, has poolKey tuple)
  {
    type: "event",
    anonymous: false,
    name: "CoinCreatedV4",
    inputs: [
      { name: "caller", type: "address", indexed: true },
      { name: "payoutRecipient", type: "address", indexed: true },
      { name: "platformReferrer", type: "address", indexed: true },
      { name: "currency", type: "address", indexed: false },
      { name: "uri", type: "string", indexed: false },
      { name: "name", type: "string", indexed: false },
      { name: "symbol", type: "string", indexed: false },
      { name: "coin", type: "address", indexed: false },
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
        indexed: false,
      },
      { name: "poolKeyHash", type: "bytes32", indexed: false },
      { name: "version", type: "string", indexed: false },
    ],
  },
] as const;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CoinLaunchParams {
  chainId: number;
  client: LaunchPublicClient;
  walletClient: LaunchWalletClient;
  name: string;
  symbol: string;
  tokenURI: string;
  payoutRecipient: Address;
  platformReferral?: Address | undefined;
  /** Backing currency. Defaults to $BLDR on Sepolia, address(0) on mainnet. */
  currency?: Address | undefined;
  /** Doppler preset: "low" or "high" starting market cap. Default: "low". */
  marketCapPreset?: "low" | "high" | undefined;
  /** Custom tick ranges — overrides marketCapPreset if provided. */
  customPoolConfig?: DopplerPoolPreset | undefined;
  initialPurchaseWei?: bigint | undefined;
}

export interface CoinLaunchResult {
  coinAddress: Address;
  txHash: `0x${string}`;
  poolAddress?: Address | undefined;
}

// ---------------------------------------------------------------------------
// Helpers (exported for unit-testing)
// ---------------------------------------------------------------------------

/**
 * Build the calldata for the `deploy` overload that takes `bytes poolConfig`.
 */
export function buildDeployCalldata(params: {
  chainId: number;
  payoutRecipient: Address;
  name: string;
  symbol: string;
  tokenURI: string;
  platformReferral?: Address | undefined;
  currency?: Address | undefined;
  marketCapPreset?: "low" | "high" | undefined;
  customPoolConfig?: DopplerPoolPreset | undefined;
  initialPurchaseWei?: bigint | undefined;
}): `0x${string}` {
  const currency = params.currency ?? defaultCurrencyForChain(params.chainId);
  const preset = params.customPoolConfig
    ?? (params.marketCapPreset === "high" ? DOPPLER_PRESET_HIGH : DOPPLER_PRESET_LOW);

  const poolConfig = encodeDopplerPoolConfig(
    currency,
    preset.tickLower,
    preset.tickUpper,
    preset.numDiscoveryPositions,
    preset.maxDiscoverySupplyShare,
  );

  return encodeFunctionData({
    abi: zoraFactoryAbi,
    functionName: "deploy",
    args: [
      params.payoutRecipient,
      [params.payoutRecipient] as readonly Address[], // at least one owner required
      params.tokenURI,
      params.name,
      params.symbol,
      poolConfig,
      params.platformReferral ?? ZERO_ADDRESS,
      params.initialPurchaseWei ?? 0n,
    ],
  });
}

/**
 * Parse CoinCreated / CoinCreatedV4 from a transaction receipt and extract
 * the new coin address (and pool address when available).
 */
export function parseCoinCreatedLogs(logs: Log[]): {
  coinAddress: Address;
  poolAddress?: Address | undefined;
} {
  // Try CoinCreatedV4 first (newer)
  const v4Events = parseEventLogs({
    abi: zoraFactoryAbi,
    eventName: "CoinCreatedV4",
    logs,
  });
  if (v4Events.length > 0) {
    const ev = v4Events[0]!;
    return {
      coinAddress: ev.args.coin,
      poolAddress: undefined, // V4 uses poolKey, not a single pool address
    };
  }

  // Fallback to CoinCreated (has pool address)
  const v3Events = parseEventLogs({
    abi: zoraFactoryAbi,
    eventName: "CoinCreated",
    logs,
  });
  if (v3Events.length > 0) {
    const ev = v3Events[0]!;
    return {
      coinAddress: ev.args.coin,
      poolAddress: ev.args.pool,
    };
  }

  throw new Error(
    "No CoinCreated or CoinCreatedV4 event found in transaction receipt",
  );
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export async function launchCoin(
  params: CoinLaunchParams,
): Promise<CoinLaunchResult> {
  const { client, walletClient } = params;

  const account = walletClient.account;
  if (!account) {
    throw new Error("WalletClient must have an account");
  }

  const calldata = buildDeployCalldata(params);
  const value = params.initialPurchaseWei ?? 0n;

  const factoryAddress = ZORA_FACTORY_ADDRESSES[params.chainId];
  if (!factoryAddress) {
    throw new Error(`No ZoraFactory address for chainId ${params.chainId}`);
  }

  const txHash = await walletClient.sendTransaction({
    to: factoryAddress,
    data: calldata,
    value,
    chain: walletClient.chain,
    account,
  });

  const receipt = await client.waitForTransactionReceipt({ hash: txHash });

  if (receipt.status !== "success") {
    throw new Error(`Coin deploy tx reverted: ${txHash}`);
  }

  const { coinAddress, poolAddress } = parseCoinCreatedLogs(receipt.logs);

  return { coinAddress, txHash, poolAddress };
}
