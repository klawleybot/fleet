import { createPublicClient, http, parseAbi, type Address } from "viem";
import { base } from "viem/chains";

const client = createPublicClient({ chain: base, transport: http(process.env.BASE_RPC_URL || undefined) });
const abi = parseAbi([
  "function currency() view returns (address)",
  "function totalSupply() view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
]);

const ZORA = "0x1111111111166b7fe7bd91427724b487980afc69";
const SA = "0x097677d3e2cde65af10be80ae5e67b8b68eb613d";

async function main() {
  const coin = process.argv[2] as Address;
  if (!coin) { console.error("Usage: check-coin.ts <address>"); process.exit(1); }

  const currency = await client.readContract({ address: coin, abi, functionName: "currency" });
  const supply = await client.readContract({ address: coin, abi, functionName: "totalSupply" });
  const balance = await client.readContract({ address: coin, abi, functionName: "balanceOf", args: [SA as Address] });
  
  console.log("Coin:", coin);
  console.log("Currency:", currency);
  console.log("TotalSupply:", supply.toString());
  console.log("SA balance:", balance.toString());

  // Check SA balance of the currency too
  const currBal = await client.readContract({ address: currency as Address, abi, functionName: "balanceOf", args: [SA as Address] });
  console.log("SA currency balance:", currBal.toString());
  
  // Check ZORA balance
  const zoraBal = await client.readContract({ address: ZORA as Address, abi, functionName: "balanceOf", args: [SA as Address] });
  console.log("SA ZORA balance:", zoraBal.toString());
}

main();
