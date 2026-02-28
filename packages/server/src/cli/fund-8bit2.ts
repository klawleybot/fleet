import { getFleetByName } from "../services/fleet.js";
import { transferFromSmartAccount, getOrCreateMasterSmartAccount } from "../services/cdp.js";
import { parseEther, type Address } from "viem";

async function main() {
  const fleet = getFleetByName("8bit-2");
  if (!fleet) throw new Error("Fleet not found");
  const wallet = fleet.wallets.find((w: any) => w.address === "0xc441ce45E514EDA79Db1b3f76b1EF5b2a4F4d260");
  if (!wallet) throw new Error("Wallet not found");
  const { smartAccount: master } = await getOrCreateMasterSmartAccount();
  console.log(`Funding ${wallet.name} (${wallet.address})...`);
  const result = await transferFromSmartAccount({
    smartAccountName: master.name!,
    to: wallet.address as Address,
    amountWei: parseEther("0.015"),
  });
  console.log(`✅ tx: ${result.txHash}`);
}
main().catch(e => { console.error(e); process.exit(1); });
