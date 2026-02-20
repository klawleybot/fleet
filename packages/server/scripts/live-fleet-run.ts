/**
 * Live Fleet Run — direct execution (no HTTP server)
 *
 * Usage: doppler run --project onchain-tooling --config dev -- node --import tsx/esm packages/server/scripts/live-fleet-run.ts
 */
process.env.SIGNER_BACKEND = "local";
process.env.CDP_MOCK_MODE = "0";
process.env.APP_NETWORK = "base";
process.env.FUNDING_LOCAL_SOURCE = "smart";
process.env.MAX_PER_WALLET_WEI = "10000000000000000";
process.env.FLEET_KILL_SWITCH = "false";
process.env.CLUSTER_COOLDOWN_SEC = "0";

import { createPublicClient, http, formatEther, type Address } from "viem";
import { base } from "viem/chains";
import { resolveCoinRoute } from "../src/services/coinRoute.js";
import { db } from "../src/db/index.js";
import { ensureMasterWallet, createFleetWallets } from "../src/services/wallet.js";
import { transferFromSmartAccount, swapFromSmartAccount } from "../src/services/cdp.js";
import { jiggleAmounts } from "../src/services/trade.js";
import { recordTradePosition } from "../src/services/monitor.js";
import { getCoinBalance } from "../src/services/coinRoute.js";

