import { createPublicClient, createWalletClient, http, parseEther, formatEther } from "viem";
import { base } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import { tradeCoin } from "@zoralabs/coins-sdk";

async function main() {
  const coinAddress = process.argv[2];
  const amountEth = process.argv[3] || "0.005";

  if (!coinAddress) {
    console.error("Usage: zora-buy.ts <coinAddress> [amountEth]");
    process.exit(1);
  }

  const rawKey = process.env.ZORA_PRIVATE_KEY!;
  const account = privateKeyToAccount((rawKey.startsWith("0x") ? rawKey : `0x${rawKey}`) as `0x${string}`);
  const publicClient = createPublicClient({ chain: base, transport: http() });
  const walletClient = createWalletClient({ chain: base, transport: http(), account });

  console.log(`Buying ${amountEth} ETH of ${coinAddress}`);
  console.log(`From EOA: ${account.address}`);

  const balance = await publicClient.getBalance({ address: account.address });
  console.log(`EOA balance: ${formatEther(balance)} ETH`);

  if (balance < parseEther(amountEth)) {
    console.error(`Insufficient balance: ${formatEther(balance)} < ${amountEth}`);
    process.exit(1);
  }

  const result = await tradeCoin({
    tradeParameters: {
      direction: "buy",
      coin: coinAddress as `0x${string}`,
      quantity: {
        type: "eth",
      },
      amount: parseEther(amountEth),
    },
    walletClient,
    account,
    publicClient,
  });

  console.log("Buy submitted!");
  console.log("Tx hash:", result.hash);

  const receipt = await publicClient.waitForTransactionReceipt({ hash: result.hash });
  console.log("Status:", receipt.status);
}

main();
