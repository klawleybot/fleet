import { describe, it, expect, beforeAll } from "vitest";
import {
  createPublicClient,
  http,
  formatEther,
  parseEther,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { base } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import {
  toCoinbaseSmartAccount,
  createBundlerClient,
  sendUserOperation,
  waitForUserOperationReceipt,
  type SmartAccount,
} from "viem/account-abstraction";
import {
  quoteExactInputSingle,
  applySlippage,
  getQuoterAddress,
} from "../src/services/v4Quoter.js";
import {
  encodeV4ExactInSwap,
  getRouterAddress,
} from "../src/services/v4SwapEncoder.js";
import { ensurePermit2Approval } from "../src/services/erc20.js";

// ---------------------------------------------------------------------------
// Skip unless E2E_BASE_MAINNET=1
// ---------------------------------------------------------------------------
const runE2e = process.env.E2E_BASE_MAINNET === "1";

const CHAIN_ID = 8453;
const NATIVE_ETH: Address = "0x0000000000000000000000000000000000000000";
const ZORA_TOKEN: Address = "0x1111111111166b7FE7bd91427724B487980aFc69";

// Target coin: "Superboy and the Invisible Girl"
// Nested: backed by kelleymiller, which is backed by ZORA
const TEST_COIN: Address = "0x40c6db1e8115f74eca045921710b25ab20a2c076";
const KELLEY_COIN: Address = "0xe44060e9BDcaA469460fcE4D3F7264E2a7b287D8";

// Pool params discovered from on-chain storage + quoting
const HOP1_PARAMS = {
  // ETH(native) → ZORA: standard V4 pool
  fee: 3000,
  tickSpacing: 60,
  hooks: NATIVE_ETH as `0x${string}`,
  hookData: "0x" as `0x${string}`,
};
const HOP2_PARAMS = {
  // ZORA → kelleymiller: Doppler hook pool
  fee: 30000,
  tickSpacing: 200,
  hooks: "0x5e5d19d22c85a4aef7c1fdf25fb22a5a38f71040" as `0x${string}`,
  hookData: "0x" as `0x${string}`,
};
const HOP3_PARAMS = {
  // kelleymiller → test_coin: Doppler hook pool
  fee: 10000,
  tickSpacing: 200,
  hooks: "0xc8d077444625eb300a427a6dfb2b1dbf9b159040" as `0x${string}`,
  hookData: "0x" as `0x${string}`,
};

const BUY_AMOUNT = parseEther("0.001");
const SLIPPAGE_BPS = 500; // 5% for 3-hop Doppler path

const balanceOfAbi = [
  {
    name: "balanceOf",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

function makePoolKey(
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

type BundlerClient = ReturnType<typeof createBundlerClient>;

describe.skipIf(!runE2e)("e2e: mainnet Base 3-hop buy+sell roundtrip", () => {
  let client: PublicClient;
  let smartAccount: SmartAccount;
  let smartAccountAddress: Address;
  let bundlerClient: BundlerClient;

  beforeAll(async () => {
    const rpcUrl = process.env.BASE_RPC_URL;
    if (!rpcUrl) throw new Error("BASE_RPC_URL not set");

    const privKey = process.env.MASTER_WALLET_PRIVATE_KEY;
    if (!privKey) throw new Error("MASTER_WALLET_PRIVATE_KEY not set");

    client = createPublicClient({ chain: base, transport: http(rpcUrl) });

    const owner = privateKeyToAccount(privKey as `0x${string}`);
    smartAccount = await toCoinbaseSmartAccount({
      client,
      owners: [owner],
      version: "1.1",
    });
    smartAccountAddress = smartAccount.address;

    console.log(`Smart Account: ${smartAccountAddress}`);

    const balance = await client.getBalance({ address: smartAccountAddress });
    console.log(`ETH balance: ${formatEther(balance)} ETH`);

    if (balance < BUY_AMOUNT + parseEther("0.001")) {
      throw new Error(
        `Insufficient ETH: ${formatEther(balance)}. Need ≥${formatEther(BUY_AMOUNT + parseEther("0.001"))}. Fund ${smartAccountAddress}`,
      );
    }

    const bundlerUrl =
      process.env.PIMLICO_BASE_BUNDLER_URL ||
      process.env.BUNDLER_PRIMARY_URL ||
      process.env.BUNDLER_RPC_URL;
    if (!bundlerUrl) throw new Error("No bundler URL");
    console.log(`Bundler: ${bundlerUrl.replace(/apikey=.*/, "apikey=***")}`);

    bundlerClient = createBundlerClient({
      account: smartAccount,
      chain: base,
      client,
      transport: http(bundlerUrl),
    });
  }, 30_000);

  // -----------------------------------------------------------------------
  // Test 1: Quote the full 3-hop buy
  // -----------------------------------------------------------------------
  let hop3Out: bigint;

  it(
    "quotes 3-hop buy: ETH → ZORA → kelleymiller → coin",
    async () => {
      const h1 = makePoolKey(NATIVE_ETH, ZORA_TOKEN, HOP1_PARAMS);
      const q1 = await quoteExactInputSingle({ chainId: CHAIN_ID, client, poolKey: h1.poolKey, zeroForOne: h1.zeroForOne, amountIn: BUY_AMOUNT });
      console.log(`Hop 1 (ETH→ZORA): ${formatEther(BUY_AMOUNT)} ETH → ${q1.amountOut} ZORA`);
      expect(q1.amountOut).toBeGreaterThan(0n);

      const h2 = makePoolKey(ZORA_TOKEN, KELLEY_COIN, HOP2_PARAMS);
      const q2 = await quoteExactInputSingle({ chainId: CHAIN_ID, client, poolKey: h2.poolKey, zeroForOne: h2.zeroForOne, amountIn: q1.amountOut });
      console.log(`Hop 2 (ZORA→kelley): ${q1.amountOut} → ${q2.amountOut} kelley`);
      expect(q2.amountOut).toBeGreaterThan(0n);

      const h3 = makePoolKey(KELLEY_COIN, TEST_COIN, HOP3_PARAMS);
      const q3 = await quoteExactInputSingle({ chainId: CHAIN_ID, client, poolKey: h3.poolKey, zeroForOne: h3.zeroForOne, amountIn: q2.amountOut });
      hop3Out = q3.amountOut;
      console.log(`Hop 3 (kelley→coin): ${q2.amountOut} → ${q3.amountOut} coin`);
      console.log(`Total: ${formatEther(BUY_AMOUNT)} ETH → ${q3.amountOut} coin`);
      expect(q3.amountOut).toBeGreaterThan(0n);
    },
    { timeout: 30_000 },
  );

  // -----------------------------------------------------------------------
  // Test 2: Execute 3-hop buy via UserOp
  // -----------------------------------------------------------------------
  let coinBalanceAfterBuy: bigint;

  it(
    "executes 3-hop buy: ETH → coin via UserOp",
    async () => {
      const minAmountOut = applySlippage(hop3Out, SLIPPAGE_BPS);
      console.log(`minAmountOut (${SLIPPAGE_BPS}bps): ${minAmountOut}`);

      const encoded = encodeV4ExactInSwap({
        chainId: CHAIN_ID,
        path: [NATIVE_ETH, ZORA_TOKEN, KELLEY_COIN, TEST_COIN],
        amountIn: BUY_AMOUNT,
        minAmountOut,
        poolParamsPerHop: [HOP1_PARAMS, HOP2_PARAMS, HOP3_PARAMS],
      });

      expect(encoded.to).toBe(getRouterAddress(CHAIN_ID));
      expect(encoded.value).toBe(BUY_AMOUNT);

      console.log("Submitting buy UserOp...");
      const userOpHash = await sendUserOperation(bundlerClient, {
        account: smartAccount,
        calls: [{ to: encoded.to, value: encoded.value, data: encoded.data as Hex }],
      });
      console.log(`Buy UserOp: ${userOpHash}`);

      const receipt = await waitForUserOperationReceipt(bundlerClient, {
        hash: userOpHash,
        timeout: 120_000,
      });
      console.log(`Buy tx: ${receipt.receipt.transactionHash} (status: ${receipt.receipt.status})`);

      // Wait for state to settle
      await new Promise((r) => setTimeout(r, 2000));

      coinBalanceAfterBuy = await client.readContract({
        address: TEST_COIN,
        abi: balanceOfAbi,
        functionName: "balanceOf",
        args: [smartAccountAddress],
      });
      console.log(`Coin balance after buy: ${coinBalanceAfterBuy}`);
      expect(coinBalanceAfterBuy).toBeGreaterThan(0n);
    },
    { timeout: 180_000 },
  );

  // -----------------------------------------------------------------------
  // Test 3: Quote 3-hop sell (reverse)
  // -----------------------------------------------------------------------
  let sellFinalOut: bigint;

  it(
    "quotes 3-hop sell: coin → kelleymiller → ZORA → ETH",
    async () => {
      const sellAmount = coinBalanceAfterBuy;
      console.log(`Selling ${sellAmount} coin`);

      const sh1 = makePoolKey(TEST_COIN, KELLEY_COIN, HOP3_PARAMS);
      const sq1 = await quoteExactInputSingle({ chainId: CHAIN_ID, client, poolKey: sh1.poolKey, zeroForOne: sh1.zeroForOne, amountIn: sellAmount });
      console.log(`Sell hop 1 (coin→kelley): ${sq1.amountOut}`);

      const sh2 = makePoolKey(KELLEY_COIN, ZORA_TOKEN, HOP2_PARAMS);
      const sq2 = await quoteExactInputSingle({ chainId: CHAIN_ID, client, poolKey: sh2.poolKey, zeroForOne: sh2.zeroForOne, amountIn: sq1.amountOut });
      console.log(`Sell hop 2 (kelley→ZORA): ${sq2.amountOut}`);

      const sh3 = makePoolKey(ZORA_TOKEN, NATIVE_ETH, HOP1_PARAMS);
      const sq3 = await quoteExactInputSingle({ chainId: CHAIN_ID, client, poolKey: sh3.poolKey, zeroForOne: sh3.zeroForOne, amountIn: sq2.amountOut });
      sellFinalOut = sq3.amountOut;
      console.log(`Sell hop 3 (ZORA→ETH): ${formatEther(sq3.amountOut)} ETH`);
      console.log(`Roundtrip: ${formatEther(BUY_AMOUNT)} ETH in → ${formatEther(sq3.amountOut)} ETH out`);
      expect(sq3.amountOut).toBeGreaterThan(0n);
    },
    { timeout: 30_000 },
  );

  // -----------------------------------------------------------------------
  // Test 4: Execute sell via UserOp (Permit2 approval + V4_SWAP)
  // -----------------------------------------------------------------------
  it(
    "executes 3-hop sell: coin → ETH via UserOp",
    async () => {
      const sellAmount = coinBalanceAfterBuy;
      const routerAddress = getRouterAddress(CHAIN_ID);
      const ethBefore = await client.getBalance({ address: smartAccountAddress });

      // Ensure Permit2 approvals (ERC20→Permit2, Permit2→Router)
      const permit2Calls = await ensurePermit2Approval({
        client,
        token: TEST_COIN,
        owner: smartAccountAddress,
        router: routerAddress,
      });
      console.log(`Permit2 setup calls needed: ${permit2Calls.length}`);

      const minSellOut = applySlippage(sellFinalOut, SLIPPAGE_BPS);
      console.log(`Sell minAmountOut: ${formatEther(minSellOut)} ETH`);

      const sellEncoded = encodeV4ExactInSwap({
        chainId: CHAIN_ID,
        path: [TEST_COIN, KELLEY_COIN, ZORA_TOKEN, NATIVE_ETH],
        amountIn: sellAmount,
        minAmountOut: minSellOut,
        poolParamsPerHop: [HOP3_PARAMS, HOP2_PARAMS, HOP1_PARAMS],
      });

      expect(sellEncoded.value).toBe(0n);

      const calls = [
        ...permit2Calls,
        { to: sellEncoded.to, value: sellEncoded.value, data: sellEncoded.data as Hex },
      ];

      console.log(`Submitting sell UserOp (${calls.length} calls)...`);
      const userOpHash = await sendUserOperation(bundlerClient, {
        account: smartAccount,
        calls,
      });
      console.log(`Sell UserOp: ${userOpHash}`);

      const receipt = await waitForUserOperationReceipt(bundlerClient, {
        hash: userOpHash,
        timeout: 120_000,
      });
      console.log(`Sell tx: ${receipt.receipt.transactionHash} (status: ${receipt.receipt.status})`);

      await new Promise((r) => setTimeout(r, 3000));

      const finalCoinBal = await client.readContract({
        address: TEST_COIN,
        abi: balanceOfAbi,
        functionName: "balanceOf",
        args: [smartAccountAddress],
      });
      const finalEth = await client.getBalance({ address: smartAccountAddress });

      console.log(`Final coin balance: ${finalCoinBal}`);
      console.log(`Final ETH balance: ${formatEther(finalEth)}`);
      console.log(`ETH recovered: ${formatEther(finalEth - ethBefore)}`);

      expect(finalCoinBal).toBe(0n);
      expect(finalEth).toBeGreaterThan(ethBefore);
    },
    { timeout: 180_000 },
  );
});
