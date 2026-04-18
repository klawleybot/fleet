/**
 * klawley-trader.ts — Executes trades from Klawley's Zora smart wallet.
 *
 * This is a standalone trade executor that uses the fleet's swap infrastructure
 * (v4SwapEncoder, v4Quoter, coinRoute, bundler) but bypasses the fleet DB.
 * Klawley's wallet is registered in cdp.ts under the name "klawley".
 *
 * Usage:
 *   # Buy a coin with ETH
 *   doppler run --project openclaw --config prd -- bun x tsx src/klawley-trader.ts buy <coin_address> <eth_amount>
 *
 *   # Sell a coin back to ETH
 *   doppler run --project openclaw --config prd -- bun x tsx src/klawley-trader.ts sell <coin_address> <token_amount>
 *
 *   # Check balances
 *   doppler run --project openclaw --config prd -- bun x tsx src/klawley-trader.ts balance
 *
 *   # Quote only (no execution)
 *   doppler run --project openclaw --config prd -- bun x tsx src/klawley-trader.ts quote <coin_address> <eth_amount>
 */

import {
  createPublicClient,
  http,
  formatEther,
  parseEther,
  erc20Abi,
  type Address,
} from "viem";
import { base } from "viem/chains";
import type { swapFromSmartAccount as swapFromSmartAccountFn } from "../../server/src/services/cdp.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const KLAWLEY_ACCOUNT_NAME = "klawley";
const KLAWLEY_SA: Address = (process.env.ZORA_SMART_WALLET as Address) || "0x097677d3e2cde65af10be80ae5e67b8b68eb613d";
const WETH: Address = "0x4200000000000000000000000000000000000006";
const ZORA_TOKEN: Address = "0x1111111111166b7FE7bd91427724B487980aFc69";

// ---------------------------------------------------------------------------
// Lazy imports (avoid loading fleet server deps at module level)
// ---------------------------------------------------------------------------

type SwapFromSmartAccount = typeof swapFromSmartAccountFn;

async function getSwapFn() {
  // Dynamic import so we can run from the intelligence package
  // pointing at the server's source
  const serverPath = new URL("../../server/src/services/cdp.js", import.meta.url).pathname;
  const { swapFromSmartAccount } = (await import(serverPath)) as {
    swapFromSmartAccount: SwapFromSmartAccount;
  };
  return swapFromSmartAccount;
}

function getPublicClient() {
  return createPublicClient({
    chain: base,
    transport: http(process.env.BASE_RPC_URL),
  });
}

// ---------------------------------------------------------------------------
// Balance check
// ---------------------------------------------------------------------------

export async function getKlawleyBalances(): Promise<{
  ethBalance: bigint;
  ethFormatted: string;
  zoraBalance: bigint;
  zoraFormatted: string;
}> {
  const client = getPublicClient();
  const [ethBalance, zoraBalance] = await Promise.all([
    client.getBalance({ address: KLAWLEY_SA }),
    client.readContract({
      address: ZORA_TOKEN,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [KLAWLEY_SA],
    }),
  ]);

  return {
    ethBalance,
    ethFormatted: formatEther(ethBalance),
    zoraBalance,
    zoraFormatted: formatEther(zoraBalance),
  };
}

export async function getCoinBalance(coinAddress: Address): Promise<{
  balance: bigint;
  formatted: string;
}> {
  const client = getPublicClient();
  const balance = await client.readContract({
    address: coinAddress,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [KLAWLEY_SA],
  });
  return { balance, formatted: formatEther(balance) };
}

// ---------------------------------------------------------------------------
// Trade execution
// ---------------------------------------------------------------------------

export interface TradeResult {
  action: "buy" | "sell";
  coinAddress: string;
  amountIn: string;
  amountOut: string | null;
  txHash: string | null;
  userOpHash: string;
  status: string;
  error?: string;
}

/**
 * Buy a Zora coin with ETH.
 * Route: ETH → ZORA → coin (auto-discovered via coinRoute)
 */
export async function buyCoin(
  coinAddress: Address,
  ethAmountWei: bigint,
  slippageBps = 300,
): Promise<TradeResult> {
  console.log(`[klawley-trader] BUY ${coinAddress}`);
  console.log(`  Amount: ${formatEther(ethAmountWei)} ETH`);
  console.log(`  Slippage: ${slippageBps} bps`);
  console.log(`  Account: ${KLAWLEY_ACCOUNT_NAME} (${KLAWLEY_SA})`);

  // Pre-flight: check tradeability (V3-only coins can't be swapped via V4)
  try {
    const { checkTradeability, closeTradeabilityDb } = await import("./tradeability.js");
    const tradeCheck = await checkTradeability(coinAddress);
    closeTradeabilityDb();
    if (!tradeCheck.tradeable) {
      throw new Error(`Coin is not tradeable via V4 pipeline (${tradeCheck.reason}). This is likely a V3-only pool.`);
    }
  } catch (err) {
    if (err instanceof Error && err.message.includes("not tradeable")) throw err;
    // Import/check failure — continue anyway, let the swap fail naturally
  }

  // Pre-flight: check balance
  const client = getPublicClient();
  const balance = await client.getBalance({ address: KLAWLEY_SA });
  if (balance < ethAmountWei) {
    throw new Error(
      `Insufficient ETH: have ${formatEther(balance)}, need ${formatEther(ethAmountWei)}`
    );
  }

  const swap = await getSwapFn();
  try {
    const result = await swap({
      smartAccountName: KLAWLEY_ACCOUNT_NAME,
      fromToken: WETH,
      toToken: coinAddress,
      fromAmount: ethAmountWei,
      slippageBps,
    });

    console.log(`  ✅ ${result.status} | tx: ${result.txHash}`);
    return {
      action: "buy",
      coinAddress,
      amountIn: ethAmountWei.toString(),
      amountOut: result.amountOut ?? null,
      txHash: result.txHash,
      userOpHash: result.userOpHash,
      status: result.status,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`  ❌ Buy failed: ${msg}`);

    // If execution reverted, cache coin as V3-only so future scouts skip it
    if (msg.includes("execution reverted") || msg.includes("Execution reverted")) {
      try {
        // Direct DB write — mark as untradeable without re-probing
        const Database = (await import("better-sqlite3")).default;
        const { env } = await import("./config.js");
        const db = new Database(process.env.ZORA_INTEL_DB_PATH || env.DB_PATH);
        db.exec(`CREATE TABLE IF NOT EXISTS coin_tradeability (
          coin_address TEXT PRIMARY KEY, tradeable INTEGER NOT NULL,
          reason TEXT, checked_at TEXT NOT NULL)`);
        db.prepare(
          `INSERT OR REPLACE INTO coin_tradeability (coin_address, tradeable, reason, checked_at)
           VALUES (?, 0, 'weth_v3_only', ?)`
        ).run(coinAddress.toLowerCase(), new Date().toISOString());
        db.close();
        console.log(`  📝 Cached ${coinAddress.slice(0,10)} as V3-only (untradeable via V4)`);
      } catch {
        // Cache write failure is non-fatal
      }
    }

    return {
      action: "buy",
      coinAddress,
      amountIn: ethAmountWei.toString(),
      amountOut: null,
      txHash: null,
      userOpHash: "",
      status: "failed",
      error: msg,
    };
  }
}

