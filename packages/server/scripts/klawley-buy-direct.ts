/**
 * Direct buy via Zora SDK tradeCoin() — uses walletClient directly (not UserOp).
 * This bypasses the paymaster entirely since the SA has ETH.
 */

import { createPublicClient, createWalletClient, http, parseEther, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { toCoinbaseSmartAccount } from "viem/account-abstraction";
import { base } from "viem/chains";
import { setApiKey, tradeCoin } from "@zoralabs/coins-sdk";

const SMART_WALLET = "0x097677d3e2cde65af10be80ae5e67b8b68eb613d" as Address;
const WETH = "0x4200000000000000000000000000000000000006" as Address;

async function main() {
  const coinAddress = process.argv[2] as Address | undefined;
  const amountEth = process.argv[3] || "0.001";

  if (!coinAddress) {
    console.error("Usage: klawley-buy-direct.ts <coinAddress> [amountEth]");
    process.exit(1);
  }

  const privateKeyRaw = process.env.ZORA_PRIVATE_KEY;
  if (!privateKeyRaw) throw new Error("ZORA_PRIVATE_KEY not set");
  if (!process.env.ZORA_API_KEY) throw new Error("ZORA_API_KEY not set");

  setApiKey(process.env.ZORA_API_KEY);

  const privateKey = (privateKeyRaw.startsWith("0x") ? privateKeyRaw : `0x${privateKeyRaw}`) as Hex;
  const eoaAccount = privateKeyToAccount(privateKey);

  const publicClient = createPublicClient({ chain: base, transport: http(process.env.BASE_RPC_URL || undefined) });

  console.log(`Buying ${amountEth} ETH of ${coinAddress}`);
  console.log(`From Klawley SA: ${SMART_WALLET}`);

  // Build smart account
  const smartAccount = await toCoinbaseSmartAccount({
    client: publicClient,
    owners: [eoaAccount],
    address: SMART_WALLET,
  });

  // Create a wallet client that uses the smart account
  const walletClient = createWalletClient({
    account: smartAccount as any,
    chain: base,
    transport: http(process.env.BASE_RPC_URL || undefined),
  });

  console.log("🚀 Buying via Zora SDK tradeCoin()...");

  const result = await tradeCoin({
    tradeParameters: {
      sell: WETH,
      buy: coinAddress,
      amountIn: parseEther(amountEth),
      sender: SMART_WALLET,
      recipient: SMART_WALLET,
      slippage: 0.05,
    },
    walletClient: walletClient as any,
    publicClient: publicClient as any,
  });

  console.log("✅ Buy result:", result);
}

main().catch((err) => {
  console.error("❌ Failed:", err.message || err);
  process.exit(1);
});
