/**
 * Buy a coin using Zora's trade API for the exact calldata.
 * Bypasses local quoter/simulation issues with Doppler hooks.
 */

import { createPublicClient, http, parseEther, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { toCoinbaseSmartAccount } from "viem/account-abstraction";
import { base } from "viem/chains";
import { createSponsoredBundlerClient } from "../src/services/bundler/config.js";

const SMART_WALLET = "0x097677d3e2cde65af10be80ae5e67b8b68eb613d" as Address;

async function main() {
  const coinAddress = process.argv[2] as Address | undefined;
  const amountEth = process.argv[3] || "0.001";

  if (!coinAddress) {
    console.error("Usage: klawley-buy-zora-api.ts <coinAddress> [amountEth]");
    process.exit(1);
  }

  const privateKeyRaw = process.env.ZORA_PRIVATE_KEY;
  if (!privateKeyRaw) throw new Error("ZORA_PRIVATE_KEY not set");
  if (!process.env.ZORA_API_KEY) throw new Error("ZORA_API_KEY not set");

  const privateKey = (privateKeyRaw.startsWith("0x") ? privateKeyRaw : `0x${privateKeyRaw}`) as Hex;
  const account = privateKeyToAccount(privateKey);

  console.log(`Buying ${amountEth} ETH of ${coinAddress}`);
  console.log(`From Klawley SA: ${SMART_WALLET}`);

  // Use Zora SDK's createTradeCall via the /quote endpoint
  const { createTradeCall } = await import("@zoralabs/coins-sdk");

  const WETH = "0x4200000000000000000000000000000000000006" as Address;
  const quote = await createTradeCall({
    sell: WETH,
    buy: coinAddress,
    amountIn: parseEther(amountEth),
    sender: SMART_WALLET,
    recipient: SMART_WALLET,
    slippage: 0.05, // 5%
  });

  console.log("Quote received:");
  console.log("  Calls:", quote.calls?.length || 0);

  const trade = quote as {
    calls: Array<{ to: string; data: string; value: string }>;
  };

  if (!trade.calls?.length) {
    console.error("No calls returned from trade API");
    process.exit(1);
  }

  console.log(`Trade API returned ${trade.calls.length} call(s)`);
  const call = trade.calls[0]!;
  console.log(`  to: ${call.to}`);
  console.log(`  value: ${call.value}`);

  // Build SA and bundler
  const publicClient = createPublicClient({ chain: base, transport: http(process.env.BASE_RPC_URL || undefined) });
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

  // Send all calls from the trade API
  const calls = trade.calls.map(c => ({
    to: c.to as Address,
    data: c.data as Hex,
    value: BigInt(c.value || "0"),
  }));

  console.log("🚀 Sending buy UserOp...");
  const userOpHash = await bundlerClient.sendUserOperation({ calls });
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
