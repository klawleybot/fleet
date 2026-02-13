import { createPublicClient, erc20Abi, http } from "viem";
import { base } from "viem/chains";

const transport = process.env.BASE_RPC_URL
  ? http(process.env.BASE_RPC_URL)
  : http();

const publicClient = createPublicClient({
  chain: base,
  transport,
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

