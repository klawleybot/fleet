/**
 * Direct V3 swap via Universal Router.
 * Usage: klawley-swap-v3.ts <fromToken> <toToken> <amount> [feeTier] [slippageBps] [decimals]
 * Example: klawley-swap-v3.ts 0x1111...afc69 0x8335...2913 500 500 500 18
 */
import {
  createPublicClient,
  http,
  parseUnits,
  formatUnits,
  encodeFunctionData,
  encodeAbiParameters,
  type Address,
  type Hex,
  concat,
  pad,
  numberToHex,
} from "viem";
import { base } from "viem/chains";
import { sendUserOperationFromSmartAccount, KLAWLEY_ACCOUNT_NAME, KLAWLEY_SMART_WALLET } from "../src/services/cdp.js";

const UNIVERSAL_ROUTER = "0x6ff5693b99212da76ad316178a184ab56d299b43" as const;
const PERMIT2 = "0x000000000022D473030F116dDEE9F6B43aC78BA3" as const;

// V3 path encoding: token(20) + fee(3) + token(20)
function encodeV3Path(tokens: Address[], fees: number[]): Hex {
  let path = tokens[0]!.toLowerCase() as string;
  for (let i = 0; i < fees.length; i++) {
    // fee is uint24 = 3 bytes
    path += fees[i]!.toString(16).padStart(6, "0");
    path += tokens[i + 1]!.toLowerCase().slice(2);
  }
  return path as Hex;
}

// Universal Router command IDs
const V3_SWAP_EXACT_INPUT = 0x00;
const PERMIT2_PERMIT = 0x0a;

const executeAbi = [
  {
    name: "execute",
    type: "function",
    stateMutability: "payable",
    inputs: [
      { name: "commands", type: "bytes" },
      { name: "inputs", type: "bytes[]" },
      { name: "deadline", type: "uint256" },
    ],
    outputs: [],
  },
] as const;

const erc20Abi = [
  { name: "allowance", type: "function", stateMutability: "view", inputs: [{ name: "owner", type: "address" }, { name: "spender", type: "address" }], outputs: [{ name: "", type: "uint256" }] },
  { name: "approve", type: "function", stateMutability: "nonpayable", inputs: [{ name: "spender", type: "address" }, { name: "amount", type: "uint256" }], outputs: [{ name: "", type: "bool" }] },
  { name: "balanceOf", type: "function", stateMutability: "view", inputs: [{ name: "account", type: "address" }], outputs: [{ name: "", type: "uint256" }] },
] as const;

const permit2Abi = [
  { name: "allowance", type: "function", stateMutability: "view", inputs: [{ name: "owner", type: "address" }, { name: "token", type: "address" }, { name: "spender", type: "address" }], outputs: [{ name: "amount", type: "uint160" }, { name: "expiration", type: "uint48" }, { name: "nonce", type: "uint48" }] },
] as const;

// Uniswap V3 Quoter V2 on Base
const QUOTER_V2 = "0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a" as const;
const quoterAbi = [
  {
    name: "quoteExactInputSingle",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      {
        name: "params",
        type: "tuple",
        components: [
          { name: "tokenIn", type: "address" },
          { name: "tokenOut", type: "address" },
          { name: "amountIn", type: "uint256" },
          { name: "fee", type: "uint24" },
          { name: "sqrtPriceLimitX96", type: "uint160" },
        ],
      },
    ],
    outputs: [
      { name: "amountOut", type: "uint256" },
      { name: "sqrtPriceX96After", type: "uint160" },
      { name: "initializedTicksCrossed", type: "uint32" },
      { name: "gasEstimate", type: "uint256" },
    ],
  },
] as const;

