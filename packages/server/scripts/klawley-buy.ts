import { parseEther, formatEther } from "viem";
import { swapFromSmartAccount, KLAWLEY_ACCOUNT_NAME, KLAWLEY_SMART_WALLET } from "../src/services/cdp.js";

const WETH_BASE = "0x4200000000000000000000000000000000000006" as const;

async function main() {
  const coinAddress = process.argv[2] as `0x${string}` | undefined;
  const amountEth = process.argv[3] || "0.005";
  const slippage = parseInt(process.argv[4] || "300");

  if (!coinAddress) {
    console.error("Usage: klawley-buy.ts <coinAddress> [amountEth] [slippageBps]");
    process.exit(1);
  }

  console.log(`Buying ${amountEth} ETH of ${coinAddress}`);
  console.log(`From Klawley SA: ${KLAWLEY_SMART_WALLET}`);
  console.log(`Slippage: ${slippage} bps`);

  const result = await swapFromSmartAccount({
    smartAccountName: KLAWLEY_ACCOUNT_NAME,
    fromToken: WETH_BASE,
    toToken: coinAddress,
    fromAmount: parseEther(amountEth),
    slippageBps: slippage,
  });

  console.log(`\nUserOp: ${result.userOpHash}`);
  console.log(`Tx: ${result.txHash} (status: ${result.status})`);
  if (result.amountOut) console.log(`Amount out: ${result.amountOut}`);
}

main().catch((err) => {
  console.error("Error:", err.message || err);
  process.exit(1);
});
