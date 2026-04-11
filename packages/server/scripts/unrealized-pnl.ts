import { db } from "../src/db/index.js";
import { quoteCoinToEth } from "../src/services/quoter.js";
import { getWalletBudgets } from "../src/services/balance.js";

// Gather positions by coin, tracking which wallet IDs are involved
const positions = db.listAllPositions();
const byCoin: Record<string, { holdings: bigint; grossCostWei: bigint; receivedWei: bigint; walletIds: Set<number> }> = {};

for (const p of positions) {
  const h = BigInt(p.holdingsRaw);
  if (h <= 0n) continue;
  if (!byCoin[p.coinAddress]) byCoin[p.coinAddress] = { holdings: 0n, grossCostWei: 0n, receivedWei: 0n, walletIds: new Set() };
  byCoin[p.coinAddress].holdings += h;
  byCoin[p.coinAddress].grossCostWei += BigInt(p.totalCostWei);
  byCoin[p.coinAddress].receivedWei += BigInt(p.totalReceivedWei);
  byCoin[p.coinAddress].walletIds.add(p.walletId);
}

// Collect all wallet IDs with positions to fetch their ETH balances
const allWalletIds = new Set<number>();
for (const data of Object.values(byCoin)) {
  for (const id of data.walletIds) allWalletIds.add(id);
}

// Fetch on-chain ETH balances for all position wallets
const walletRows = [...allWalletIds].map((id) => {
  const w = db.getWalletById(id);
  if (!w) return null;
  return { id: w.id, address: w.address as `0x${string}` };
}).filter((w): w is { id: number; address: `0x${string}` } => w !== null);

const budgets = walletRows.length > 0 ? await getWalletBudgets(walletRows) : { wallets: [], totalBudget: 0n, fundedCount: 0 };
const balanceByWalletId = new Map<number, bigint>();
for (const w of budgets.wallets) {
  balanceByWalletId.set(w.walletId, w.balance);
}

let totalGrossCost = 0;
let totalReceived = 0;
let totalTokenValue = 0;
let totalWalletEth = 0;

for (const [coin, data] of Object.entries(byCoin)) {
  const grossCostEth = Number(data.grossCostWei) / 1e18;
  const receivedEth = Number(data.receivedWei) / 1e18;
  const netCostEth = grossCostEth - receivedEth;  // actual capital at risk

  // Sum ETH sitting in these wallets (unsold ETH from partial sells, etc.)
  let walletEthWei = 0n;
  for (const wid of data.walletIds) {
    walletEthWei += balanceByWalletId.get(wid) ?? 0n;
  }
  const walletEth = Number(walletEthWei) / 1e18;

  try {
    const ethValue = await quoteCoinToEth({ coinAddress: coin as `0x${string}`, amount: data.holdings });
    const tokenValueEth = Number(ethValue) / 1e18;
    const totalValueEth = tokenValueEth + walletEth;
    const pnl = totalValueEth - netCostEth;
    const pnlPct = netCostEth > 0 ? (pnl / netCostEth * 100) : 0;
    totalGrossCost += grossCostEth;
    totalReceived += receivedEth;
    totalTokenValue += tokenValueEth;
    totalWalletEth += walletEth;
    console.log(`${coin.slice(0, 10)}… | ${data.walletIds.size} wallets | net cost: ${netCostEth.toFixed(6)} ETH (${grossCostEth.toFixed(6)} in - ${receivedEth.toFixed(6)} sold) | tokens: ${tokenValueEth.toFixed(6)} ETH | wallet: ${walletEth.toFixed(6)} ETH | PnL: ${pnl >= 0 ? "+" : ""}${pnl.toFixed(6)} ETH (${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(1)}%)`);
  } catch (e: any) {
    totalGrossCost += grossCostEth;
    totalReceived += receivedEth;
    totalWalletEth += walletEth;
    console.log(`${coin.slice(0, 10)}… | ${data.walletIds.size} wallets | net cost: ${netCostEth.toFixed(6)} ETH (${grossCostEth.toFixed(6)} in - ${receivedEth.toFixed(6)} sold) | wallet: ${walletEth.toFixed(6)} ETH | ⚠️  quote failed: ${e.message?.slice(0, 60)}`);
  }
}

const totalNetCost = totalGrossCost - totalReceived;
const totalValue = totalTokenValue + totalWalletEth;
const totalPnl = totalValue - totalNetCost;
const totalPnlPct = totalNetCost > 0 ? (totalPnl / totalNetCost * 100) : 0;
console.log(`\n--- TOTAL ---`);
console.log(`Gross in:  ${totalGrossCost.toFixed(6)} ETH (sum of all buys)`);
console.log(`Sold back: ${totalReceived.toFixed(6)} ETH (from sells)`);
console.log(`Net cost:  ${totalNetCost.toFixed(6)} ETH (actual capital at risk)`);
console.log(`Tokens:    ${totalTokenValue.toFixed(6)} ETH`);
console.log(`Wallet:    ${totalWalletEth.toFixed(6)} ETH`);
console.log(`Value:     ${totalValue.toFixed(6)} ETH (tokens + wallet ETH)`);
console.log(`PnL:       ${totalPnl >= 0 ? "+" : ""}${totalPnl.toFixed(6)} ETH (${totalPnlPct >= 0 ? "+" : ""}${totalPnlPct.toFixed(1)}%)`);
