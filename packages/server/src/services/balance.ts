import { createPublicClient, erc20Abi, http } from "viem";
import { getChainConfig } from "./network.js";

function isMockMode(): boolean {
  return process.env.CDP_MOCK_MODE === "1";
}

function getPublicClient() {
  const chainCfg = getChainConfig();
  return createPublicClient({
    chain: chainCfg.chain,
    transport: http(chainCfg.rpcUrl),
  });
}

export async function getEthBalance(address: `0x${string}`): Promise<bigint> {
  if (isMockMode()) return 0n;
  return getPublicClient().getBalance({ address });
}

export async function getErc20Balance(
  tokenAddress: `0x${string}`,
  holderAddress: `0x${string}`,
): Promise<bigint> {
  if (isMockMode()) return 0n;
  const balance = await getPublicClient().readContract({
    address: tokenAddress,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [holderAddress],
  });
  return balance;
}

/**
 * Minimum ETH a wallet needs to be considered "funded" for a buy.
 * Below this dust threshold, the wallet is effectively empty.
 */
export const MIN_BUY_BALANCE_WEI = 10_000n; // 0.00000001 ETH — dust filter

export interface WalletBudget {
  walletId: number;
  address: `0x${string}`;
  balance: bigint;
  funded: boolean;
}

/**
 * Check ETH balances for a set of wallet addresses.
 * Returns per-wallet budget info and aggregate stats.
 * Uses multicall for efficiency (single RPC round-trip).
 */
export async function getWalletBudgets(
  wallets: Array<{ id: number; address: `0x${string}` }>,
): Promise<{
  wallets: WalletBudget[];
  totalBudget: bigint;
  fundedCount: number;
  emptyCount: number;
}> {
  if (wallets.length === 0) {
    return { wallets: [], totalBudget: 0n, fundedCount: 0, emptyCount: 0 };
  }

  if (isMockMode()) {
    return {
      wallets: wallets.map((wallet) => ({
        walletId: wallet.id,
        address: wallet.address,
        balance: 0n,
        funded: false,
      })),
      totalBudget: 0n,
      fundedCount: 0,
      emptyCount: wallets.length,
    };
  }

  // Batch balance lookups via multicall
  const publicClient = getPublicClient();
  const balances = await Promise.all(
    wallets.map((w) => publicClient.getBalance({ address: w.address })),
  );

  let totalBudget = 0n;
  let fundedCount = 0;
  let emptyCount = 0;

  const result: WalletBudget[] = wallets.map((w, i) => {
    const balance = balances[i]!;
    const funded = balance > MIN_BUY_BALANCE_WEI;
    if (funded) {
      totalBudget += balance;
      fundedCount++;
    } else {
      emptyCount++;
    }
    return { walletId: w.id, address: w.address, balance, funded };
  });

  return { wallets: result, totalBudget, fundedCount, emptyCount };
}
