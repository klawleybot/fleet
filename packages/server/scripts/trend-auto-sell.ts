/**
 * Auto-sell trend content coins with smart partial sell strategy.
 *
 * Philosophy: don't dump on the faithful. Only sell into liquidity
 * where there have been real buyers.
 *
 * Strategy:
 *  - <3 holders: skip (too early)
 *  - 3-10 holders: sell 25%
 *  - 10-25 holders: sell 50%
 *  - 25+ holders: sell 75%
 *  - Never sell 100% — keep at least 10% floor
 *  - After 72h: final exit (sell 90%)
 *  - Re-evaluates partial_sold posts on subsequent runs
 *
 * Sell mechanism: Zora SDK createTradeCall() two-pass permit flow:
 *   1. createTradeCall() → get quote with permit placeholders
 *   2. Sign Permit2 PermitSingle via account.signTypedData() (ERC-1271 SA wrapping)
 *   3. createTradeCall() with signatures → get final callData (no placeholders)
 *   4. Submit via Pimlico bundler UserOp (approve + swap)
 *
 * Paymaster: viem `paymaster: true` + paymasterContext (ERC-7677 native).
 * Confirmed working with viem 2.45.2 + Pimlico.
 *
 * Usage:
 *   doppler run --project openclaw --config prd -- npx tsx packages/server/scripts/trend-auto-sell.ts
 */

import {
  createPublicClient, http, encodeFunctionData, erc20Abi, maxUint256,
  type Address, type Hex,
} from "viem";
import { base } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import {
  toCoinbaseSmartAccount,
  createBundlerClient,
  sendUserOperation,
  waitForUserOperationReceipt,
} from "viem/account-abstraction";
import Database from "better-sqlite3";
import { createTradeCall } from "@zoralabs/coins-sdk";
import { permit2ABI, permit2Address } from "@zoralabs/protocol-deployments";
import { TrendScorer } from "../../intelligence/src/trend-scorer.js";

const SMART_WALLET = "0x097677d3e2cde65af10be80ae5e67b8b68eb613d" as Address;
const PERMIT2 = permit2Address[base.id] as Address;

// Coins that must NEVER be auto-sold
const NEVER_SELL: Set<string> = new Set([
  "0x4d70f5970b0b6b3edc7c9e6e4ceb69e8b8f9e642", // $CLAWD
]);

const DB_PATH = new URL("../../intelligence/.data/zora-intelligence.db", import.meta.url).pathname;

