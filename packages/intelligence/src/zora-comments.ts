/**
 * Zora Onchain Comments
 *
 * Posts comments on Zora coins via the CommentsImpl contract (0x7777...5877).
 * Comments are onchain transactions, gas-sponsored via Pimlico paymaster.
 *
 * Mentions use markdown link syntax: [@handle](https://zora.co/@address)
 * The Zora UI renders these as clickable profile tags.
 *
 * Uses the CallerAndCommenter contract (0x7777...4B5) which wraps
 * buy/comment into a single call, or the Comments contract directly.
 */

import {
  type Address,
  type Hex,
  createPublicClient,
  http,
  encodeFunctionData,
  parseAbi,
  formatEther,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";
import { toCoinbaseSmartAccount } from "viem/account-abstraction";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** CommentsImpl proxy — deterministic address across all chains */
export const COMMENTS_CONTRACT: Address =
  "0x7777777C2B3132e03a65721a41745C07170a5877";

/** ABI subset we need */
const COMMENTS_ABI = parseAbi([
  "function sparkValue() view returns (uint256)",
  "function comment(address commenter, address contractAddress, uint256 tokenId, string text, (address commenter, address contractAddress, uint256 tokenId, bytes32 nonce) replyTo, address commenterSmartWallet, address referrer) payable returns ((address commenter, address contractAddress, uint256 tokenId, bytes32 nonce))",
]);

/** Zero CommentIdentifier for top-level comments (no reply) */
const EMPTY_REPLY = {
  commenter: "0x0000000000000000000000000000000000000000" as Address,
  contractAddress: "0x0000000000000000000000000000000000000000" as Address,
  tokenId: 0n,
  nonce: "0x0000000000000000000000000000000000000000000000000000000000000000" as Hex,
};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CommentOptions {
  /** Coin contract address to comment on */
  coinAddress: Address;
  /** Comment text (max 280 chars). Use formatMention() for @tags. */
  text: string;
  /** Token ID — 0 for Zora coins (ERC20), non-zero for 1155 tokens */
  tokenId?: bigint;
  /** Reply to an existing comment (optional) */
  replyTo?: {
    commenter: Address;
    contractAddress: Address;
    tokenId: bigint;
    nonce: Hex;
  };
  /** Referrer address for spark rewards (optional) */
  referrer?: Address;
}

export interface CommentResult {
  txHash: Hex;
  sparkValueWei: bigint;
  text: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Format an @mention for Zora comments.
 * Result: [@handle](https://zora.co/@address)
 */
export function formatMention(handle: string, address: string): string {
  return `[@${handle}](https://zora.co/@${address})`;
}

/**
 * Read the current spark value (cost to comment) from the contract.
 */
export async function getSparkValue(
  rpcUrl?: string,
): Promise<bigint> {
  const client = createPublicClient({
    chain: base,
    transport: http(rpcUrl),
  });

  return client.readContract({
    address: COMMENTS_CONTRACT,
    abi: COMMENTS_ABI,
    functionName: "sparkValue",
  });
}

// ---------------------------------------------------------------------------
// Post Comment
// ---------------------------------------------------------------------------

/**
 * Post a comment on a Zora coin via smart wallet + Pimlico gas sponsorship.
 *
 * The commenter is the smart wallet address.
 * Spark value ETH is sent with the transaction (required for non-owners).
 */
export async function postComment(
  opts: CommentOptions,
  privateKey: Hex,
  smartWalletAddress: Address,
): Promise<CommentResult> {
  if (opts.text.length > 280) {
    throw new Error(`Comment too long: ${opts.text.length} chars (max 280)`);
  }
  if (!opts.text.trim()) {
    throw new Error("Comment cannot be empty");
  }

  const rpcUrl = process.env.BASE_RPC_URL;
  const publicClient = createPublicClient({
    chain: base,
    transport: http(rpcUrl),
  });

  // Read spark value
  const sparkValue = await publicClient.readContract({
    address: COMMENTS_CONTRACT,
    abi: COMMENTS_ABI,
    functionName: "sparkValue",
  });

  console.log(`Spark value: ${formatEther(sparkValue)} ETH`);

  // Set up smart account + bundler
  const account = privateKeyToAccount(privateKey);

  const smartAccount = await toCoinbaseSmartAccount({
    client: publicClient,
    owners: [account],
    address: smartWalletAddress,
    version: "1.1",
  });

  // Set up bundler with Pimlico gas sponsorship (inline to avoid cross-package deps)
  const { createBundlerClient, createPaymasterClient } = await import("viem/account-abstraction");

  const bundlerUrl = process.env.PIMLICO_BASE_BUNDLER_URL;
  if (!bundlerUrl) throw new Error("PIMLICO_BASE_BUNDLER_URL is required");

  const gasPolicyId = process.env.PIMLICO_GAS_POLICY_ID?.trim();

  const paymasterOpts = gasPolicyId
    ? {
        paymaster: createPaymasterClient({ transport: http(bundlerUrl) }),
        paymasterContext: { sponsorshipPolicyId: gasPolicyId },
      }
    : {};

  const bundlerClient = createBundlerClient({
    account: smartAccount,
    chain: base,
    client: publicClient,
    transport: http(bundlerUrl),
    ...paymasterOpts,
  });

  // Encode the comment call
  const tokenId = opts.tokenId ?? 0n;
  const replyTo = opts.replyTo ?? EMPTY_REPLY;
  const referrer = opts.referrer ?? ("0x0000000000000000000000000000000000000000" as Address);

  // msg.sender to the Comments contract = smart wallet (via UserOp).
  // comment() sets commentIdentifier.commenter = our `commenter` arg,
  // then _comment checks commentIdentifier.commenter == msg.sender.
  // So commenter MUST be the smart wallet address.
  // Pass smart wallet as commenterSmartWallet too so isOwner() check uses it.
  const eoaAddress = account.address;

  const calldata = encodeFunctionData({
    abi: COMMENTS_ABI,
    functionName: "comment",
    args: [
      smartWalletAddress,    // commenter (must match msg.sender = smart wallet)
      opts.coinAddress,      // contractAddress
      tokenId,               // tokenId
      opts.text,             // text
      replyTo,               // replyTo
      "0x0000000000000000000000000000000000000000" as Address, // commenterSmartWallet (zero = skip ownership check)
      referrer,              // referrer
    ],
  });

  console.log(`Posting comment on ${opts.coinAddress}: "${opts.text.slice(0, 60)}..."`);

  // Send as sponsored UserOp
  const userOpHash = await bundlerClient.sendUserOperation({
    calls: [
      {
        to: COMMENTS_CONTRACT,
        data: calldata,
        value: sparkValue,
      },
    ],
  });

  console.log(`UserOp submitted: ${userOpHash}`);

  const receipt = await bundlerClient.waitForUserOperationReceipt({
    hash: userOpHash,
  });

  if (!receipt.success) {
    throw new Error(`Comment UserOp failed: ${userOpHash}`);
  }

  console.log(`✅ Comment posted! tx: ${receipt.receipt.transactionHash}`);

  return {
    txHash: receipt.receipt.transactionHash,
    sparkValueWei: sparkValue,
    text: opts.text,
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

async function main() {
  const args = process.argv.slice(2);
  let coinAddress = "";
  let text = "";
  let action = "comment"; // default action
  let replyToCommenter = "";
  let replyToContract = "";
  let replyToTokenId = "0";
  let replyToNonce = "";

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--coin" && args[i + 1]) coinAddress = args[++i];
    else if (args[i] === "--text" && args[i + 1]) text = args[++i];
    else if (args[i] === "--comment" && args[i + 1]) text = args[++i];
    else if (args[i] === "--reply-commenter" && args[i + 1]) replyToCommenter = args[++i];
    else if (args[i] === "--reply-contract" && args[i + 1]) replyToContract = args[++i];
    else if (args[i] === "--reply-token-id" && args[i + 1]) replyToTokenId = args[++i];
    else if (args[i] === "--reply-nonce" && args[i + 1]) replyToNonce = args[++i];
    else if (args[i] === "spark-value") action = "spark-value";
  }

  if (action === "spark-value") {
    const sv = await getSparkValue();
    console.log(`Spark value: ${sv} wei (${formatEther(sv)} ETH)`);
    return;
  }

  if (!coinAddress || !text) {
    console.error("Usage:");
    console.error("  zora-comments.ts --coin <address> --text 'your comment'");
    console.error("  zora-comments.ts spark-value");
    process.exit(1);
  }

  let pkRaw = process.env.ZORA_PRIVATE_KEY ?? "";
  if (pkRaw && !pkRaw.startsWith("0x")) pkRaw = `0x${pkRaw}`;
  const pk = pkRaw as Hex;
  /** Smart wallet address for openklaw — the creator of $openklaw coin */
  const sw = (process.env.ZORA_SMART_WALLET ?? "0x097677d3e2cde65af10be80ae5e67b8b68eb613d") as Address;

  if (!pk) {
    console.error("ZORA_PRIVATE_KEY env var required");
    process.exit(1);
  }

  const commentOpts: CommentOptions = { coinAddress: coinAddress as Address, text };
  if (replyToNonce && replyToCommenter) {
    commentOpts.replyTo = {
      commenter: replyToCommenter as Address,
      contractAddress: (replyToContract || coinAddress) as Address,
      tokenId: BigInt(replyToTokenId),
      nonce: replyToNonce as Hex,
    };
  }

  const result = await postComment(
    commentOpts,
    pk,
    sw,
  );

  console.log("\nResult:", JSON.stringify(result, (_, v) =>
    typeof v === "bigint" ? v.toString() : v, 2));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error("Fatal:", err);
    process.exit(1);
  });
}