/**
 * Sell a Zora coin back to ETH.
 * Route: coin → ZORA → ETH (auto-discovered via coinRoute)
 */
export async function sellCoin(
  coinAddress: Address,
  tokenAmount: bigint,
  slippageBps = 300,
): Promise<TradeResult> {
  console.log(`[klawley-trader] SELL ${coinAddress}`);
  console.log(`  Amount: ${formatEther(tokenAmount)} tokens`);
  console.log(`  Slippage: ${slippageBps} bps`);

  const swap = await getSwapFn();
  try {
    const result = await swap({
      smartAccountName: KLAWLEY_ACCOUNT_NAME,
      fromToken: coinAddress,
      toToken: WETH,
      fromAmount: tokenAmount,
      slippageBps,
    });

    console.log(`  ✅ ${result.status} | tx: ${result.txHash}`);
    return {
      action: "sell",
      coinAddress,
      amountIn: tokenAmount.toString(),
      amountOut: result.amountOut ?? null,
      txHash: result.txHash,
      userOpHash: result.userOpHash,
      status: result.status,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`  ❌ Sell failed: ${msg}`);
    return {
      action: "sell",
      coinAddress,
      amountIn: tokenAmount.toString(),
      amountOut: null,
      txHash: null,
      userOpHash: "",
      status: "failed",
      error: msg,
    };
  }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

async function main() {
  const cmd = process.argv[2];

  if (!cmd || cmd === "help") {
    console.log(`klawley-trader commands:
  balance                          Show ETH + ZORA balances
  balance <coin_address>           Show coin token balance
  buy <coin_address> <eth_amount>  Buy a coin with ETH
  sell <coin_address> <amount>     Sell coin tokens back to ETH (amount in token units)
  sell-all <coin_address>          Sell entire coin balance
`);
    return;
  }

  if (cmd === "balance") {
    const coinAddr = process.argv[3];
    if (coinAddr) {
      const bal = await getCoinBalance(coinAddr as Address);
      console.log(`Coin ${coinAddr}: ${bal.formatted} tokens`);
    }
    const b = await getKlawleyBalances();
    console.log(`Klawley SA (${KLAWLEY_SA}):`);
    console.log(`  ETH:  ${b.ethFormatted}`);
    console.log(`  ZORA: ${b.zoraFormatted}`);
    return;
  }

  if (cmd === "buy") {
    const coinAddr = process.argv[3];
    const ethAmount = process.argv[4];
    if (!coinAddr || !ethAmount) {
      console.error("Usage: buy <coin_address> <eth_amount>");
      process.exit(1);
    }
    const result = await buyCoin(
      coinAddr as Address,
      parseEther(ethAmount),
      Number(process.argv[5] || "300"),
    );
    console.log("\nResult:", JSON.stringify(result, null, 2));
    return;
  }

  if (cmd === "sell") {
    const coinAddr = process.argv[3];
    const amount = process.argv[4];
    if (!coinAddr || !amount) {
      console.error("Usage: sell <coin_address> <token_amount>");
      process.exit(1);
    }
    const result = await sellCoin(
      coinAddr as Address,
      parseEther(amount),
      Number(process.argv[5] || "300"),
    );
    console.log("\nResult:", JSON.stringify(result, null, 2));
    return;
  }

  if (cmd === "sell-all") {
    const coinAddr = process.argv[3];
    if (!coinAddr) {
      console.error("Usage: sell-all <coin_address>");
      process.exit(1);
    }
    const bal = await getCoinBalance(coinAddr as Address);
    if (bal.balance === 0n) {
      console.log("No tokens to sell.");
      return;
    }
    console.log(`Selling all: ${bal.formatted} tokens`);
    const result = await sellCoin(
      coinAddr as Address,
      bal.balance,
      Number(process.argv[4] || "300"),
    );
    console.log("\nResult:", JSON.stringify(result, null, 2));
    return;
  }

  console.error(`Unknown command: ${cmd}`);
  process.exit(1);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error("Fatal:", err);
    process.exit(1);
  });
}
