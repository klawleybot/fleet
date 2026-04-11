/**
 * Buy a coin using Zora SDK tradeCoin (handles multi-hop routing via Zora quote API)
 */
import { createTradeCall } from "@zoralabs/coins-sdk";
import { createPublicClient, http, parseEther, type Hex, type Address, zeroAddress } from "viem";
import { base } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import { toCoinbaseSmartAccount } from "viem/account-abstraction";
import { createSponsoredBundlerClient } from "../src/services/bundler/config.js";

const SMART_WALLET = "0x097677d3e2cde65af10be80ae5e67b8b68eb613d" as Address;
const ETH_ADDRESS = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE" as Address;

async function main() {
  const coinAddress = process.argv[2] as Address;
  const amountEth = process.argv[3] || "0.002";
  
  if (!coinAddress) { console.error("Usage: klawley-buy-sdk.ts <coinAddress> [amountEth]"); process.exit(1); }

  const privateKeyRaw = process.env.ZORA_PRIVATE_KEY!;
  const privateKey = (privateKeyRaw.startsWith("0x") ? privateKeyRaw : `0x${privateKeyRaw}`) as Hex;
  const account = privateKeyToAccount(privateKey);
  
  const publicClient = createPublicClient({ chain: base, transport: http(process.env.BASE_RPC_URL || undefined) });
  const smartAccount = await toCoinbaseSmartAccount({ client: publicClient, owners: [account], address: SMART_WALLET });
  const bundlerClient = createSponsoredBundlerClient({ account: smartAccount, chain: base, client: publicClient });

  const value = parseEther(amountEth);
  console.log(`Buying ${amountEth} ETH of ${coinAddress} from SA ${SMART_WALLET}`);

  // Use Zora SDK createTradeCall — it posts to Zora quote API for proper routing
  const quote = await createTradeCall({
    sell: ETH_ADDRESS,
    buy: coinAddress,
    amountIn: value,
    sender: SMART_WALLET,
    recipient: SMART_WALLET,
    slippage: 0.05,  // 5%
  });

  console.log("Quote:", JSON.stringify({
    to: quote.to,
    value: quote.value?.toString(),
    dataLen: quote.data?.length,
  }, null, 2));

  const userOpHash = await bundlerClient.sendUserOperation({
    calls: [{ to: quote.to as Address, data: quote.data as Hex, value: BigInt(quote.value || 0) }],
  });

  console.log("UserOp:", userOpHash);
  const receipt = await bundlerClient.waitForUserOperationReceipt({ hash: userOpHash });
  console.log("TX:", receipt.receipt.transactionHash);
  console.log("Status:", receipt.success ? "✅ SUCCESS" : "❌ FAILED");
}

main().catch(e => { console.error("Error:", e.message || e); process.exit(1); });
