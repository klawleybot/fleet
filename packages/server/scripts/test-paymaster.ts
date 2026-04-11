import { createPublicClient, http } from "viem";
import { base } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import { toCoinbaseSmartAccount, createBundlerClient, sendUserOperation, waitForUserOperationReceipt } from "viem/account-abstraction";
import type { Address, Hex } from "viem";

async function main() {
  const pk = (process.env.ZORA_PRIVATE_KEY!.startsWith("0x") ? process.env.ZORA_PRIVATE_KEY! : "0x" + process.env.ZORA_PRIVATE_KEY!) as Hex;
  const owner = privateKeyToAccount(pk);
  const publicClient = createPublicClient({ chain: base, transport: http() });
  const account = await toCoinbaseSmartAccount({ client: publicClient, owners: [owner], address: "0x097677d3e2cde65af10be80ae5e67b8b68eb613d" as Address });

  const bundlerUrl = process.env.PIMLICO_BASE_BUNDLER_URL!;
  const policyId = process.env.PIMLICO_GAS_POLICY_ID!;
  console.log("Bundler URL:", bundlerUrl);
  console.log("Policy:", policyId);

  const bundlerClient = createBundlerClient({
    account, chain: base, client: publicClient,
    transport: http(bundlerUrl),
    paymaster: true,
    paymasterContext: { sponsorshipPolicyId: policyId },
  });

  // Simple approve call
  console.log("Sending test UserOp...");
  const hash = await sendUserOperation(bundlerClient, {
    account,
    calls: [{
      to: "0x4d70f5970b0B6b3EDc7c9e6E4Ceb69e8b8F9E642" as Address,
      data: "0x095ea7b30000000000000000000000000000000000000000000000000000000000000001ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff" as Hex,
      value: 0n,
    }],
  });
  console.log("UserOp:", hash);
  const receipt = await waitForUserOperationReceipt(bundlerClient, { hash, timeout: 60_000 });
  console.log("Success:", receipt.success, "TX:", receipt.receipt?.transactionHash);
}

main().catch(err => { console.error("Error:", err.message?.slice(0, 200)); process.exit(1); });
