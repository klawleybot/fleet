import { privateKeyToAccount } from 'viem/accounts';
import { createPublicClient, http, type Hex } from 'viem';
import { baseSepolia } from 'viem/chains';
import { toCoinbaseSmartAccount } from 'viem/account-abstraction';

async function main() {
  const pk = (process.env.ZORA_PRIVATE_KEY!.startsWith('0x') ? process.env.ZORA_PRIVATE_KEY : '0x' + process.env.ZORA_PRIVATE_KEY) as Hex;
  const account = privateKeyToAccount(pk);
  const client = createPublicClient({ chain: baseSepolia, transport: http() });

  // Let viem compute the SA address (no address override)
  const sa = await toCoinbaseSmartAccount({ client, owners: [account] });
  console.log('Computed SA on Sepolia:', sa.address);
  console.log('Mainnet SA:            ', '0x097677d3e2cde65af10be80ae5e67b8b68eb613d');
  console.log('Match:', sa.address.toLowerCase() === '0x097677d3e2cde65af10be80ae5e67b8b68eb613d');

  const code = await client.getCode({ address: sa.address });
  console.log('Deployed on Sepolia:', !!code && code !== '0x');
  
  const balance = await client.getBalance({ address: sa.address });
  console.log('Balance:', Number(balance) / 1e18, 'ETH');
}
main().catch(console.error);
