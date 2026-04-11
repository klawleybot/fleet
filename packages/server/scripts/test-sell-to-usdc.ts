/**
 * Test script: sell a coin → ETH → USDC
 *
 * Usage:
 *   tsx scripts/test-sell-to-usdc.ts <coinAddress> [amountTokens] [slippageBps]
 *
 * Example:
 *   SELL_DESTINATION_TOKEN=0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913 \
 *   tsx scripts/test-sell-to-usdc.ts 0x1111111111166b7fe7bd91427724b487980afc69 100 500
 *
 * What this does:
 *   1. Reads before-USDC balance
 *   2. Quotes coin → WETH (V4) then WETH → USDC (V3)
 *   3. Sells via swapFromSmartAccount (which appends the V3 leg when SELL_DESTINATION_TOKEN=USDC)
 *   4. Reads after-USDC balance
 */

import { createPublicClient, formatUnits, http, parseUnits, type Address } from "viem";
import { base } from "viem/chains";
import { swapFromSmartAccount, KLAWLEY_ACCOUNT_NAME, KLAWLEY_SMART_WALLET } from "../src/services/cdp.js";
import { resolveCoinRoute, type CoinRouteClient } from "../src/services/coinRoute.js";
import { quoteMultiHop } from "../src/services/quoter.js";
import { quoteV3ExactInput } from "../src/services/quoter.js";
import { applySlippage } from "../src/services/v4Quoter.js";
import { getChainConfig } from "../src/services/network.js";

const WETH_BASE = "0x4200000000000000000000000000000000000006" as Address;
const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as Address;

const erc20Abi = [
  {
    name: "balanceOf",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    name: "decimals",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint8" }],
  },
] as const;

async function main() {
  const coinAddress = process.argv[2] as Address | undefined;
  const amountStr = process.argv[3] || "100";
  const slippageBps = parseInt(process.argv[4] || "500");

  if (!coinAddress) {
    console.error("Usage: test-sell-to-usdc.ts <coinAddress> [amountTokens] [slippageBps]");
    console.error(
      "  Set SELL_DESTINATION_TOKEN=0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913 to enable USDC conversion",
    );
    process.exit(1);
  }

  const cfg = getChainConfig();
  const client = createPublicClient({ chain: base, transport: http(cfg.rpcUrl) });

  // Get coin decimals
  let coinDecimals = 18;
  try {
    coinDecimals = await client.readContract({
      address: coinAddress,
      abi: erc20Abi,
      functionName: "decimals",
    });
  } catch {
    console.log("Could not read decimals, assuming 18");
  }

  const fromAmount = parseUnits(amountStr, coinDecimals);
  const sellDestToken = (process.env.SELL_DESTINATION_TOKEN?.trim() || WETH_BASE).toLowerCase();
  const isUsdcMode = sellDestToken === USDC_BASE.toLowerCase();

  console.log("=== Sell to USDC Test ===");
  console.log(`Coin:        ${coinAddress}`);
  console.log(`Amount:      ${amountStr} tokens (${coinDecimals} decimals)`);
  console.log(`Slippage:    ${slippageBps} bps`);
  console.log(`SA:          ${KLAWLEY_SMART_WALLET}`);
  console.log(`Dest token:  ${isUsdcMode ? "USDC" : "WETH"} (SELL_DESTINATION_TOKEN=${process.env.SELL_DESTINATION_TOKEN || "unset"})`);
  console.log();

  // --- Read before balance ---
  const usdcBefore = await client.readContract({
    address: USDC_BASE,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [KLAWLEY_SMART_WALLET],
  });
  console.log(`USDC before: ${formatUnits(usdcBefore, 6)} USDC`);

  // --- Quote coin → WETH (V4) ---
  console.log("\nQuoting coin → WETH (V4)...");
  const route = await resolveCoinRoute({
    client: client as unknown as CoinRouteClient,
    coinAddress,
  });
  const wethOut = await quoteMultiHop(
    client,
    cfg.chainId,
    route.sellPath,
    route.sellPoolParams,
    fromAmount,
  );
  const wethOutMin = applySlippage(wethOut, slippageBps);
  console.log(`  Quoted WETH out: ${formatUnits(wethOut, 18)} WETH`);
  console.log(`  Min WETH (slippage): ${formatUnits(wethOutMin, 18)} WETH`);

  // --- Quote WETH → USDC (V3) ---
  if (isUsdcMode) {
    console.log("\nQuoting WETH → USDC (V3)...");
    try {
      const v3Quote = await quoteV3ExactInput({
        chainId: cfg.chainId,
        client,
        tokenIn: WETH_BASE,
        tokenOut: USDC_BASE,
        fee: 500,
        amountIn: wethOutMin, // use slippage-adjusted WETH as input
      });
      const usdcOutMin = applySlippage(v3Quote.amountOut, slippageBps);
      console.log(`  Quoted USDC out: ${formatUnits(v3Quote.amountOut, 6)} USDC`);
      console.log(`  Min USDC (slippage): ${formatUnits(usdcOutMin, 6)} USDC`);
      console.log(
        `  Effective rate: 1 WETH ≈ ${(Number(v3Quote.amountOut) / Number(wethOutMin) * 1e18 / 1e6).toFixed(2)} USDC`,
      );
    } catch (err) {
      console.warn(`  V3 quote failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // --- Execute sell ---
  console.log("\nExecuting sell...");
  const result = await swapFromSmartAccount({
    smartAccountName: KLAWLEY_ACCOUNT_NAME,
    fromToken: coinAddress,
    toToken: WETH_BASE, // V4 always routes to WETH; V3 WETH→USDC appended inside cdp.ts
    fromAmount,
    slippageBps,
  });

  console.log(`\nUserOp:  ${result.userOpHash}`);
  console.log(`Tx:      ${result.txHash}`);
  console.log(`Status:  ${result.status}`);
  if (result.amountOut) {
    console.log(`V4 amountOut (WETH): ${formatUnits(BigInt(result.amountOut), 18)} WETH`);
  }

  // --- Read after balance ---
  const usdcAfter = await client.readContract({
    address: USDC_BASE,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [KLAWLEY_SMART_WALLET],
  });
  const usdcReceived = usdcAfter - usdcBefore;
  console.log(`\nUSDC before: ${formatUnits(usdcBefore, 6)} USDC`);
  console.log(`USDC after:  ${formatUnits(usdcAfter, 6)} USDC`);
  console.log(`USDC gained: ${formatUnits(usdcReceived >= 0n ? usdcReceived : 0n, 6)} USDC`);
}

main().catch((err) => {
  console.error("Error:", err instanceof Error ? err.message : err);
  process.exit(1);
});
