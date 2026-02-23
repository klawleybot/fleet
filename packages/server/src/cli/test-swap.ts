#!/usr/bin/env tsx
import { db } from "../db/index.js";
import { swapFromSmartAccount } from "../services/cdp.js";

async function main() {
  const wallet = db.getWalletById(217);
  if (!wallet) throw new Error("Wallet 217 not found");
  console.log(`Testing swap from ${wallet.name} (${wallet.address}) SA=${wallet.cdpAccountName}`);

  const WETH = "0x4200000000000000000000000000000000000006" as const;
  const coin = "0x7eadfee40750930d03fe454d81032effd8869371" as const;

  console.log("Swapping 0.0003 ETH...");
  const result = await swapFromSmartAccount({
    smartAccountName: wallet.cdpAccountName,
    fromToken: WETH,
    toToken: coin,
    fromAmount: 300000000000000n,
    slippageBps: 500,
  });
  console.log("Result:", JSON.stringify(result, null, 2));
}

main().catch((e) => { console.error(e); process.exit(1); });
