#!/usr/bin/env tsx
import { parseEther, formatEther } from "viem";
import { getFleetByName } from "../services/fleet.js";
import { transferFromSmartAccount, getOrCreateMasterSmartAccount } from "../services/cdp.js";

async function main() {
  const fleet = getFleetByName("gamma");
  if (!fleet) throw new Error("Fleet gamma not found");

  const { smartAccount: master } = await getOrCreateMasterSmartAccount();
  const masterName = master.name ?? "master";
  console.log(`Master: ${masterName} (${master.address})`);
  const perWallet = parseEther("0.05") / BigInt(fleet.wallets.length); // 0.002 ETH each
  console.log(`Funding ${fleet.wallets.length} wallets with ${formatEther(perWallet)} ETH each`);
  console.log(`Total: ${formatEther(perWallet * BigInt(fleet.wallets.length))} ETH\n`);

  for (const wallet of fleet.wallets) {
    process.stdout.write(`  ${wallet.name} (${wallet.address})... `);
    const result = await transferFromSmartAccount({
      smartAccountName: masterName,
      to: wallet.address,
      amountWei: perWallet,
    });
    console.log(`✅ ${formatEther(perWallet)} ETH — tx: ${result.txHash?.slice(0, 14)}...`);
  }
  console.log("\nDone!");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
