#!/usr/bin/env tsx
import { logger } from "../logger.js";
import { db } from "../db/index.js";
import { swapFromSmartAccount } from "../services/cdp.js";

async function main() {
  const wallet = db.getWalletById(217);
  if (!wallet) throw new Error("Wallet 217 not found");
  logger.info(
    { walletName: wallet.name, walletAddress: wallet.address, smartAccountName: wallet.cdpAccountName },
    "Testing swap",
  );

  const WETH = "0x4200000000000000000000000000000000000006" as const;
  const coin = "0x7eadfee40750930d03fe454d81032effd8869371" as const;

  logger.info("Swapping 0.0003 ETH");
  const result = await swapFromSmartAccount({
    smartAccountName: wallet.cdpAccountName,
    fromToken: WETH,
    toToken: coin,
    fromAmount: 300000000000000n,
    slippageBps: 500,
  });
  logger.info({ result }, "Swap result");
}

main().catch((error: unknown) => {
  logger.error({ err: error }, "test swap failed");
  process.exit(1);
});
