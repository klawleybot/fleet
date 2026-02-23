import {
  encodeFunctionData,
  decodeFunctionResult,
  type Address,
  type Hex,
} from "viem";

const erc20Abi = [
  {
    name: "approve",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    name: "allowance",
    type: "function",
    stateMutability: "view",
    inputs: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

export function encodeApproveCalldata(
  token: Address,
  spender: Address,
  amount: bigint,
): { to: Address; data: Hex; value: bigint } {
  const data = encodeFunctionData({
    abi: erc20Abi,
    functionName: "approve",
    args: [spender, amount],
  });
  return { to: token, data, value: 0n };
}

export function encodeAllowanceCalldata(
  token: Address,
  owner: Address,
  spender: Address,
): { to: Address; data: Hex } {
  const data = encodeFunctionData({
    abi: erc20Abi,
    functionName: "allowance",
    args: [owner, spender],
  });
  return { to: token, data };
}

export function decodeAllowanceResult(data: Hex): bigint {
  return decodeFunctionResult({
    abi: erc20Abi,
    functionName: "allowance",
    data,
  });
}

/** Minimal client interface for reading on-chain state. */
export interface Erc20ReadClient {
  call(args: { to: Address; data: Hex }): Promise<{ data?: Hex | undefined }>;
}

export async function checkAndApprove(params: {
  client: Erc20ReadClient;
  token: Address;
  owner: Address;
  spender: Address;
  amount: bigint;
}): Promise<{ to: Address; data: Hex; value: bigint } | null> {
  const { client, token, owner, spender, amount } = params;

  const allowanceCall = encodeAllowanceCalldata(token, owner, spender);
  const result = await client.call({ to: allowanceCall.to, data: allowanceCall.data });

  if (result.data) {
    const currentAllowance = decodeAllowanceResult(result.data);
    if (currentAllowance >= amount) {
      return null;
    }
  }

  return encodeApproveCalldata(token, spender, amount);
}

// ---------------------------------------------------------------------------
// Permit2 helpers
// ---------------------------------------------------------------------------

/** Canonical Permit2 address (same on all chains). */
export const PERMIT2_ADDRESS: Address = "0x000000000022D473030F116dDEE9F6B43aC78BA3";

const permit2Abi = [
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
  {
    name: "allowance",
    type: "function",
    stateMutability: "view",
    inputs: [
      { name: "owner", type: "address" },
      { name: "token", type: "address" },
      { name: "spender", type: "address" },
    ],
    outputs: [
      { name: "amount", type: "uint160" },
      { name: "expiration", type: "uint48" },
      { name: "nonce", type: "uint48" },
    ],
  },
] as const;

const MAX_UINT160 = (1n << 160n) - 1n;
const MAX_UINT48 = Number((1n << 48n) - 1n);

/**
 * Encode Permit2.approve(token, spender, maxUint160, maxUint48).
 * Sets unlimited allowance with maximum expiry.
 */
export function encodePermit2Approve(
  token: Address,
  spender: Address,
): { to: Address; data: Hex; value: bigint } {
  const data = encodeFunctionData({
    abi: permit2Abi,
    functionName: "approve",
    args: [token, spender, MAX_UINT160, MAX_UINT48],
  });
  return { to: PERMIT2_ADDRESS, data, value: 0n };
}

/**
 * Build the calls needed to enable Permit2 for an ERC20 sell through the Universal Router.
 *
 * Returns 0-2 calls:
 * - ERC20 approve(Permit2, maxUint256) if not already approved
 * - Permit2.approve(token, router, maxUint160, maxUint48) if not already approved
 *
 * These should be prepended to the sell UserOp calls array.
 */
export async function ensurePermit2Approval(params: {
  client: Erc20ReadClient;
  token: Address;
  owner: Address;
  router: Address;
}): Promise<Array<{ to: Address; data: Hex; value: bigint }>> {
  const { client, token, owner, router } = params;
  const calls: Array<{ to: Address; data: Hex; value: bigint }> = [];

  // 1. Check ERC20 allowance for Permit2
  const erc20Check = await checkAndApprove({
    client,
    token,
    owner,
    spender: PERMIT2_ADDRESS,
    // Approve max so we don't need to re-approve for each sell
    amount: MAX_UINT160,
  });
  if (erc20Check) {
    // Approve max uint256 for Permit2
    calls.push(encodeApproveCalldata(token, PERMIT2_ADDRESS, (1n << 256n) - 1n));
  }

  // 2. Check Permit2 allowance for Router
  const permit2AllowanceCall = encodeFunctionData({
    abi: permit2Abi,
    functionName: "allowance",
    args: [owner, token, router],
  });
  const result = await client.call({ to: PERMIT2_ADDRESS, data: permit2AllowanceCall });

  let needPermit2Approve = true;
  if (result.data && result.data.length >= 130) {
    // Decode (uint160 amount, uint48 expiration, uint48 nonce)
    const amount = BigInt("0x" + result.data.slice(2, 42));
    const expiration = BigInt("0x" + result.data.slice(42, 54));
    const now = BigInt(Math.floor(Date.now() / 1000));
    if (amount > 0n && expiration > now) {
      needPermit2Approve = false;
    }
  }

  if (needPermit2Approve) {
    calls.push(encodePermit2Approve(token, router));
  }

  return calls;
}
