import { db } from "../src/db/index.js";
import { quoteCoinToEth } from "../src/services/quoter.js";

const coin = process.argv[2] as `0x${string}`;
if (!coin) { console.log("Usage: position-detail.ts <coinAddress>"); process.exit(1); }

const positions = db.listAllPositions().filter(
  (p) => p.coinAddress.toLowerCase() === coin.toLowerCase() && BigInt(p.holdingsRaw) > 0n
);

let totalHoldings = 0n;
let totalCost = 0n;

console.log(`Wallet positions for ${coin}:\n`);
for (const p of positions) {
  const h = BigInt(p.holdingsRaw);
  const c = BigInt(p.totalCostWei);
  totalHoldings += h;
  totalCost += c;
  console.log(`  wallet #${p.walletId} | holdings: ${(Number(h) / 1e18).toExponential(4)} tokens | cost: ${(Number(c) / 1e18).toFixed(6)} ETH`);
}

console.log(`\nTotal: ${positions.length} wallets`);
console.log(`Total holdings: ${(Number(totalHoldings) / 1e18).toExponential(4)} tokens`);
console.log(`Total cost: ${(Number(totalCost) / 1e18).toFixed(6)} ETH`);

// Quote in smaller chunks to avoid overflow
console.log(`\nQuoting value...`);
try {
  const value = await quoteCoinToEth({ coinAddress: coin, amount: totalHoldings });
  console.log(`Quoted value: ${(Number(value) / 1e18).toFixed(6)} ETH`);
  const pnl = Number(value) / 1e18 - Number(totalCost) / 1e18;
  console.log(`PnL: ${pnl >= 0 ? "+" : ""}${pnl.toFixed(6)} ETH`);
} catch (e: any) {
  console.log(`Quote failed: ${e.message}`);
  
  // Try quoting per-wallet to see if any individual quotes work
  console.log(`\nTrying per-wallet quotes...`);
  let totalValue = 0n;
  let quotedCount = 0;
  for (const p of positions) {
    const h = BigInt(p.holdingsRaw);
    try {
      const v = await quoteCoinToEth({ coinAddress: coin, amount: h });
      totalValue += v;
      quotedCount++;
    } catch (e2: any) {
      console.log(`  wallet #${p.walletId}: quote failed (${e2.message?.slice(0, 60)})`);
    }
  }
  if (quotedCount > 0) {
    console.log(`\nPer-wallet quoted value: ${(Number(totalValue) / 1e18).toFixed(6)} ETH (${quotedCount}/${positions.length} wallets)`);
  }
}
