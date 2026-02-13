import { CdpClient } from "@coinbase/cdp-sdk";
import { isAddress, isHash } from "viem";

const OWNER_ACCOUNT_NAME = "fleet-owner";
const MASTER_SMART_ACCOUNT_NAME = "master";
const DEFAULT_NETWORK = "base";

export type SupportedNetwork = typeof DEFAULT_NETWORK;

const cdp = new CdpClient();

type OwnerAccount = Awaited<ReturnType<typeof cdp.evm.getOrCreateAccount>>;

export interface EvmAccountRef {
  address: `0x${string}`;
  name?: string;
}

export interface SmartAccountRef {
  address: `0x${string}`;
  name?: string;
}

function assertAddress(value: string, context: string): `0x${string}` {
  if (!isAddress(value)) {
    throw new Error(`Invalid address in ${context}: ${value}`);
  }
  return value;
}

function assertHash(value: string, context: string): `0x${string}` {
  if (!isHash(value)) {
    throw new Error(`Invalid hash in ${context}: ${value}`);
  }
  return value;
}

export async function getOrCreateOwnerAccount(): Promise<EvmAccountRef> {
  const account = await cdp.evm.getOrCreateAccount({ name: OWNER_ACCOUNT_NAME });
  return {
    address: assertAddress(account.address, "owner account"),
    name: OWNER_ACCOUNT_NAME,
  };
}

async function getOwnerAccountInternal(): Promise<OwnerAccount> {
  return cdp.evm.getOrCreateAccount({ name: OWNER_ACCOUNT_NAME });
}

export async function createSmartAccount(
  name: string,
): Promise<{ owner: EvmAccountRef; smartAccount: SmartAccountRef }> {
  const ownerAccount = await getOwnerAccountInternal();
  const smartAccount = await cdp.evm.createSmartAccount({
    owner: ownerAccount,
    name,
  });

  return {
    owner: {
      address: assertAddress(ownerAccount.address, "owner account"),
      name: OWNER_ACCOUNT_NAME,
    },
    smartAccount: {
      address: assertAddress(smartAccount.address, `smart account ${name}`),
      name,
    },
  };
}

export async function getOrCreateMasterSmartAccount(): Promise<{
  owner: EvmAccountRef;
  smartAccount: SmartAccountRef;
}> {
  const ownerAccount = await getOwnerAccountInternal();
  const smartAccount = await cdp.evm.getOrCreateSmartAccount({
    name: MASTER_SMART_ACCOUNT_NAME,
    owner: ownerAccount,
  });

  return {
    owner: {
      address: assertAddress(ownerAccount.address, "owner account"),
      name: OWNER_ACCOUNT_NAME,
    },
    smartAccount: {
      address: assertAddress(smartAccount.address, "master smart account"),
      name: MASTER_SMART_ACCOUNT_NAME,
    },
  };
}

export async function getOrCreateSmartAccountByName(
  name: string,
): Promise<{ owner: EvmAccountRef; smartAccount: SmartAccountRef }> {
  const ownerAccount = await getOwnerAccountInternal();
  const smartAccount = await cdp.evm.getOrCreateSmartAccount({
    name,
    owner: ownerAccount,
  });

  return {
    owner: {
      address: assertAddress(ownerAccount.address, "owner account"),
      name: OWNER_ACCOUNT_NAME,
    },
    smartAccount: {
      address: assertAddress(smartAccount.address, `smart account ${name}`),
      name,
    },
  };
}

export async function transferFromSmartAccount(input: {
  smartAccountName: string;
  to: `0x${string}`;
  amountWei: bigint;
  network?: SupportedNetwork;
}): Promise<{ userOpHash: `0x${string}`; txHash: `0x${string}` | null; status: string }> {
  const owner = await getOwnerAccountInternal();
  const smartAccount = await cdp.evm.getOrCreateSmartAccount({
    name: input.smartAccountName,
    owner,
  });

  const transferResult = await smartAccount.transfer({
    to: input.to,
    amount: input.amountWei,
    token: "eth",
    network: input.network ?? DEFAULT_NETWORK,
  });

  const userOpHash = assertHash(transferResult.userOpHash, "transfer userOpHash");
  const receipt = await smartAccount.waitForUserOperation({ userOpHash });
  const txHash = receipt.transactionHash ? assertHash(receipt.transactionHash, "transfer txHash") : null;

  return {
    userOpHash,
    txHash,
    status: receipt.status,
  };
}

export async function swapFromSmartAccount(input: {
  smartAccountName: string;
  fromToken: `0x${string}`;
  toToken: `0x${string}`;
  fromAmount: bigint;
  slippageBps: number;
  network?: SupportedNetwork;
}): Promise<{ userOpHash: `0x${string}`; txHash: `0x${string}` | null; status: string }> {
  const owner = await getOwnerAccountInternal();
  const smartAccount = await cdp.evm.getOrCreateSmartAccount({
    name: input.smartAccountName,
    owner,
  });

  const swapResult = await smartAccount.swap({
    network: input.network ?? DEFAULT_NETWORK,
    fromToken: input.fromToken,
    toToken: input.toToken,
    fromAmount: input.fromAmount,
    slippageBps: input.slippageBps,
  });

  const userOpHash = assertHash(swapResult.userOpHash, "swap userOpHash");
  const receipt = await smartAccount.waitForUserOperation({ userOpHash });
  const txHash = receipt.transactionHash ? assertHash(receipt.transactionHash, "swap txHash") : null;

  return {
    userOpHash,
    txHash,
    status: receipt.status,
  };
}

export async function sendUserOperationFromSmartAccount(input: {
  smartAccountName: string;
  calls: Array<{
    to: `0x${string}`;
    data: `0x${string}`;
    value: bigint;
  }>;
  network?: SupportedNetwork;
}): Promise<{ userOpHash: `0x${string}`; txHash: `0x${string}` | null; status: string }> {
  const owner = await getOwnerAccountInternal();
  const smartAccount = await cdp.evm.getOrCreateSmartAccount({
    name: input.smartAccountName,
    owner,
  });

  const opResult = await cdp.evm.sendUserOperation({
    smartAccount,
    network: input.network ?? DEFAULT_NETWORK,
    calls: input.calls,
  });

  const userOpHash = assertHash(opResult.userOpHash, "user operation hash");
  const receipt = await smartAccount.waitForUserOperation({ userOpHash });
  const txHash = receipt.transactionHash ? assertHash(receipt.transactionHash, "user operation txHash") : null;

  return {
    userOpHash,
    txHash,
    status: receipt.status,
  };
}