async function main() {
  const fromToken = (process.argv[2] || "0x1111111111166b7fe7bd91427724b487980afc69") as Address;
  const toToken = (process.argv[3] || "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913") as Address;
  const amount = process.argv[4] || "500";
  const feeTier = parseInt(process.argv[5] || "3000");
  const slippageBps = parseInt(process.argv[6] || "500");
  const decimals = parseInt(process.argv[7] || "18");

  const client = createPublicClient({
    chain: base,
    transport: http(process.env.BASE_RPC_URL || undefined),
  });

  const amountIn = parseUnits(amount, decimals);
  console.log(`Swapping ${amount} (${decimals} decimals) via V3`);
  console.log(`  From: ${fromToken}`);
  console.log(`  To:   ${toToken}`);
  console.log(`  Fee tier: ${feeTier}`);
  console.log(`  Slippage: ${slippageBps} bps`);
  console.log(`  SA: ${KLAWLEY_SMART_WALLET}`);

  // 1. Check balance
  const balance = await client.readContract({
    address: fromToken,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [KLAWLEY_SMART_WALLET],
  });
  console.log(`\nBalance: ${formatUnits(balance, decimals)}`);
  if (balance < amountIn) {
    throw new Error(`Insufficient balance: have ${formatUnits(balance, decimals)}, need ${amount}`);
  }

  // 2. Quote
  console.log("\nQuoting...");
  let quotedOut: bigint;
  try {
    const quoteResult = await client.simulateContract({
      address: QUOTER_V2,
      abi: quoterAbi,
      functionName: "quoteExactInputSingle",
      args: [{
        tokenIn: fromToken,
        tokenOut: toToken,
        amountIn,
        fee: feeTier,
        sqrtPriceLimitX96: 0n,
      }],
    });
    quotedOut = quoteResult.result[0];
    console.log(`Quoted output: ${formatUnits(quotedOut, 6)} (raw: ${quotedOut})`);
  } catch (err: any) {
    console.error("Quote failed:", err.message?.slice(0, 200));
    throw err;
  }

  const minOut = quotedOut * BigInt(10000 - slippageBps) / 10000n;
  console.log(`Min output (${slippageBps}bps slippage): ${formatUnits(minOut, 6)}`);

  // 3. Check Permit2 allowance from SA → token
  const [erc20Allowance] = await Promise.all([
    client.readContract({
      address: fromToken,
      abi: erc20Abi,
      functionName: "allowance",
      args: [KLAWLEY_SMART_WALLET, PERMIT2],
    }),
  ]);
  console.log(`\nERC20 allowance to Permit2: ${formatUnits(erc20Allowance, decimals)}`);

  // 4. Check Permit2 allowance to Universal Router
  const [permit2Amount, permit2Expiration] = await client.readContract({
    address: PERMIT2,
    abi: permit2Abi,
    functionName: "allowance",
    args: [KLAWLEY_SMART_WALLET, fromToken, UNIVERSAL_ROUTER],
  });
  console.log(`Permit2 allowance to Router: ${permit2Amount} (exp: ${permit2Expiration})`);

  // Build UserOp calls
  const calls: Array<{ to: Address; value: bigint; data?: Hex }> = [];

  // Approve Permit2 if needed
  const MAX_UINT256 = 2n ** 256n - 1n;
  if (erc20Allowance < amountIn) {
    console.log("\nApproving Permit2...");
    calls.push({
      to: fromToken,
      value: 0n,
      data: encodeFunctionData({
        abi: erc20Abi,
        functionName: "approve",
        args: [PERMIT2, MAX_UINT256],
      }),
    });
  }

  // Approve Universal Router on Permit2 if needed
  const now = BigInt(Math.floor(Date.now() / 1000));
  if (permit2Amount < BigInt(amountIn) || permit2Expiration < now + 300n) {
    console.log("Approving Router on Permit2...");
    // Permit2.approve(token, spender, amount, expiration)
    const permit2ApproveAbi = [
      {
        name: "approve",
        type: "function",
        stateMutability: "nonpayable",
        inputs: [
          { name: "token", type: "address" },
          { name: "spender", type: "address" },
          { name: "amount", type: "uint160" },
          { name: "expiration", type: "uint48" },
        ],
        outputs: [],
      },
    ] as const;
    calls.push({
      to: PERMIT2,
      value: 0n,
      data: encodeFunctionData({
        abi: permit2ApproveAbi,
        functionName: "approve",
        args: [
          fromToken,
          UNIVERSAL_ROUTER,
          BigInt("0xffffffffffffffffffffffffffffffffffffffff"), // max uint160
          BigInt(Math.floor(Date.now() / 1000) + 86400 * 30), // 30 days
        ],
      }),
    });
  }

  // 5. Encode V3 swap via Universal Router
  const v3Path = encodeV3Path([fromToken, toToken], [feeTier]);
  console.log(`\nV3 path: ${v3Path}`);

  // V3_SWAP_EXACT_INPUT input: abi.encode(address recipient, uint256 amountIn, uint256 amountOutMin, bytes path, bool payerIsUser)
  // recipient = 0x01 means MSG_SENDER (the SA)
  // recipient = 0x02 means ADDRESS_THIS (the router)
  // For ERC20 → ERC20, recipient should be the SA address directly
  const v3SwapInput = encodeAbiParameters(
    [
      { name: "recipient", type: "address" },
      { name: "amountIn", type: "uint256" },
      { name: "amountOutMinimum", type: "uint256" },
      { name: "path", type: "bytes" },
      { name: "payerIsUser", type: "bool" },
    ],
    [
      KLAWLEY_SMART_WALLET, // recipient = our SA
      amountIn,
      minOut,
      v3Path,
      true, // payerIsUser = true (Permit2 pulls from SA)
    ],
  );

  const commands = `0x${Buffer.from([V3_SWAP_EXACT_INPUT]).toString("hex")}` as Hex;
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 1800);

  const routerCalldata = encodeFunctionData({
    abi: executeAbi,
    functionName: "execute",
    args: [commands, [v3SwapInput], deadline],
  });

  calls.push({
    to: UNIVERSAL_ROUTER,
    value: 0n,
    data: routerCalldata,
  });

  console.log(`\nSending UserOp with ${calls.length} calls...`);
  const result = await sendUserOperationFromSmartAccount({
    smartAccountName: KLAWLEY_ACCOUNT_NAME,
    calls,
  });

  console.log(`\nUserOp: ${result.userOpHash}`);
  console.log(`Tx: ${result.txHash} (status: ${result.status})`);

  // Check final balance
  const usdcBal = await client.readContract({
    address: toToken,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [KLAWLEY_SMART_WALLET],
  });
  console.log(`\nFinal USDC balance: ${formatUnits(usdcBal, 6)}`);
}

main().catch((err) => {
  console.error("Error:", err.message || err);
  process.exit(1);
});