const coinReadAbi = [
  { name: "balanceOf", type: "function", stateMutability: "view", inputs: [{ name: "", type: "address" }], outputs: [{ name: "", type: "uint256" }] },
  { name: "totalSupply", type: "function", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint256" }] },
] as const;

// ── Permit2 EIP-712 types ──────────────────────────────────
const PERMIT_SINGLE_TYPES = {
  PermitSingle: [
    { name: "details", type: "PermitDetails" },
    { name: "spender", type: "address" },
    { name: "sigDeadline", type: "uint256" },
  ],
  PermitDetails: [
    { name: "token", type: "address" },
    { name: "amount", type: "uint160" },
    { name: "expiration", type: "uint48" },
    { name: "nonce", type: "uint48" },
  ],
} as const;

function convertBigIntToString(obj: any): any {
  if (typeof obj === "bigint") return obj.toString();
  if (Array.isArray(obj)) return obj.map(convertBigIntToString);
  if (obj && typeof obj === "object") {
    const out: any = {};
    for (const [k, v] of Object.entries(obj)) out[k] = convertBigIntToString(v);
    return out;
  }
  return obj;
}


// ── Blockscout holder count ────────────────────────────────
async function getUniqueHolders(coinAddress: Address): Promise<number> {
  try {
    const resp = await fetch(
      `https://base.blockscout.com/api/v2/tokens/${coinAddress}/counters`,
    );
    if (resp.ok) {
      const data = (await resp.json()) as any;
      return parseInt(data.token_holders_count || "0", 10);
    }
  } catch {}
  return 0;
}

// ── Main ───────────────────────────────────────────────────
async function main() {
  const privateKeyRaw = process.env.ZORA_PRIVATE_KEY!;
  if (!privateKeyRaw) throw new Error("ZORA_PRIVATE_KEY not set");
  const bundlerUrl = process.env.PIMLICO_BASE_BUNDLER_URL!;
  if (!bundlerUrl) throw new Error("PIMLICO_BASE_BUNDLER_URL not set");
  const policyId = process.env.PIMLICO_GAS_POLICY_ID!;
  if (!policyId) throw new Error("PIMLICO_GAS_POLICY_ID not set");

  const rpcUrl = process.env.BASE_RPC_URL || undefined;
  const privateKey = (
    privateKeyRaw.startsWith("0x") ? privateKeyRaw : `0x${privateKeyRaw}`
  ) as Hex;
  const owner = privateKeyToAccount(privateKey);

  const db = new Database(DB_PATH);
  const scorer = new TrendScorer(db);
  const due = scorer.getPostsDueForSell();

  if (due.length === 0) {
    console.log("No trend posts due for sell.");
    db.close();
    return;
  }

  console.log(`Found ${due.length} posts due for sell.`);

  const publicClient = createPublicClient({ chain: base, transport: http(rpcUrl) });
  const account = await toCoinbaseSmartAccount({
    client: publicClient,
    owners: [owner],
    address: SMART_WALLET,
  });

  const bundlerClient = createBundlerClient({
    account,
    chain: base,
    client: publicClient,
    transport: http(bundlerUrl),
    paymaster: true,
    paymasterContext: { sponsorshipPolicyId: policyId },
  });

  const results: Array<{
    id: number; symbol: string; sold: boolean; error?: string;
  }> = [];

  for (const post of due) {
    const coinAddress = post.content_coin_address as Address;
    console.log(`\nEvaluating #${post.id} ($${post.trend_symbol}): ${coinAddress}`);

    if (NEVER_SELL.has(coinAddress.toLowerCase())) {
      console.log(`  ⛔ NEVER_SELL — skipping`);
      results.push({ id: post.id, symbol: post.trend_symbol, sold: false, error: "NEVER_SELL" });
      continue;
    }

    try {
      const balance = await publicClient.readContract({
        address: coinAddress, abi: coinReadAbi,
        functionName: "balanceOf", args: [SMART_WALLET],
      });

      if (balance === 0n) {
        console.log("  No balance — marking as sold.");
        scorer.updatePost(post.id, { status: "sold" });
        results.push({ id: post.id, symbol: post.trend_symbol, sold: true });
        continue;
      }

      const totalSupply = await publicClient.readContract({
        address: coinAddress, abi: coinReadAbi, functionName: "totalSupply",
      });

      const holdPct = Number(balance * 10000n / totalSupply) / 100;
      console.log(`  Balance: ${balance.toString()} (${holdPct.toFixed(2)}% of supply)`);

      const deployedAt = post.deployed_at
        ? new Date(post.deployed_at).getTime()
        : Date.now();
      const hoursSinceDeploy = (Date.now() - deployedAt) / (3600 * 1000);
      console.log(`  Hours since deploy: ${hoursSinceDeploy.toFixed(1)}`);

      const holders = await getUniqueHolders(coinAddress);
      console.log(`  Unique holders: ${holders}`);

      // ── Determine sell percentage ──
      let sellPct: number;
      let reason: string;

      if (hoursSinceDeploy >= 72) {
        sellPct = 90;
        reason = "72h final exit";
      } else if (holders < 3) {
        sellPct = 0;
        reason = `only ${holders} holders, skipping`;
      } else if (holders < 10) {
        sellPct = 25;
        reason = `${holders} holders (light activity)`;
      } else if (holders < 25) {
        sellPct = 50;
        reason = `${holders} holders (moderate activity)`;
      } else {
        sellPct = 75;
        reason = `${holders} holders (good activity)`;
      }

      const maxSellable = balance * 90n / 100n;
      const rawSellAmount = balance * BigInt(sellPct) / 100n;
      const sellAmount =
        sellPct === 0 ? 0n
          : rawSellAmount > maxSellable ? maxSellable
          : rawSellAmount;

      console.log(`  Strategy: sell ${sellPct}% — ${reason}`);

      if (sellAmount === 0n) {
        console.log("  ⏳ Skipping sell (conditions not met).");
        results.push({ id: post.id, symbol: post.trend_symbol, sold: false, error: reason });
        continue;
      }

      console.log(`  Selling ${sellAmount.toString()} tokens...`);

      const tradeParams = {
        sell: { type: "erc20" as const, address: coinAddress },
        buy: { type: "eth" as const },
        amountIn: sellAmount,
        sender: SMART_WALLET,
        recipient: SMART_WALLET,
        slippage: 0.05,
      };

      // Step 1: Initial quote (has REPLACE_WITH_PERMIT_SIGNATURE placeholders)
      let initialQuote: any;
      try {
        initialQuote = await createTradeCall(tradeParams);
      } catch (quoteErr: any) {
        console.error(`  ❌ Quote failed: ${quoteErr.message?.slice(0, 120)}`);
        results.push({ id: post.id, symbol: post.trend_symbol, sold: false, error: `Quote: ${quoteErr.message?.slice(0, 80)}` });
        await new Promise(r => setTimeout(r, 2000));
        continue;
      }

      // Step 2: Sign permits
      const signatures: Array<{ signature: Hex; permit: any }> = [];

      if ((initialQuote as any).permits?.length) {
        for (const permit of (initialQuote as any).permits) {
          const permitToken = permit.permit.details.token as Address;

          // Read current nonce from Permit2 (SDK value may be stale)
          const [, , nonce] = await publicClient.readContract({
            abi: permit2ABI,
            address: PERMIT2,
            functionName: "allowance",
            args: [SMART_WALLET, permitToken, permit.permit.spender as Address],
          });

          const message = {
            details: {
              token: permit.permit.details.token as Address,
              amount: BigInt(permit.permit.details.amount),
              expiration: Number(permit.permit.details.expiration),
              nonce: Number(nonce),
            },
            spender: permit.permit.spender as Address,
            sigDeadline: BigInt(permit.permit.sigDeadline),
          };

          console.log(`  Signing permit for ${permitToken} (nonce: ${nonce})...`);

          // account.signTypedData handles ERC-1271 wrapping for CoinbaseSmartWallet
          const signature = await account.signTypedData({
            domain: { name: "Permit2", chainId: base.id, verifyingContract: PERMIT2 },
            primaryType: "PermitSingle" as const,
            types: PERMIT_SINGLE_TYPES,
            message,
          });

          signatures.push({ signature, permit: convertBigIntToString(message) });
        }
      }

      // Step 3: Final quote with signatures (no more placeholders)
      let finalQuote: any;
      try {
        finalQuote = await createTradeCall({ ...tradeParams, signatures } as any);
      } catch (quoteErr: any) {
        console.error(`  ❌ Final quote failed: ${quoteErr.message?.slice(0, 120)}`);
        results.push({ id: post.id, symbol: post.trend_symbol, sold: false, error: `FinalQuote: ${quoteErr.message?.slice(0, 80)}` });
        await new Promise(r => setTimeout(r, 2000));
        continue;
      }

      const router = finalQuote.call?.target as Address;
      const callData = finalQuote.call?.data as Hex;
      const callValue = BigInt(finalQuote.call?.value || "0");

      if (!router || !callData) {
        console.error("  ❌ No call data from final quote");
        results.push({ id: post.id, symbol: post.trend_symbol, sold: false, error: "Empty final quote" });
        continue;
      }
      if ((callData as string).includes("REPLACE_WITH")) {
        console.error("  ❌ Permit placeholder still in callData — sig injection failed");
        results.push({ id: post.id, symbol: post.trend_symbol, sold: false, error: "Permit placeholder in callData" });
        continue;
      }

      console.log(`  Router: ${router}`);

      // Step 4: Build UserOp — ERC-20 approve + swap
      const calls: Array<{ to: Address; value: bigint; data: Hex }> = [];

      const currentAllowance = await publicClient.readContract({
        abi: erc20Abi, address: coinAddress,
        functionName: "allowance", args: [SMART_WALLET, PERMIT2],
      });
      if (currentAllowance < sellAmount) {
        calls.push({
          to: coinAddress,
          data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [PERMIT2, maxUint256] }),
          value: 0n,
        });
      }
      calls.push({ to: router, data: callData, value: callValue });

      console.log(`  Sending ${calls.length} calls...`);
      const userOpHash = await sendUserOperation(bundlerClient, { account, calls });
      console.log(`  UserOp: ${userOpHash}`);

      const receipt = await waitForUserOperationReceipt(bundlerClient, {
        hash: userOpHash,
        timeout: 120_000,
      });

      if (receipt.success) {
        const remainingBalance = balance - sellAmount;
        const newStatus = remainingBalance <= balance / 10n ? "sold" : "partial_sold";
        console.log(`  ✅ Sold ${sellPct}%. TX: ${receipt.receipt.transactionHash}`);
        console.log(`  Remaining: ${remainingBalance.toString()} (status: ${newStatus})`);
        scorer.updatePost(post.id, { status: newStatus });
        results.push({ id: post.id, symbol: post.trend_symbol, sold: true });
      } else {
        console.log(`  ❌ UserOp failed. TX: ${receipt.receipt.transactionHash}`);
        results.push({ id: post.id, symbol: post.trend_symbol, sold: false, error: "UserOp failed" });
      }
    } catch (err: any) {
      console.error(`  ❌ Error: ${err.message?.slice(0, 150)}`);
      results.push({ id: post.id, symbol: post.trend_symbol, sold: false, error: err.message?.slice(0, 100) });
    }

    await new Promise(r => setTimeout(r, 5000));
  }

  console.log("\nRESULTS:", JSON.stringify(results));

  // ── Preview upcoming sells ──
  const upcoming = scorer.getPostsDueForSellSoon(30);
  if (upcoming.length > 0) {
    console.log("\nNEXT_TURN_PREVIEW:");
    for (const post of upcoming) {
      const holders = await getUniqueHolders(post.content_coin_address as Address);
      const deployedAt = post.deployed_at ? new Date(post.deployed_at).getTime() : Date.now();
      const hoursSinceDeploy = (Date.now() - deployedAt) / (3600 * 1000);
      let projectedPct: number;
      let reason: string;
      if (hoursSinceDeploy + 0.5 >= 72) { projectedPct = 90; reason = "72h final exit"; }
      else if (holders < 3) { projectedPct = 0; reason = `${holders} holders (skip)`; }
      else if (holders < 10) { projectedPct = 25; reason = `${holders} holders (light)`; }
      else if (holders < 25) { projectedPct = 50; reason = `${holders} holders (moderate)`; }
      else { projectedPct = 75; reason = `${holders} holders (good)`; }
      console.log(JSON.stringify({ id: post.id, symbol: post.trend_symbol, coinAddress: post.content_coin_address, sellAfter: post.sell_after, holders, projectedSellPct: projectedPct, reason }));
    }
  } else {
    console.log("\nNEXT_TURN_PREVIEW: none");
  }

  db.close();
}

main().catch(err => {
  console.error("❌ Failed:", err);
  process.exit(1);
});
