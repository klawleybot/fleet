/**
 * Swap all $ZORA → $USDC in Klawley SA via Zora SDK createTradeCall.
 * Two-pass permit flow (proven pattern from klawley-sell-plan.ts).
 *
 * Usage:
 *   doppler run --project openclaw --config prd -- npx tsx packages/server/scripts/klawley-zora-to-usdc.ts [--dry-run]
 */

import {
  createPublicClient, createWalletClient, http, encodeFunctionData, erc20Abi, maxUint256, parseAbi,
  formatUnits, type Address, type Hex,
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
const ZORA_TOKEN = "0x1111111111166b7fe7bd91427724b487980afc69" as Address;
const USDC_TOKEN = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as Address;
const PERMIT2 = permit2Address[base.id] as Address;
const isDryRun = process.argv.includes("--dry-run");

const balanceOfAbi = parseAbi(["function balanceOf(address) view returns (uint256)"]);

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

async function main() {
  console.log(isDryRun ? "🔍 DRY RUN\n" : "🔴 LIVE MODE\n");

  const pk = (process.env.ZORA_PRIVATE_KEY!.startsWith("0x")
    ? process.env.ZORA_PRIVATE_KEY!
    : "0x" + process.env.ZORA_PRIVATE_KEY!) as Hex;
  const owner = privateKeyToAccount(pk);
  const bundlerUrl = process.env.PIMLICO_BASE_BUNDLER_URL!;
  const policyId = process.env.PIMLICO_GAS_POLICY_ID!;

  const rpcUrl = process.env.BASE_RPC_URL || undefined;
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

  // Check ZORA balance
  const zoraBalance = await publicClient.readContract({
    address: ZORA_TOKEN, abi: balanceOfAbi,
    functionName: "balanceOf", args: [SMART_WALLET],
  });

  const usdcBefore = await publicClient.readContract({
    address: USDC_TOKEN, abi: balanceOfAbi,
    functionName: "balanceOf", args: [SMART_WALLET],
  });

  console.log(`ZORA balance: ${formatUnits(zoraBalance, 18)}`);
  console.log(`USDC before:  ${formatUnits(usdcBefore, 6)}`);

  if (zoraBalance === 0n) {
    console.log("No ZORA to swap.");
    return;
  }

  if (isDryRun) {
    console.log(`\nWould swap ${formatUnits(zoraBalance, 18)} ZORA → USDC`);
    console.log("✅ Dry run complete.");
    return;
  }

  // Step 1: Get initial quote (with permit placeholders)
  console.log(`\n🔄 Swapping ${formatUnits(zoraBalance, 18)} ZORA → USDC...`);
  console.log("  Getting quote...");

  const tradeParams = {
    sell: { type: "erc20" as const, address: ZORA_TOKEN },
    buy: { type: "erc20" as const, address: USDC_TOKEN },
    amountIn: zoraBalance,
    sender: SMART_WALLET,
    recipient: SMART_WALLET,
    slippage: 0.05,
  };

  const initialQuote = await createTradeCall(tradeParams);
  console.log("  Initial quote received.");
  console.log("  Permits:", (initialQuote as any).permits?.length ?? 0);

  // Step 2: Sign permits
  const signatures: Array<{ signature: Hex; permit: any }> = [];

  if ((initialQuote as any).permits) {
    for (const permit of (initialQuote as any).permits) {
      const permitToken = permit.permit.details.token as Address;

      // Check current Permit2 nonce
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
    }
  }

  // Step 3: Get final quote with real signatures
  console.log("  Getting final quote with signatures...");
  const finalQuote = await createTradeCall({
    ...tradeParams,
    signatures,
  } as any);

  const router = (finalQuote as any).call?.target as Address;
  const callData = (finalQuote as any).call?.data as Hex;
  const callValue = BigInt((finalQuote as any).call?.value || "0");

  if (!router || !callData) throw new Error("Empty final quote");
  if (callData.includes("REPLACE_WITH")) throw new Error("Signature placeholder still present!");

  console.log(`  Router: ${router}`);
  console.log(`  CallData: ${callData.length} chars`);

  // Step 4: Build UserOp — approve + swap
  const calls: Array<{ to: Address; value: bigint; data: Hex }> = [];

  // Check ERC-20 approval to Permit2
  const currentAllowance = await publicClient.readContract({
    abi: erc20Abi,
    address: ZORA_TOKEN,
    functionName: "allowance",
    args: [SMART_WALLET, PERMIT2],
  });

  if (currentAllowance < zoraBalance) {
    console.log("  Adding ZORA → Permit2 approval");
    calls.push({
      to: ZORA_TOKEN,
      data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [PERMIT2, maxUint256] }),
      value: 0n,
    });
  }

  calls.push({ to: router, data: callData, value: callValue });

  console.log(`  Sending ${calls.length} calls via bundler...`);
  const userOpHash = await sendUserOperation(bundlerClient, { account, calls });
  console.log(`  UserOp: ${userOpHash}`);

  const receipt = await waitForUserOperationReceipt(bundlerClient, { hash: userOpHash, timeout: 120_000 });

  if (receipt.success) {
    console.log(`  ✅ TX: ${receipt.receipt.transactionHash}`);

    // Check final balances
    const zoraAfter = await publicClient.readContract({
      address: ZORA_TOKEN, abi: balanceOfAbi,
      functionName: "balanceOf", args: [SMART_WALLET],
    });
    const usdcAfter = await publicClient.readContract({
      address: USDC_TOKEN, abi: balanceOfAbi,
      functionName: "balanceOf", args: [SMART_WALLET],
    });

    console.log(`\n  ZORA: ${formatUnits(zoraBalance, 18)} → ${formatUnits(zoraAfter, 18)}`);
    console.log(`  USDC: ${formatUnits(usdcBefore, 6)} → ${formatUnits(usdcAfter, 6)}`);
    console.log(`  Net USDC gained: ${formatUnits(usdcAfter - usdcBefore, 6)}`);
  } else {
    console.log(`  ❌ Reverted on-chain. TX: ${receipt.receipt.transactionHash}`);
  }
}

main().catch(err => { console.error("❌", err); process.exit(1); });
