import { describe, it, expect, beforeAll } from "vitest";
import {
  createPublicClient,
  createWalletClient,
  http,
  type Address,
  type PublicClient,
  type WalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import { launchCoin } from "../src/services/coinLauncher.js";
import { quoteExactInput, applySlippage } from "../src/services/v4Quoter.js";
import {
  encodeV4ExactInSwap,
  getRouterAddress,
  type PoolParams,
} from "../src/services/v4SwapEncoder.js";

// ---------------------------------------------------------------------------
// Skip unless E2E_BASE_SEPOLIA=1
// ---------------------------------------------------------------------------
const runE2e = process.env.E2E_BASE_SEPOLIA === "1";

const CHAIN_ID = 84532;
const WETH: Address = "0x4200000000000000000000000000000000000006";
const NATIVE_ETH: Address = "0x0000000000000000000000000000000000000000";

describe.skipIf(!runE2e)("e2e: swap lifecycle on Base Sepolia", () => {
  let client: PublicClient;
  let walletClient: WalletClient;
  let signerAddress: Address;

  // State shared across sequential tests
  let coinAddress: Address;

  beforeAll(() => {
    const rpcUrl = process.env.BASE_SEPOLIA_RPC_URL;
    if (!rpcUrl) throw new Error("BASE_SEPOLIA_RPC_URL not set");

    const pk = process.env.SIGNER_PRIVATE_KEY;
    if (!pk) throw new Error("SIGNER_PRIVATE_KEY not set");

    const account = privateKeyToAccount(pk as `0x${string}`);
    signerAddress = account.address;

    client = createPublicClient({
      chain: baseSepolia,
      transport: http(rpcUrl),
    });

    walletClient = createWalletClient({
      chain: baseSepolia,
      transport: http(rpcUrl),
      account,
    });
  });

  // -----------------------------------------------------------------------
  // Test 1: Launch a test coin
  // -----------------------------------------------------------------------
  it(
    "launches a test coin via Zora factory",
    async () => {
      const rand = Math.random().toString(36).slice(2, 8).toUpperCase();
      const name = `E2E Test ${rand}`;
      const symbol = `E2E${rand}`;

      const result = await launchCoin({
        client: client as any,
        walletClient: walletClient as any,
        name,
        symbol,
        tokenURI: `https://test.example.com/${rand}`,
        payoutRecipient: signerAddress,
      });

      expect(result.coinAddress).toMatch(/^0x[0-9a-fA-F]{40}$/);
      expect(result.txHash).toMatch(/^0x[0-9a-fA-F]{64}$/);

      coinAddress = result.coinAddress;
      console.log(`Launched coin: ${coinAddress} (tx: ${result.txHash})`);
    },
    { timeout: 120_000 },
  );

  // -----------------------------------------------------------------------
  // Test 2: Quote swap ETH → new coin
  // -----------------------------------------------------------------------
  let amountOut: bigint;
  let minAmountOut: bigint;

  // We need pool params for the coin. Since these are Zora Doppler pools the
  // fee/tickSpacing/hooks are deterministic per factory version. We read them
  // from the factory's pool info or use known defaults for Base Sepolia.
  // The quoter needs HopPoolParams.
  let hopPoolParams: { fee: number; tickSpacing: number; hooks: Address; hookData: `0x${string}` }[];

  it(
    "quotes a swap ETH → coin",
    async () => {
      expect(coinAddress).toBeDefined();

      // Small amount: 0.0001 ETH
      const amountIn = 100_000_000_000_000n; // 1e14

      // For a newly launched Zora coin on Base Sepolia the pool is
      // NATIVE_ETH ↔ coin with Doppler hooks. We'll try the simple
      // direct path first: [NATIVE_ETH, coin].
      // Pool params for Zora coins: fee=0, tickSpacing=60 (default), hooks=0x0 hookData=0x
      // These may vary; the quoter will revert if wrong. Adjust as needed.
      hopPoolParams = [
        {
          fee: 0,
          tickSpacing: 60,
          hooks: "0x0000000000000000000000000000000000000000" as Address,
          hookData: "0x" as `0x${string}`,
        },
      ];

      const quote = await quoteExactInput({
        chainId: CHAIN_ID,
        client: client as any,
        path: [NATIVE_ETH, coinAddress],
        poolParams: hopPoolParams,
        amountIn,
        exactInput: true,
      });

      expect(quote.amountOut).toBeGreaterThan(0n);

      amountOut = quote.amountOut;
      minAmountOut = applySlippage(amountOut, 100); // 1% slippage
      expect(minAmountOut).toBeGreaterThan(0n);
      expect(minAmountOut).toBeLessThan(amountOut);

      console.log(
        `Quote: ${amountIn} wei ETH → ${amountOut} coin (min after 1% slippage: ${minAmountOut})`,
      );
    },
    { timeout: 60_000 },
  );

  // -----------------------------------------------------------------------
  // Test 3: Encode swap calldata
  // -----------------------------------------------------------------------
  it("encodes swap calldata targeting Universal Router", () => {
    expect(amountOut).toBeDefined();

    const amountIn = 100_000_000_000_000n;
    const poolParamsPerHop: PoolParams[] = hopPoolParams.map((p) => ({
      fee: p.fee,
      tickSpacing: p.tickSpacing,
      hooks: p.hooks as `0x${string}`,
      hookData: p.hookData,
    }));

    const encoded = encodeV4ExactInSwap({
      chainId: CHAIN_ID,
      path: [NATIVE_ETH, coinAddress],
      amountIn,
      minAmountOut,
      poolParamsPerHop,
    });

    expect(encoded.to).toBe(getRouterAddress(CHAIN_ID));
    expect(encoded.data).toMatch(/^0x[0-9a-fA-F]+$/);
    expect(encoded.data.length).toBeGreaterThan(10);
    expect(encoded.value).toBe(amountIn);

    console.log(`Encoded swap calldata: ${encoded.data.length} hex chars → ${encoded.to}`);
  });

  // -----------------------------------------------------------------------
  // Test 4: Full lifecycle — launch, quote, encode, submit
  // -----------------------------------------------------------------------
  it(
    "full lifecycle: launch → quote → encode → submit swap",
    async () => {
      // Launch a fresh coin
      const rand = Math.random().toString(36).slice(2, 8).toUpperCase();
      const { coinAddress: freshCoin, txHash: launchTx } = await launchCoin({
        client: client as any,
        walletClient: walletClient as any,
        name: `Lifecycle ${rand}`,
        symbol: `LC${rand}`,
        tokenURI: `https://test.example.com/lifecycle-${rand}`,
        payoutRecipient: signerAddress,
      });
      console.log(`Full lifecycle — launched: ${freshCoin} (${launchTx})`);

      // Quote
      const amountIn = 50_000_000_000_000n; // 0.00005 ETH
      const freshHopParams = [
        {
          fee: 0,
          tickSpacing: 60,
          hooks: "0x0000000000000000000000000000000000000000" as Address,
          hookData: "0x" as `0x${string}`,
        },
      ];

      const quote = await quoteExactInput({
        chainId: CHAIN_ID,
        client: client as any,
        path: [NATIVE_ETH, freshCoin],
        poolParams: freshHopParams,
        amountIn,
        exactInput: true,
      });
      expect(quote.amountOut).toBeGreaterThan(0n);
      const minOut = applySlippage(quote.amountOut, 200); // 2% slippage

      // Encode
      const encoded = encodeV4ExactInSwap({
        chainId: CHAIN_ID,
        path: [NATIVE_ETH, freshCoin],
        amountIn,
        minAmountOut: minOut,
        poolParamsPerHop: freshHopParams.map((p) => ({
          fee: p.fee,
          tickSpacing: p.tickSpacing,
          hooks: p.hooks as `0x${string}`,
          hookData: p.hookData,
        })),
      });

      expect(encoded.to).toBe(getRouterAddress(CHAIN_ID));
      expect(encoded.value).toBe(amountIn);

      // Submit the swap transaction
      const swapTxHash = await walletClient.sendTransaction({
        to: encoded.to,
        data: encoded.data,
        value: encoded.value,
        chain: baseSepolia,
        account: walletClient.account!,
      });
      console.log(`Swap tx submitted: ${swapTxHash}`);

      const receipt = await (client as any).waitForTransactionReceipt({
        hash: swapTxHash,
        timeout: 60_000,
      });
      expect(receipt.status).toBe("success");
      console.log(`Swap tx confirmed in block ${receipt.blockNumber}`);
    },
    { timeout: 180_000 },
  );
});
