import { createPublicClient, http, formatEther, formatUnits, parseAbi } from 'viem';
import { base } from 'viem/chains';

async function main() {
  const SA = '0x097677d3e2cde65af10be80ae5e67b8b68eb613d' as const;
  const ZORA = '0x1111111111166b7fe7bd91427724b487980afc69' as const;
  const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' as const;
  const rpc = process.env.BASE_RPC_URL!;
  if (!rpc) throw new Error('BASE_RPC_URL not set');
  const client = createPublicClient({ chain: base, transport: http(rpc) });
  const abi = parseAbi([
    'function balanceOf(address) view returns (uint256)',
    'function decimals() view returns (uint8)',
    'function symbol() view returns (string)',
  ]);

  const eth = await client.getBalance({ address: SA });
  console.log(`ETH: ${formatEther(eth)}`);

  for (const token of [ZORA, USDC]) {
    const [bal, dec, sym] = await Promise.all([
      client.readContract({ address: token, abi, functionName: 'balanceOf', args: [SA] }),
      client.readContract({ address: token, abi, functionName: 'decimals' }),
      client.readContract({ address: token, abi, functionName: 'symbol' }),
    ]);
    console.log(`${sym}: ${formatUnits(bal, dec)}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
