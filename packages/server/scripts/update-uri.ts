import { createPublicClient, http, encodeFunctionData, type Address, type Hex } from "viem";
import { base } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import { toCoinbaseSmartAccount } from "viem/account-abstraction";
import { createSponsoredBundlerClient } from "../src/services/bundler/config.js";

const GMR: Address = "0xa7cB6756e346a8FA844C7e2a617457dcE19A63B9";
const SMART_WALLET: Address = "0x097677d3e2cde65af10be80ae5e67b8b68eb613d";
const NEW_URI = "https://gateway.irys.xyz/BZnxCpTqy1Riy7PBsybb9TV9UKwaXKP6pT7aKLSkpwH4";

const setContractURIAbi = [{
  name: "setContractURI",
  type: "function",
  stateMutability: "nonpayable",
  inputs: [{ name: "newURI", type: "string" }],
  outputs: [],
}] as const;

async function main() {
  const pk = (process.env.ZORA_PRIVATE_KEY!.startsWith("0x")
    ? process.env.ZORA_PRIVATE_KEY!
    : "0x" + process.env.ZORA_PRIVATE_KEY!) as Hex;
  const owner = privateKeyToAccount(pk);

  const client = createPublicClient({ chain: base, transport: http(process.env.BASE_RPC_URL) });

  const smartAccount = await toCoinbaseSmartAccount({
    client,
    owners: [owner],
    address: SMART_WALLET,
  });

  console.log("Smart account:", smartAccount.address);
  console.log("Updating contractURI to:", NEW_URI);

  const bundlerClient = createSponsoredBundlerClient({
    account: smartAccount,
    chain: base,
    client,
  });

  const callData = encodeFunctionData({
    abi: setContractURIAbi,
    functionName: "setContractURI",
    args: [NEW_URI],
  });

  const userOpHash = await bundlerClient.sendUserOperation({
    calls: [{ to: GMR, data: callData, value: 0n }],
  });

  console.log("UserOp:", userOpHash);

  const receipt = await bundlerClient.waitForUserOperationReceipt({
    hash: userOpHash,
  });

  console.log("✅ TX:", receipt.receipt.transactionHash);
  console.log("Status:", receipt.receipt.status);

  // Verify
  const curiAbi = [{ name: "contractURI", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] }] as const;
  const newUri = await client.readContract({ address: GMR, abi: curiAbi, functionName: "contractURI" });
  console.log("Verified contractURI:", newUri);
}

main().catch(console.error);
