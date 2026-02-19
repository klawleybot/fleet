import { createPublicClient, erc20Abi, http } from "viem";
import { getChainConfig } from "./network.js";

const chainCfg = getChainConfig();

const publicClient = createPublicClient({
  chain: chainCfg.chain,
  transport: http(chainCfg.rpcUrl),
});

export async function getEthBalance(address: `0x${string}`): Promise<bigint> {
  return publicClient.getBalance({ address });
}

export async function getErc20Balance(
  tokenAddress: `0x${string}`,
  holderAddress: `0x${string}`,
): Promise<bigint> {
  const balance = await publicClient.readContract({
    address: tokenAddress,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [holderAddress],
  });
  return balance;
}

