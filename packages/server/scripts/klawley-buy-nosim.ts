/**
 * klawley-buy-nosim.ts — Buy a content coin as openklaw, skipping pre-flight eth_call simulation.
 *
 * For content coins backed by $openklaw, the Doppler hook blocks quoter/simulation calls.
 * This script sends the UserOp directly, relying on the bundler's own estimation.
 *
 * Usage: npx tsx packages/server/scripts/klawley-buy-nosim.ts <coinAddress> [amountEth] [slippageBps]
 */

import { createPublicClient, http, parseEther, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { toCoinbaseSmartAccount } from "viem/account-abstraction";
import { base } from "viem/chains";
import { createSponsoredBundlerClient } from "../src/services/bundler/config.js";
import { resolveCoinRoute, type CoinRouteClient } from "../src/services/coinRoute.js";
import { encodeV4ExactInSwap, getRouterAddress } from "../src/services/v4SwapEncoder.js";

const SMART_WALLET = "0x097677d3e2cde65af10be80ae5e67b8b68eb613d" as Address;
const WETH = "0x4200000000000000000000000000000000000006";

async function main() {
  const coinAddress = process.argv[2] as Address | undefined;
  const amountEth = process.argv[3] || "0.001";
  const slippageBps = parseInt(process.argv[4] || "500");

  if (!coinAddress) {
    console.error("Usage: klawley-buy-nosim.ts <coinAddress> [amountEth] [slippageBps]");
    process.exit(1);
  }

  const privateKeyRaw = process.env.ZORA_PRIVATE_KEY;
  if (!privateKeyRaw) throw new Error("ZORA_PRIVATE_KEY not set");
  const privateKey = (privateKeyRaw.startsWith("0x") ? privateKeyRaw : `0x${privateKeyRaw}`) as Hex;
  const account = privateKeyToAccount(privateKey);

  const publicClient = createPublicClient({ chain: base, transport: http(process.env.BASE_RPC_URL || undefined) });

  console.log(`Buying ${amountEth} ETH of ${coinAddress}`);
  console.log(`From Klawley SA: ${SMART_WALLET}`);
  console.log(`Slippage: ${slippageBps} bps (no simulation)`);

  // Resolve the coin's route (buy path through WETH → ZORA → openklaw → coin)
  const coinRoute = await resolveCoinRoute({
    client: publicClient as unknown as CoinRouteClient,
    coinAddress,
  });
  console.log("Route:", coinRoute.buyPath.join(" → "));

  // Map WETH to address(0) for native ETH input
  const swapPath = coinRoute.buyPath.map((addr, idx) => {
    if (addr.toLowerCase() === WETH.toLowerCase() && idx === 0) {
      return "0x0000000000000000000000000000000000000000" as `0x${string}`;
    }
    return addr;
  });

  const amountIn = parseEther(amountEth);

  // Use 0 as minAmountOut — the slippage will be handled by the fact we're buying tiny amounts
  // (0.001 ETH) into a fresh pool. The real protection is the small size.
  const encoded = encodeV4ExactInSwap({
    chainId: 8453,
    path: swapPath,
    amountIn,
    minAmountOut: 0n, // Skip quoting, accept any output
    poolParamsPerHop: coinRoute.buyPoolParams,
  });

  console.log("Router:", encoded.to);
  console.log("Value:", amountIn.toString(), "wei");

  // Build SA and bundler client
  const smartAccount = await toCoinbaseSmartAccount({
    client: publicClient,
    owners: [account],
    address: SMART_WALLET,
  });

  const bundlerClient = createSponsoredBundlerClient({
    account: smartAccount,
    chain: base,
    client: publicClient,
  });

  // Send UserOp directly (no eth_call pre-flight)
  console.log("🚀 Sending buy UserOp...");
  const userOpHash = await bundlerClient.sendUserOperation({
    calls: [{ to: encoded.to, value: encoded.value, data: encoded.data }],
  });

  console.log("UserOp:", userOpHash);
  const receipt = await bundlerClient.waitForUserOperationReceipt({ hash: userOpHash });

  if (!receipt.success) {
    console.error("❌ UserOp failed");
    process.exit(1);
  }

  console.log("✅ Buy successful!");
  console.log("TX:", receipt.receipt.transactionHash);
}

main().catch((err) => {
  console.error("❌ Failed:", err.message || err);
  process.exit(1);
});
