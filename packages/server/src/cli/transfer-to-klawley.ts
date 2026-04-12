/**
 * Transfer ETH from master fleet wallet to Klawley's smart wallet.
 * Usage: doppler run --project openclaw --config prd -- bun x tsx src/cli/transfer-to-klawley.ts <amount_eth>
 */
import { transferFromSmartAccount } from "../services/cdp.js";
import { getEthBalance } from "../services/balance.js";
import { logger } from "../logger.js";
import { parseEther, formatEther } from "viem";

const KLAWLEY_WALLET = "0x097677d3e2cde65af10be80ae5e67b8b68eb613d" as const;

async function main() {
  const amountEth = process.argv[2];
  if (!amountEth) {
    console.error("Usage: transfer-to-klawley.ts <amount_eth>");
    console.error("Example: transfer-to-klawley.ts 0.05");
    process.exit(1);
  }

  const amountWei = parseEther(amountEth);
  logger.warn({ to: KLAWLEY_WALLET, amountEth, amountWei: amountWei.toString() }, "PRODUCTION TRANSFER");
  logger.info("From: master smart wallet");
  logger.info({ to: KLAWLEY_WALLET }, "To: Klawley smart wallet");
  logger.info({ amountEth, amountWei: amountWei.toString() }, "Transfer amount");

  // Check master balance first
  // Real master SA from DB (prd config)
  const masterBalance = await getEthBalance("0x351D0427376889f09D171DDfBa3Bf9C50705798D" as `0x${string}`);
  logger.info({ masterBalanceEth: formatEther(masterBalance) }, "Master balance");

  if (masterBalance < amountWei) {
    console.error(`❌ Insufficient balance. Master has ${formatEther(masterBalance)} ETH, need ${amountEth} ETH`);
    process.exit(1);
  }

  logger.info("Submitting transfer");
  const result = await transferFromSmartAccount({
    smartAccountName: "master",
    to: KLAWLEY_WALLET,
    amountWei,
  });

  logger.info({ userOpHash: result.userOpHash, txHash: result.txHash, status: result.status }, "Transfer complete");

  // Check new balance
  const klawleyBalance = await getEthBalance(KLAWLEY_WALLET);
  logger.info({ klawleyBalanceEth: formatEther(klawleyBalance) }, "Klawley balance");
}

main().catch((err) => {
  console.error("Transfer failed:", err);
  process.exit(1);
});
