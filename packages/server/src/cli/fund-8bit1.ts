import { getFleetByName } from "../services/fleet.js";
import { transferFromSmartAccount, getOrCreateMasterSmartAccount } from "../services/cdp.js";
import { parseEther, type Address } from "viem";

async function main() {
  const fleet = getFleetByName("8bit-1");
  if (!fleet) throw new Error("Fleet not found");
  const wallet = fleet.wallets.find((w: any) => w.address === "0x869CcdcA4033390A088dEf79850F191D05a1042d");
  if (!wallet) throw new Error("Wallet not found");

  const { smartAccount: master } = await getOrCreateMasterSmartAccount();
  console.log(`Funding ${wallet.name} (${wallet.address})...`);
  const result = await transferFromSmartAccount({
    smartAccountName: master.name!,
    to: wallet.address as Address,
    amountWei: parseEther("0.005"),
  });
  console.log(`✅ tx: ${result.txHash}`);
}
main().catch(e => { console.error(e); process.exit(1); });
