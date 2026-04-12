/**
 * Klawley Sell Plan — Sell CLAWD (50%) and XYEK (excess over 10M).
 *
 * Uses Zora SDK tradeCoin-style flow:
 *  1. createTradeCall() → get quote + permit details
 *  2. Sign Permit2 PermitSingle with SA owner key
 *  3. createTradeCall() again with signatures → get final callData
 *  4. Approve token to Permit2 + submit swap via bundler UserOp
 *
 * Usage:
 *   doppler run --project openclaw --config prd -- bun x tsx packages/server/scripts/klawley-sell-plan.ts [--dry-run]
 */

import {
  createPublicClient, createWalletClient, http, encodeFunctionData, erc20Abi, maxUint256, parseAbi,
  encodeAbiParameters, parseAbiParameters,
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
import { createTradeCall } from "@zoralabs/coins-sdk";
import { permit2ABI, permit2Address } from "@zoralabs/protocol-deployments";

const SMART_WALLET = "0x097677d3e2cde65af10be80ae5e67b8b68eb613d" as Address;
const PERMIT2 = permit2Address[base.id] as Address;
const isDryRun = process.argv.includes("--dry-run");

const balanceOfAbi = parseAbi(["function balanceOf(address) view returns (uint256)"]);

// Permit2 PermitSingle EIP-712 types
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

interface SellOrder {
  symbol: string;
  coinAddress: Address;
  sellAmount: bigint;
}

const ONE_PERCENT = 10_000_000n * 10n ** 18n;

const SELL_ORDERS: SellOrder[] = [
  { symbol: "CLAWD", coinAddress: "0x4d70f5970b0B6b3EDc7c9e6E4Ceb69e8b8F9E642", sellAmount: 5_000_000n * 10n ** 18n },
  { symbol: "XYEK", coinAddress: "0x1dCCC2aDAE82713bD03EedA7f9A8e1640A9e4C75", sellAmount: 0n },
];

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

async function main() {
  console.log(isDryRun ? "🔍 DRY RUN\n" : "🔴 LIVE MODE\n");

  const pk = (process.env.ZORA_PRIVATE_KEY!.startsWith("0x")
    ? process.env.ZORA_PRIVATE_KEY!
    : "0x" + process.env.ZORA_PRIVATE_KEY!) as Hex;
  const owner = privateKeyToAccount(pk);
  const bundlerUrl = process.env.PIMLICO_BASE_BUNDLER_URL!;
  const policyId = process.env.PIMLICO_GAS_POLICY_ID!;

  const publicClient = createPublicClient({ chain: base, transport: http(process.env.BASE_RPC_URL || undefined) });
  const walletClient = createWalletClient({ chain: base, transport: http(process.env.BASE_RPC_URL || undefined), account: owner });

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

  // Resolve balances
  for (const order of SELL_ORDERS) {
    const balance = await publicClient.readContract({
      address: order.coinAddress, abi: balanceOfAbi,
      functionName: "balanceOf", args: [SMART_WALLET],
    });
    if (order.sellAmount === 0n) {
      order.sellAmount = balance > ONE_PERCENT ? balance - ONE_PERCENT : 0n;
    }
    console.log(`${order.symbol.padEnd(8)} | Bal: ${(Number(balance) / 1e18).toFixed(0).padStart(12)} | Sell: ${(Number(order.sellAmount) / 1e18).toFixed(0).padStart(12)} | Keep: ${((Number(balance) - Number(order.sellAmount)) / 1e18).toFixed(0).padStart(12)}`);
  }

  const activeSells = SELL_ORDERS.filter(o => o.sellAmount > 0n);
  console.log(`\n${activeSells.length} sells.\n`);
  if (isDryRun) { console.log("✅ Dry run."); return; }

  for (const order of activeSells) {
    console.log(`🔄 ${order.symbol}...`);
    try {
      const tradeParams = {
        sell: { type: "erc20" as const, address: order.coinAddress },
        buy: { type: "eth" as const },
        amountIn: order.sellAmount,
        sender: SMART_WALLET,
        recipient: SMART_WALLET,
        slippage: 0.05,
      };

      // Step 1: Get initial quote (with permit placeholders)
      console.log(`  Getting quote...`);
      const initialQuote = await createTradeCall(tradeParams);

      // Step 2: Sign permits
      const signatures: Array<{ signature: Hex; permit: any }> = [];

      if ((initialQuote as any).permits) {
        for (const permit of (initialQuote as any).permits) {
          const permitToken = permit.permit.details.token as Address;

          // Check if token is approved to Permit2, approve if not
          const allowance = await publicClient.readContract({
            abi: erc20Abi,
            address: permitToken,
            functionName: "allowance",
            args: [SMART_WALLET, PERMIT2],
          });

          // Get current nonce from Permit2
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

          console.log(`  Signing permit for ${permitToken}...`);

          // Sign with the smart account (handles CoinbaseSmartWallet ERC-1271 wrapping)
          const signature = await account.signTypedData({
            domain: {
              name: "Permit2",
              chainId: base.id,
              verifyingContract: PERMIT2,
            },
            primaryType: "PermitSingle" as const,
            types: PERMIT_SINGLE_TYPES,
            message,
          });

          signatures.push({
            signature,
            permit: convertBigIntToString(message),
          });

          // If token needs approval to Permit2, we'll batch it in the UserOp
          if (allowance < BigInt(permit.permit.details.amount)) {
            console.log(`  Token needs Permit2 approval (will batch)`);
          }
        }
      }

      // Step 3: Get final quote with real signatures
      console.log(`  Getting final quote with signatures...`);
      const finalQuote = await createTradeCall({
        ...tradeParams,
        signatures,
      } as any);

      const router = (finalQuote as any).call?.target as Address;
      const callData = (finalQuote as any).call?.data as Hex;
      const callValue = BigInt((finalQuote as any).call?.value || "0");

      if (!router || !callData) throw new Error("Empty final quote");
      if (callData.includes("REPLACE_WITH")) throw new Error("Signature placeholder still present in callData!");

      console.log(`  Router: ${router}`);
      console.log(`  CallData: ${callData.length} chars, valid hex: ${/^0x[0-9a-fA-F]*$/.test(callData)}`);

      // Step 4: Build UserOp — approve + swap
      const calls: Array<{ to: Address; value: bigint; data: Hex }> = [];

      // Check if we need ERC-20 approve to Permit2
      const currentAllowance = await publicClient.readContract({
        abi: erc20Abi,
        address: order.coinAddress,
        functionName: "allowance",
        args: [SMART_WALLET, PERMIT2],
      });
      if (currentAllowance < order.sellAmount) {
        calls.push({
          to: order.coinAddress,
          data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [PERMIT2, maxUint256] }),
          value: 0n,
        });
      }

      // The swap call (with real permit signatures baked in)
      calls.push({ to: router, data: callData, value: callValue });

      console.log(`  Sending ${calls.length} calls...`);
      const userOpHash = await sendUserOperation(bundlerClient, { account, calls });
      console.log(`  UserOp: ${userOpHash}`);

      const receipt = await waitForUserOperationReceipt(bundlerClient, { hash: userOpHash, timeout: 120_000 });
      if (receipt.success) {
        console.log(`  ✅ TX: ${receipt.receipt.transactionHash}`);
      } else {
        console.log(`  ❌ Reverted on-chain`);
      }
    } catch (err: any) {
      console.error(`  ❌ ${err.message?.slice(0, 300)}`);
    }
    await new Promise(r => setTimeout(r, 5000));
  }
}

main().catch(err => { console.error("❌", err); process.exit(1); });
