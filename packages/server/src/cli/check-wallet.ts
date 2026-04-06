import { createPublicClient, http } from "viem";
import type { PublicClient as ReadPublicClient } from "viem";
import { base } from "viem/chains";
import { isOwnerAddress, getOwnerCount, getNextOwnerIndex, getOwnerAtIndex } from "../services/walletMigration.js";

async function main() {
  const client = createPublicClient({ chain: base, transport: http(process.env.BASE_RPC_URL) }) as ReadPublicClient;
  const wallet = "0x0bc571f8887ee177f8923176030b2e3f60a76f20" as `0x${string}`;

  const count = await getOwnerCount(client, wallet);
  const nextIdx = await getNextOwnerIndex(client, wallet);
  console.log("Owner count:", count.toString());
  console.log("Next index:", nextIdx.toString());

  for (let i = 0n; i < nextIdx; i++) {
    try {
      const owner = await getOwnerAtIndex(client, wallet, i);
      console.log(`Index ${i} →`, owner);
    } catch {
      console.log(`Index ${i} → empty`);
    }
  }

  console.log("Old (0xA535...) is owner:", await isOwnerAddress(client, wallet, "0xA53581B8Ad325a2a3aF011bCE1b8322AbbaD762c"));
  console.log("New (0x78D1...) is owner:", await isOwnerAddress(client, wallet, "0x78D13a013770BaC9Ae1E279806054D84e4c4BB8A"));
}

main().catch(console.error);
