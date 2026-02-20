#!/usr/bin/env tsx
/**
 * Fleet Operations CLI
 *
 * Usage:
 *   fleet-ops buy   <coin> [--wallets N] [--amount-eth 0.001] [--slippage 500]
 *   fleet-ops sell   <coin> [--wallets all|1,2,3]
 *   fleet-ops status [--coin <address>]
 *   fleet-ops route  <coin>
 *   fleet-ops fund   [--wallets N] [--amount-eth 0.001]
 *
 * All commands require doppler env:
 *   doppler run --project onchain-tooling --config dev -- tsx src/cli/fleet-ops.ts <command>
 */

import { createPublicClient, http, formatEther, parseEther, type Address } from "viem";
import { base } from "viem/chains";
import { resolveCoinRoute, getCoinBalance, type CoinRouteClient } from "../services/coinRoute.js";
import { quoteExactInputSingle, applySlippage } from "../services/v4Quoter.js";
import { encodeV4ExactInSwap, getRouterAddress } from "../services/v4SwapEncoder.js";
import { ensurePermit2Approval } from "../services/erc20.js";
import { getChainConfig } from "../services/network.js";
import {
  toCoinbaseSmartAccount,
  createBundlerClient,
  sendUserOperation,
  waitForUserOperationReceipt,
} from "viem/account-abstraction";
import { privateKeyToAccount } from "viem/accounts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getClient() {
  const cfg = getChainConfig();
  return createPublicClient({ chain: base, transport: http(cfg.rpcUrl) });
}

function getBundlerUrl(): string {
  return (
    process.env.PIMLICO_BASE_BUNDLER_URL ||
    process.env.BUNDLER_PRIMARY_URL ||
    (() => { throw new Error("No bundler URL"); })()
  );
}

function getMasterKey(): `0x${string}` {
  const pk = process.env.MASTER_WALLET_PRIVATE_KEY?.trim();
  if (!pk || !/^0x[0-9a-fA-F]{64}$/.test(pk)) throw new Error("MASTER_WALLET_PRIVATE_KEY not set");
  return pk as `0x${string}`;
}

function makePoolKey(
  tokenIn: Address,
  tokenOut: Address,
  params: { fee: number; tickSpacing: number; hooks: Address },
) {
  const [c0, c1] =
    tokenIn.toLowerCase() < tokenOut.toLowerCase()
      ? [tokenIn, tokenOut]
      : [tokenOut, tokenIn];
  return {
    poolKey: { currency0: c0 as Address, currency1: c1 as Address, fee: params.fee, tickSpacing: params.tickSpacing, hooks: params.hooks },
    zeroForOne: tokenIn.toLowerCase() === c0.toLowerCase(),
  };
}

