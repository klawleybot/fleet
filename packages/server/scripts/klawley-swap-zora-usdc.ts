import { parseUnits, formatUnits } from "viem";
import { swapFromSmartAccount, KLAWLEY_ACCOUNT_NAME, KLAWLEY_SMART_WALLET } from "../src/services/cdp.js";

const ZORA_TOKEN = "0x1111111111166b7fe7bd91427724b487980afc69" as const;
const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as const;

async function main() {
  const amount = process.argv[2] || "500";
  const slippage = parseInt(process.argv[3] || "500"); // 5% slippage default

  console.log(`Swapping ${amount} ZORA → USDC`);
  console.log(`From Klawley SA: ${KLAWLEY_SMART_WALLET}`);
  console.log(`Slippage: ${slippage} bps`);

  const result = await swapFromSmartAccount({
    smartAccountName: KLAWLEY_ACCOUNT_NAME,
    fromToken: ZORA_TOKEN,
    toToken: USDC_BASE,
    fromAmount: parseUnits(amount, 18),
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
