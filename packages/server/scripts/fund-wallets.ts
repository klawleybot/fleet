import { distributeFunding } from "../src/services/funding.js";
import { db } from "../src/db/index.js";

const amountWei = BigInt(process.env.FUND_AMOUNT_WEI ?? "3000000000000000");
const names = process.argv.slice(2);
if (!names.length) {
  console.error("Usage: fund-wallets.ts <wallet-name> [wallet-name...]");
  process.exit(1);
}

const walletIds: number[] = [];
for (const name of names) {
  const wallet = db.listWallets().find(w => w.name === name);
  if (!wallet) {
    console.log(`${name}: not found, skipping`);
    continue;
  }
  walletIds.push(wallet.id);
}

console.log(`Funding ${walletIds.length} wallets with ${Number(amountWei) / 1e18} ETH each...`);
const results = await distributeFunding({
  toWalletIds: walletIds,
  amountWei,
});

for (const r of results) {
  console.log(`wallet #${r.toWalletId}: ${r.status} (tx: ${r.txHash?.slice(0, 14) ?? "n/a"}...)`);
}
console.log(`Done: ${results.filter(r => r.status === "complete").length}/${results.length} funded`);