const COIN = "0x0846f71fe43c8d374e15870c8cf79a3a95929559" as Address;
const FLEET_NAME = "alpha";
const WALLET_COUNT = 5;
const TOTAL_BUY_WEI = 10000000000000000n; // 0.01 ETH
const FUND_PER_WALLET = 2500000000000000n; // 0.0025 ETH (0.002 for trade + gas)
const SLIPPAGE_BPS = 300; // 3% for Doppler pools
const DRIP_DURATION_MS = 10 * 60 * 1000;

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  console.log(`\n🚢 LIVE FLEET RUN — Base Mainnet`);
  console.log(`   Coin: ${COIN}`);
  console.log(`   Fleet: ${FLEET_NAME} (${WALLET_COUNT} wallets)`);
  console.log(`   Buy: ${formatEther(TOTAL_BUY_WEI)} ETH over ${DRIP_DURATION_MS / 1000}s`);
  console.log(`   Slippage: ${SLIPPAGE_BPS} bps\n`);

  // --- Route discovery ---
  console.log("📡 Discovering coin route...");
  const client = createPublicClient({ chain: base, transport: http(process.env.BASE_RPC_URL) });
  const route = await resolveCoinRoute({ client: client as any, coinAddress: COIN });
  console.log(`   ${route.buyPath.length - 1}-hop: ${route.buyPath.map((a) => a.slice(0, 10) + "...").join(" → ")}`);

  // --- Ensure master wallet ---
  const master = await ensureMasterWallet();
  const masterBal = await client.getBalance({ address: master.address as Address });
  console.log(`\n💰 Master SA: ${master.address}`);
  console.log(`   Balance: ${formatEther(masterBal)} ETH`);

  // --- Get or create fleet wallets ---
  let cluster = db.getClusterByName(FLEET_NAME);
  let wallets: Awaited<ReturnType<typeof createFleetWallets>>;

  if (cluster) {
    wallets = db.listClusterWalletDetails(cluster.id);
    console.log(`\n📦 Fleet "${FLEET_NAME}" exists with ${wallets.length} wallets`);
  } else {
    console.log(`\n🚀 Creating fleet "${FLEET_NAME}" with ${WALLET_COUNT} wallets...`);
    wallets = await createFleetWallets(WALLET_COUNT);
    cluster = db.createCluster({ name: FLEET_NAME, strategyMode: "sync" });
    db.setClusterWallets(cluster.id, wallets.map((w) => w.id));
    console.log(`   ✅ Fleet created`);
  }

  for (const w of wallets) {
    const bal = await client.getBalance({ address: w.address as Address });
    console.log(`   ${w.name}: ${w.address} (${formatEther(bal)} ETH)`);
  }

  // --- Fund wallets that need it ---
  console.log(`\n💸 Funding wallets (${formatEther(FUND_PER_WALLET)} ETH each)...`);
  for (const w of wallets) {
    const bal = await client.getBalance({ address: w.address as Address });
    if (bal >= FUND_PER_WALLET / 2n) {
      console.log(`   ${w.name}: already funded (${formatEther(bal)} ETH)`);
      continue;
    }
    console.log(`   ${w.name}: funding...`);
    const result = await transferFromSmartAccount({
      smartAccountName: master.cdpAccountName,
      to: w.address,
      amountWei: FUND_PER_WALLET,
    });
    console.log(`   ${w.name}: ✅ tx=${result.txHash?.slice(0, 14)}... status=${result.status}`);
  }

  // --- Buy with drip + jiggle ---
  console.log(`\n💰 Buying ${formatEther(TOTAL_BUY_WEI)} ETH of coin (drip over ${DRIP_DURATION_MS / 1000}s)...`);
  const perWalletAmounts = jiggleAmounts(TOTAL_BUY_WEI, WALLET_COUNT, 0.15);
  const intervals = Math.max(2, Math.min(10, Math.floor(DRIP_DURATION_MS / 60_000)));
  console.log(`   ${intervals} intervals per wallet, amounts: [${perWalletAmounts.map((a) => formatEther(a)).join(", ")}]`);

  const startTime = Date.now();
  const WETH = "0x4200000000000000000000000000000000000006" as Address;

  for (let interval = 0; interval < intervals; interval++) {
    const slotStart = (DRIP_DURATION_MS / intervals) * interval;
    const elapsed = Date.now() - startTime;
    const waitMs = slotStart - elapsed;
    if (waitMs > 0) {
      console.log(`\n   ⏳ Waiting ${Math.round(waitMs / 1000)}s for interval ${interval + 1}/${intervals}...`);
      await sleep(waitMs);
    }

    console.log(`\n   🔄 Interval ${interval + 1}/${intervals} (${Math.round((Date.now() - startTime) / 1000)}s elapsed)`);

    for (let w = 0; w < wallets.length; w++) {
      const wallet = wallets[w]!;
      const subAmount = perWalletAmounts[w]! / BigInt(intervals);
      if (subAmount <= 0n) continue;

      // Add random jitter (0-30s) within the interval
      const jitter = Math.floor(Math.random() * 30_000);
      if (jitter > 1000) await sleep(jitter);

      try {
        console.log(`      ${wallet.name}: buying ${formatEther(subAmount)} ETH worth...`);
        const result = await swapFromSmartAccount({
          smartAccountName: wallet.cdpAccountName,
          fromToken: WETH,
          toToken: COIN,
          fromAmount: subAmount,
          slippageBps: SLIPPAGE_BPS,
        });
        console.log(`      ${wallet.name}: ✅ status=${result.status} amountOut=${result.amountOut ?? "?"}`);

        if (result.status === "complete") {
          db.createTrade({
            walletId: wallet.id,
            fromToken: WETH,
            toToken: COIN,
            amountIn: subAmount.toString(),
            amountOut: result.amountOut ?? null,
            userOpHash: result.userOpHash,
            txHash: result.txHash,
            status: "complete",
            errorMessage: null,
          });
          recordTradePosition({
            walletId: wallet.id,
            coinAddress: COIN,
            isBuy: true,
            ethAmountWei: subAmount.toString(),
            tokenAmount: result.amountOut ?? "0",
          });
        }
      } catch (err) {
        console.error(`      ${wallet.name}: ❌ ${err instanceof Error ? err.message : err}`);
      }
    }
  }

  const buyDuration = Math.round((Date.now() - startTime) / 1000);
  console.log(`\n✅ Buy phase complete (${buyDuration}s)`);

  // --- Check positions ---
  console.log(`\n📊 Positions:`);
  const positions = db.listPositionsByCluster(cluster.id);
  let totalCost = 0n;
  for (const p of positions) {
    const onChainBal = await getCoinBalance(client as any, COIN, wallets.find((w) => w.id === p.walletId)!.address as Address);
    console.log(`   wallet=${p.walletId} cost=${formatEther(BigInt(p.totalCostWei))}E holdings=${onChainBal.toString()} buys=${p.buyCount}`);
    totalCost += BigInt(p.totalCostWei);
  }
  console.log(`   Total cost: ${formatEther(totalCost)} ETH`);

  // --- Sell back ---
  console.log(`\n💸 Selling all positions back (immediate)...`);
  for (const wallet of wallets) {
    const coinBal = await getCoinBalance(client as any, COIN, wallet.address as Address);
    if (coinBal <= 0n) {
      console.log(`   ${wallet.name}: no holdings, skipping`);
      continue;
    }

    try {
      console.log(`   ${wallet.name}: selling ${coinBal.toString()} tokens...`);
      const result = await swapFromSmartAccount({
        smartAccountName: wallet.cdpAccountName,
        fromToken: COIN as `0x${string}`,
        toToken: WETH,
        fromAmount: coinBal,
        slippageBps: SLIPPAGE_BPS,
      });
      console.log(`   ${wallet.name}: ✅ status=${result.status} ethBack=${result.amountOut ?? "?"}`);

      if (result.status === "complete") {
        db.createTrade({
          walletId: wallet.id,
          fromToken: COIN as `0x${string}`,
          toToken: WETH,
          amountIn: coinBal.toString(),
          amountOut: result.amountOut ?? null,
          userOpHash: result.userOpHash,
          txHash: result.txHash,
          status: "complete",
          errorMessage: null,
        });
        recordTradePosition({
          walletId: wallet.id,
          coinAddress: COIN,
          isBuy: false,
          ethAmountWei: result.amountOut ?? "0",
          tokenAmount: coinBal.toString(),
        });
      }
    } catch (err) {
      console.error(`   ${wallet.name}: ❌ ${err instanceof Error ? err.message : err}`);
    }
  }

  // --- Final summary ---
  console.log(`\n📊 Final positions:`);
  const finalPositions = db.listPositionsByCluster(cluster.id);
  let totalReceived = 0n;
  totalCost = 0n;
  for (const p of finalPositions) {
    totalCost += BigInt(p.totalCostWei);
    totalReceived += BigInt(p.totalReceivedWei);
    console.log(`   wallet=${p.walletId} cost=${formatEther(BigInt(p.totalCostWei))}E received=${formatEther(BigInt(p.totalReceivedWei))}E buys=${p.buyCount} sells=${p.sellCount}`);
  }
  const pnl = totalReceived - totalCost;
  console.log(`\n   Total cost: ${formatEther(totalCost)} ETH`);
  console.log(`   Total received: ${formatEther(totalReceived)} ETH`);
  console.log(`   Net P&L: ${formatEther(pnl)} ETH`);

  console.log(`\n🏁 Done!`);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
