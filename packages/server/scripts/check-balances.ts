import { db } from "../src/db/index.js";
import { getEthBalance } from "../src/services/balance.js";

const wallets = db.listWallets().filter(w => !w.isMaster);
console.log(`Checking ${wallets.length} fleet wallets...\n`);

let funded = 0;
let empty = 0;
for (const w of wallets) {
  const bal = await getEthBalance(w.address as `0x${string}`);
  if (bal > 0n) {
    funded++;
    console.log(`  ✅ ${w.name.padEnd(16)} ${w.address.slice(0,10)}… ${(Number(bal) / 1e18).toFixed(6)} ETH`);
  } else {
    empty++;
  }
}
console.log(`\n${funded} funded, ${empty} empty (0 ETH)`);
