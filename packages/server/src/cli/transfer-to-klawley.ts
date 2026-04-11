/**
 * Transfer ETH from master fleet wallet to Klawley's smart wallet.
 * Usage: doppler run --project openclaw --config prd -- npx tsx src/cli/transfer-to-klawley.ts <amount_eth>
 */
import { transferFromSmartAccount } from "../services/cdp.js";
import { getEthBalance } from "../services/balance.js";
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
  console.log(`⚠️  PRODUCTION TRANSFER`);
  console.log(`From: master smart wallet`);
  console.log(`To: Klawley smart wallet (${KLAWLEY_WALLET})`);
  console.log(`Amount: ${amountEth} ETH (${amountWei} wei)`);

  // Check master balance first
  // Real master SA from DB (prd config)
  const masterBalance = await getEthBalance("0x351D0427376889f09D171DDfBa3Bf9C50705798D" as `0x${string}`);
  console.log(`Master balance: ${formatEther(masterBalance)} ETH`);

  if (masterBalance < amountWei) {
    console.error(`❌ Insufficient balance. Master has ${formatEther(masterBalance)} ETH, need ${amountEth} ETH`);
    process.exit(1);
  }

  console.log(`\nSubmitting transfer...`);
  const result = await transferFromSmartAccount({
    smartAccountName: "master",
    to: KLAWLEY_WALLET,
    amountWei,
  });

  console.log(`\n✅ Transfer complete!`);
  console.log(`UserOp: ${result.userOpHash}`);
  console.log(`Tx: ${result.txHash}`);
  console.log(`Status: ${result.status}`);

  // Check new balance
  const klawleyBalance = await getEthBalance(KLAWLEY_WALLET);
  console.log(`\nKlawley balance: ${formatEther(klawleyBalance)} ETH`);
}

main().catch((err) => {
  console.error("Transfer failed:", err);
  process.exit(1);
});