async function quoteMultiHop(
  client: ReturnType<typeof getClient>,
  chainId: number,
  path: Address[],
  poolParams: Array<{ fee: number; tickSpacing: number; hooks: Address; hookData: string }>,
  amountIn: bigint,
): Promise<bigint> {
  let currentAmount = amountIn;
  for (let i = 0; i < path.length - 1; i++) {
    const pk = makePoolKey(path[i]!, path[i + 1]!, poolParams[i]!);
    const quote = await quoteExactInputSingle({
      chainId,
      client,
      poolKey: pk.poolKey,
      zeroForOne: pk.zeroForOne,
      amountIn: currentAmount,
    });
    currentAmount = quote.amountOut;
  }
  return currentAmount;
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

async function cmdRoute(coin: Address) {
  const client = getClient();
  console.log(`Resolving route for ${coin}...`);
  const route = await resolveCoinRoute({
    client: client as unknown as CoinRouteClient,
    coinAddress: coin,
  });

  console.log(`\nAncestry: ${route.ancestry.join(" → ")}`);
  console.log(`Buy path (${route.buyPath.length - 1} hops): ${route.buyPath.join(" → ")}`);
  for (let i = 0; i < route.buyPoolParams.length; i++) {
    const p = route.buyPoolParams[i]!;
    console.log(`  Hop ${i}: fee=${p.fee} tickSpacing=${p.tickSpacing} hooks=${p.hooks}`);
  }

  // Quote 0.001 ETH buy
  const quoteAmount = parseEther("0.001");
  const buyOut = await quoteMultiHop(client, 8453, route.buyPath, route.buyPoolParams, quoteAmount);
  console.log(`\nQuote: ${formatEther(quoteAmount)} ETH → ${buyOut} coin`);

  return route;
}

async function cmdBuy(coin: Address, amountEth: string, slippageBps: number) {
  const client = getClient();
  const chainId = 8453;
  const amountIn = parseEther(amountEth);

  console.log(`Resolving route for ${coin}...`);
  const route = await resolveCoinRoute({
    client: client as unknown as CoinRouteClient,
    coinAddress: coin,
  });
  console.log(`Route: ${route.buyPath.length - 1} hops`);

  // Quote
  const expectedOut = await quoteMultiHop(client, chainId, route.buyPath, route.buyPoolParams, amountIn);
  const minOut = applySlippage(expectedOut, slippageBps);
  console.log(`Quote: ${amountEth} ETH → ${expectedOut} coin (min: ${minOut} at ${slippageBps}bps)`);

  // Encode swap
  const encoded = encodeV4ExactInSwap({
    chainId,
    path: route.buyPath,
    amountIn,
    minAmountOut: minOut,
    poolParamsPerHop: route.buyPoolParams,
  });

  // Set up smart account + bundler
  const owner = privateKeyToAccount(getMasterKey());
  const smartAccount = await toCoinbaseSmartAccount({ client, owners: [owner], version: "1.1" });
  console.log(`Smart Account: ${smartAccount.address}`);

  const balance = await client.getBalance({ address: smartAccount.address });
  console.log(`ETH balance: ${formatEther(balance)}`);
  if (balance < amountIn + parseEther("0.001")) {
    throw new Error(`Insufficient ETH. Need ${formatEther(amountIn + parseEther("0.001"))}, have ${formatEther(balance)}`);
  }

  const bundlerClient = createBundlerClient({
    account: smartAccount,
    chain: base,
    client,
    transport: http(getBundlerUrl()),
  });

  console.log("Submitting buy...");
  const hash = await sendUserOperation(bundlerClient, {
    account: smartAccount,
    calls: [{ to: encoded.to, value: encoded.value, data: encoded.data as `0x${string}` }],
  });
  console.log(`UserOp: ${hash}`);

  const receipt = await waitForUserOperationReceipt(bundlerClient, { hash, timeout: 120_000 });
  console.log(`Tx: ${receipt.receipt.transactionHash} (status: ${receipt.receipt.status})`);

  await new Promise((r) => setTimeout(r, 2000));
  const coinBal = await getCoinBalance(
    client as unknown as CoinRouteClient,
    coin,
    smartAccount.address,
  );
  console.log(`Coin balance: ${coinBal}`);
}

async function cmdSell(coin: Address, slippageBps: number) {
  const client = getClient();
  const chainId = 8453;

  const owner = privateKeyToAccount(getMasterKey());
  const smartAccount = await toCoinbaseSmartAccount({ client, owners: [owner], version: "1.1" });
  console.log(`Smart Account: ${smartAccount.address}`);

  const sellAmount = await getCoinBalance(
    client as unknown as CoinRouteClient,
    coin,
    smartAccount.address,
  );
  if (sellAmount === 0n) {
    console.log("No coins to sell.");
    return;
  }
  console.log(`Selling ${sellAmount} coins...`);

  const route = await resolveCoinRoute({
    client: client as unknown as CoinRouteClient,
    coinAddress: coin,
  });

  // Quote sell
  const expectedOut = await quoteMultiHop(client, chainId, route.sellPath, route.sellPoolParams, sellAmount);
  const minOut = applySlippage(expectedOut, slippageBps);
  console.log(`Quote: ${sellAmount} coin → ${formatEther(expectedOut)} ETH (min: ${formatEther(minOut)})`);

  // Permit2 approvals
  const routerAddress = getRouterAddress(chainId);
  const permit2Calls = await ensurePermit2Approval({
    client,
    token: coin,
    owner: smartAccount.address,
    router: routerAddress,
  });
  console.log(`Permit2 calls needed: ${permit2Calls.length}`);

  // Encode sell
  const encoded = encodeV4ExactInSwap({
    chainId,
    path: route.sellPath,
    amountIn: sellAmount,
    minAmountOut: minOut,
    poolParamsPerHop: route.sellPoolParams,
  });

  const bundlerClient = createBundlerClient({
    account: smartAccount,
    chain: base,
    client,
    transport: http(getBundlerUrl()),
  });

  const calls = [
    ...permit2Calls,
    { to: encoded.to, value: encoded.value, data: encoded.data as `0x${string}` },
  ];

  console.log(`Submitting sell (${calls.length} calls)...`);
  const hash = await sendUserOperation(bundlerClient, { account: smartAccount, calls });
  console.log(`UserOp: ${hash}`);

  const receipt = await waitForUserOperationReceipt(bundlerClient, { hash, timeout: 120_000 });
  console.log(`Tx: ${receipt.receipt.transactionHash} (status: ${receipt.receipt.status})`);

  await new Promise((r) => setTimeout(r, 2000));
  const finalBal = await client.getBalance({ address: smartAccount.address });
  console.log(`Final ETH balance: ${formatEther(finalBal)}`);
}

async function cmdStatus(coin?: Address) {
  const client = getClient();
  const owner = privateKeyToAccount(getMasterKey());
  const smartAccount = await toCoinbaseSmartAccount({ client, owners: [owner], version: "1.1" });

  const ethBal = await client.getBalance({ address: smartAccount.address });
  console.log(`Smart Account: ${smartAccount.address}`);
  console.log(`ETH balance: ${formatEther(ethBal)}`);

  if (coin) {
    const coinBal = await getCoinBalance(
      client as unknown as CoinRouteClient,
      coin,
      smartAccount.address,
    );
    console.log(`Coin ${coin} balance: ${coinBal}`);
  }
}

async function cmdVerify() {
  const client = getClient();
  const owner = privateKeyToAccount(getMasterKey());
  const smartAccount = await toCoinbaseSmartAccount({ client, owners: [owner], version: "1.1" });

  console.log("=== Key Verification ===");
  console.log(`Owner (from MASTER_WALLET_PRIVATE_KEY): ${owner.address}`);
  console.log(`Smart Account (derived):                ${smartAccount.address}`);

  const { db } = await import("../db/index.js");
  const dbMaster = db.getMasterWallet();
  if (!dbMaster) {
    console.log("\n⚠️  No master wallet in DB yet (will be created on first run).");
  } else {
    console.log(`\nDB master wallet (id=${dbMaster.id}):`);
    console.log(`  address:       ${dbMaster.address}`);
    console.log(`  owner_address: ${dbMaster.ownerAddress}`);

    const ownerMatch = dbMaster.ownerAddress.toLowerCase() === owner.address.toLowerCase();
    const smartMatch = dbMaster.address.toLowerCase() === smartAccount.address.toLowerCase();

    if (ownerMatch && smartMatch) {
      console.log("\n✅ All addresses match. Key and DB are consistent.");
    } else {
      if (!ownerMatch) console.log(`\n❌ OWNER MISMATCH: DB has ${dbMaster.ownerAddress}, key derives ${owner.address}`);
      if (!smartMatch) console.log(`\n❌ SMART ACCOUNT MISMATCH: DB has ${dbMaster.address}, key derives ${smartAccount.address}`);
      console.log("\nAction needed: either restore the correct private key or delete the DB master record.");
    }
  }

  const ethBal = await client.getBalance({ address: smartAccount.address });
  console.log(`\nSmart Account ETH balance: ${formatEther(ethBal)}`);
}

// ---------------------------------------------------------------------------
// CLI entry
// ---------------------------------------------------------------------------

async function main() {
  const args = process.argv.slice(2);
  const cmd = args[0];

  const getFlag = (name: string, def: string) => {
    const idx = args.indexOf(`--${name}`);
    return idx >= 0 && args[idx + 1] ? args[idx + 1]! : def;
  };

  try {
    switch (cmd) {
      case "route":
        if (!args[1]) throw new Error("Usage: fleet-ops route <coin-address>");
        await cmdRoute(args[1] as Address);
        break;

      case "buy":
        if (!args[1]) throw new Error("Usage: fleet-ops buy <coin-address> [--amount-eth 0.001] [--slippage 500]");
        await cmdBuy(
          args[1] as Address,
          getFlag("amount-eth", "0.001"),
          parseInt(getFlag("slippage", "500")),
        );
        break;

      case "sell":
        if (!args[1]) throw new Error("Usage: fleet-ops sell <coin-address> [--slippage 500]");
        await cmdSell(args[1] as Address, parseInt(getFlag("slippage", "500")));
        break;

      case "status":
        await cmdStatus(args[1] as Address | undefined);
        break;

      case "verify":
        await cmdVerify();
        break;

      default:
        console.log(`Fleet Ops CLI

Commands:
  route  <coin>  — Resolve swap path and quote
  buy    <coin>  — Buy coin with ETH [--amount-eth 0.001] [--slippage 500]
  sell   <coin>  — Sell all coins back to ETH [--slippage 500]
  status [coin]  — Show wallet balances
  verify         — Verify master key ↔ DB consistency`);
    }
  } catch (err) {
    console.error("Error:", err instanceof Error ? err.message : err);
    process.exit(1);
  }
}

main();
