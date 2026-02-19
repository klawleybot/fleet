import {
  type Address,
  type PublicClient,
  type WalletClient,
  parseEventLogs,
  encodeFunctionData,
  zeroAddress,
} from "viem";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const ZORA_FACTORY_ADDRESS: Address =
  "0x777777751622c0d3258f214F9DF38E35BF45baF3";

const ZERO_ADDRESS: Address = zeroAddress;

// ---------------------------------------------------------------------------
// ABI (minimal – only what we need)
// ---------------------------------------------------------------------------

/**
 * Simplest `deploy` overload on ZoraFactory (content coin, no post-deploy hook):
 *   deploy(payoutRecipient, owners[], uri, name, symbol, platformReferrer,
 *          currency, tickSpacing(int24), initialPurchaseWei(uint256))
 *   → (coinAddress, amountOut)
 *
 * `CoinCreated` event carries the new coin + pool addresses.
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
      { name: "platformReferrer", type: "address" },
      { name: "currency", type: "address" },
      { name: "", type: "int24" },
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
  client: PublicClient;
  walletClient: WalletClient;
  name: string;
  symbol: string;
  tokenURI: string;
  payoutRecipient: Address;
  platformReferral?: Address | undefined;
  currency?: Address | undefined;
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
 * Build the calldata for the simple `deploy` overload.
 * Default tick-spacing 0 lets the factory choose.
 */
export function buildDeployCalldata(params: {
  payoutRecipient: Address;
  name: string;
  symbol: string;
  tokenURI: string;
  platformReferral?: Address | undefined;
  currency?: Address | undefined;
  initialPurchaseWei?: bigint | undefined;
}): `0x${string}` {
  return encodeFunctionData({
    abi: zoraFactoryAbi,
    functionName: "deploy",
    args: [
      params.payoutRecipient,
      [] as readonly Address[], // owners – empty for test coins
      params.tokenURI,
      params.name,
      params.symbol,
      params.platformReferral ?? ZERO_ADDRESS,
      params.currency ?? ZERO_ADDRESS, // address(0) = native ETH
      0, // tickSpacing – 0 = default
      params.initialPurchaseWei ?? 0n,
    ],
  });
}

/**
 * Parse CoinCreated / CoinCreatedV4 from a transaction receipt and extract
 * the new coin address (and pool address when available).
 */
export function parseCoinCreatedLogs(logs: readonly { address: Address; topics: readonly `0x${string}`[]; data: `0x${string}` }[]): {
  coinAddress: Address;
  poolAddress?: Address | undefined;
} {
  // Try CoinCreatedV4 first (newer)
  const v4Events = parseEventLogs({
    abi: zoraFactoryAbi,
    eventName: "CoinCreatedV4",
    logs: logs as any, // viem's overloaded types
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
    logs: logs as any,
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

  const txHash = await walletClient.sendTransaction({
    to: ZORA_FACTORY_ADDRESS,
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
