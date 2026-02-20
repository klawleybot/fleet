#!/usr/bin/env tsx
/**
 * Quick fleet sell-all: sells entire coin balance from each wallet in a fleet.
 *
 * Usage: fleet-sell-all <fleet-name> <coin-address> [--slippage 500]
 */
import { createPublicClient, http, formatEther, type Address } from "viem";
import { base } from "viem/chains";
import { getChainConfig } from "../services/network.js";
import { getCoinBalance, type CoinRouteClient } from "../services/coinRoute.js";
import { swapFromSmartAccount } from "../services/cdp.js";
import { getFleetByName } from "../services/fleet.js";
import { ensureMasterWallet } from "../services/wallet.js";
import { recordTradePosition } from "../services/monitor.js";
import { db } from "../db/index.js";

const WETH = "0x4200000000000000000000000000000000000006" as Address;

function getClient() {
  const cfg = getChainConfig();
  return createPublicClient({ chain: base, transport: http(cfg.rpcUrl) });
}

async function main() {
  const args = process.argv.slice(2);
  const fleetName = args[0];
  const coin = args[1] as Address;
  const slippageIdx = args.indexOf("--slippage");
  const slippage = slippageIdx >= 0 ? parseInt(args[slippageIdx + 1]!) : 500;

  if (!fleetName || !coin) {
    console.log("Usage: fleet-sell-all <fleet-name> <coin> [--slippage 500]");
    process.exit(1);
  }

  await ensureMasterWallet();
  const fleet = getFleetByName(fleetName);
  if (!fleet) throw new Error(`Fleet "${fleetName}" not found`);

  const client = getClient();
  console.log(`Selling ${coin} from fleet "${fleetName}" (${fleet.wallets.length} wallets)\n`);

  let totalRecovered = 0n;
  let successes = 0;
  let failures = 0;

  for (const wallet of fleet.wallets) {
    const balance = await getCoinBalance(
      client as unknown as CoinRouteClient,
      coin,
      wallet.address as Address,
    );

    if (balance === 0n) {
      console.log(`  ${wallet.name}: no coins, skipping`);
      continue;
    }

    console.log(`  ${wallet.name}: selling ${balance} coins...`);
    try {
      const result = await swapFromSmartAccount({
        smartAccountName: wallet.cdpAccountName,
        fromToken: coin,
        toToken: WETH,
        fromAmount: balance,
        slippageBps: slippage,
      });

      if (result.status === "complete") {
        const out = BigInt(result.amountOut ?? "0");
        totalRecovered += out;
        successes++;
        console.log(`    ✅ ${formatEther(out)} ETH recovered (tx: ${result.txHash?.slice(0, 12)}...)`);

        recordTradePosition({
          walletId: wallet.id,
          coinAddress: coin,
          isBuy: false,
          ethAmountWei: out.toString(),
          tokenAmount: balance.toString(),
        });
      } else {
        failures++;
        console.log(`    ❌ status: ${result.status}`);
      }
    } catch (err) {
      failures++;
      console.log(`    ❌ ${err instanceof Error ? err.message.slice(0, 100) : err}`);
    }
  }

  console.log(`\nResults: ${successes} sold, ${failures} failed`);
  console.log(`Total recovered: ${formatEther(totalRecovered)} ETH`);
}

main().catch((err) => {
  console.error("Error:", err instanceof Error ? err.message : err);
  process.exit(1);
});
