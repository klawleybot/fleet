/**
 * Live Fleet Test — Base Mainnet
 *
 * Usage: doppler run --project openclaw --config dev -- npx tsx packages/server/scripts/live-fleet-test.ts
 */
import { createPublicClient, http, formatEther, type Address } from "viem";
import { base } from "viem/chains";
import { resolveCoinRoute } from "../src/services/coinRoute.js";

const COIN = "0x0846f71fe43c8d374e15870c8cf79a3a95929559" as Address;
const FLEET_NAME = "alpha";
const WALLET_COUNT = 5;
const TOTAL_ETH = "0.01";
const DRIP_DURATION_MS = 10 * 60 * 1000; // 10 minutes
const SLIPPAGE_BPS = 200; // 2% slippage for safety on Doppler pools

const API_BASE = `http://127.0.0.1:${process.env.PORT || 4000}`;

async function api(method: string, endpoint: string, body?: unknown) {
  const res = await fetch(`${API_BASE}${endpoint}`, {
    method,
    headers: { "content-type": "application/json" },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : null;
  if (!res.ok) {
    console.error(`❌ ${method} ${endpoint} → ${res.status}:`, json);
    throw new Error(`API error: ${res.status}`);
  }
  return json;
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  const totalWei = (BigInt(Math.floor(parseFloat(TOTAL_ETH) * 1e18))).toString();
  console.log(`\n🚢 LIVE FLEET TEST — Base Mainnet`);
  console.log(`   Coin: ${COIN}`);
  console.log(`   Fleet: ${FLEET_NAME} (${WALLET_COUNT} wallets)`);
  console.log(`   Amount: ${TOTAL_ETH} ETH (${totalWei} wei)`);
  console.log(`   Drip: ${DRIP_DURATION_MS / 1000}s`);
  console.log(`   Slippage: ${SLIPPAGE_BPS} bps\n`);

  // Step 0: Verify route
  console.log("📡 Discovering coin route...");
  const client = createPublicClient({ chain: base, transport: http(process.env.BASE_RPC_URL) });
  const route = await resolveCoinRoute({ client: client as any, coinAddress: COIN });
  console.log(`   ${route.buyPath.length - 1}-hop route: ${route.buyPath.map(a => a.slice(0, 8) + '...').join(' → ')}`);
  route.buyPoolParams.forEach((p, i) => {
    console.log(`   Hop ${i}: fee=${p.fee} ts=${p.tickSpacing} hooks=${p.hooks.slice(0, 10)}...`);
  });

  // Step 1: Health check
  console.log("\n🏥 Checking server health...");
  const health = await api("GET", "/health");
  console.log(`   Server: ${health.ok ? "✅ healthy" : "❌ unhealthy"}`);

  // Step 2: Create fleet
  console.log(`\n🚀 Creating fleet "${FLEET_NAME}" with ${WALLET_COUNT} wallets...`);
  const fundPerWallet = (BigInt(totalWei) / BigInt(WALLET_COUNT) + 500000000000000n).toString(); // extra for gas
  const totalFund = (BigInt(fundPerWallet) * BigInt(WALLET_COUNT)).toString();
  const fleetResult = await api("POST", "/fleets", {
    name: FLEET_NAME,
    wallets: WALLET_COUNT,
    fundAmountWei: totalFund,
  });
  console.log(`   ✅ Fleet created: ${fleetResult.fleet.wallets.length} wallets`);
  for (const w of fleetResult.fleet.wallets) {
    console.log(`      ${w.name}: ${w.address}`);
  }
  if (fleetResult.fundingOperationId) {
    console.log(`   ✅ Funded (operation #${fleetResult.fundingOperationId})`);
  }

  // Step 3: Buy with drip over 10 minutes
  console.log(`\n💰 Buying ${TOTAL_ETH} ETH of coin over ${DRIP_DURATION_MS / 1000}s (drip mode)...`);
  console.log(`   Started: ${new Date().toISOString()}`);
  const buyResult = await api("POST", `/fleets/${FLEET_NAME}/buy`, {
    coinAddress: COIN,
    totalAmountWei: totalWei,
    slippageBps: SLIPPAGE_BPS,
    overMs: DRIP_DURATION_MS,
    jiggle: true,
  });
  console.log(`   ✅ Buy complete: ${buyResult.tradeCount} trades`);
  console.log(`   Finished: ${new Date().toISOString()}`);
  for (const t of buyResult.trades) {
    const status = t.status === "complete" ? "✅" : "❌";
    console.log(`      ${status} wallet=${t.walletId} in=${formatEther(BigInt(t.amountIn))}E out=${t.amountOut ?? "?"}`);
  }

  // Step 4: Check positions
  console.log(`\n📊 Checking positions...`);
  const status = await api("GET", `/fleets/${FLEET_NAME}/status`);
  console.log(`   Fleet: ${status.clusterName} (${status.walletCount} wallets)`);
  console.log(`   Total cost: ${formatEther(BigInt(status.totalCostWei))} ETH`);
  console.log(`   Total received: ${formatEther(BigInt(status.totalReceivedWei))} ETH`);
  if (status.positions.length > 0) {
    for (const p of status.positions) {
      console.log(`      wallet=${p.walletId} holdings=${p.holdingsDb} cost=${formatEther(BigInt(p.totalCostWei))}E`);
    }
  }

  // Step 5: Sell back immediately
  console.log(`\n💸 Selling all positions back (immediate)...`);
  const sellResult = await api("POST", `/fleets/${FLEET_NAME}/sell`, {
    coinAddress: COIN,
    totalAmountWei: totalWei, // Use same amount (best effort)
    slippageBps: SLIPPAGE_BPS,
  });
  if (sellResult.operation) {
    console.log(`   ✅ Sell complete (operation #${sellResult.operation.id}, status: ${sellResult.operation.status})`);
  } else {
    console.log(`   ✅ Sell complete: ${sellResult.tradeCount} trades`);
  }

  // Step 6: Final positions
  console.log(`\n📊 Final positions...`);
  const finalStatus = await api("GET", `/fleets/${FLEET_NAME}/status`);
  console.log(`   Total cost: ${formatEther(BigInt(finalStatus.totalCostWei))} ETH`);
  console.log(`   Total received: ${formatEther(BigInt(finalStatus.totalReceivedWei))} ETH`);
  console.log(`   Realized P&L: ${formatEther(BigInt(finalStatus.totalRealizedPnlWei))} ETH`);

  console.log(`\n🏁 Done!`);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
