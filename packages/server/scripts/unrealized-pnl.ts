import { db } from "../src/db/index.js";
import { quoteCoinToEth } from "../src/services/quoter.js";

const positions = db.listAllPositions();
const byCoin: Record<string, { holdings: bigint; costWei: bigint; wallets: number }> = {};

for (const p of positions) {
  const h = BigInt(p.holdingsRaw);
  if (h <= 0n) continue;
  if (!byCoin[p.coinAddress]) byCoin[p.coinAddress] = { holdings: 0n, costWei: 0n, wallets: 0 };
  byCoin[p.coinAddress].holdings += h;
  byCoin[p.coinAddress].costWei += BigInt(p.totalCostWei);
  byCoin[p.coinAddress].wallets++;
}

let totalCost = 0;
let totalValue = 0;

for (const [coin, data] of Object.entries(byCoin)) {
  const costEth = Number(data.costWei) / 1e18;
  try {
    const ethValue = await quoteCoinToEth({ coinAddress: coin as `0x${string}`, amount: data.holdings });
    const valueEth = Number(ethValue) / 1e18;
    const pnl = valueEth - costEth;
    const pnlPct = costEth > 0 ? (pnl / costEth * 100) : 0;
    totalCost += costEth;
    totalValue += valueEth;
    console.log(`${coin.slice(0, 10)}… | ${data.wallets} wallets | cost: ${costEth.toFixed(6)} ETH | value: ${valueEth.toFixed(6)} ETH | PnL: ${pnl >= 0 ? "+" : ""}${pnl.toFixed(6)} ETH (${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(1)}%)`);
  } catch (e: any) {
    totalCost += costEth;
    console.log(`${coin.slice(0, 10)}… | ${data.wallets} wallets | cost: ${costEth.toFixed(6)} ETH | ⚠️  quote failed: ${e.message?.slice(0, 60)}`);
  }
}

const totalPnl = totalValue - totalCost;
const totalPnlPct = totalCost > 0 ? (totalPnl / totalCost * 100) : 0;
console.log(`\n--- TOTAL ---`);
console.log(`Cost:  ${totalCost.toFixed(6)} ETH`);
console.log(`Value: ${totalValue.toFixed(6)} ETH`);
console.log(`PnL:   ${totalPnl >= 0 ? "+" : ""}${totalPnl.toFixed(6)} ETH (${totalPnlPct >= 0 ? "+" : ""}${totalPnlPct.toFixed(1)}%)`);
