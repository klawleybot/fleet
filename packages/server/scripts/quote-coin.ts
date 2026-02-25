import { quoteCoinToEth } from "../src/services/quoter.js";

const coinAddress = process.argv[2] as `0x${string}`;
const amount = BigInt(process.argv[3]!);

const ethValue = await quoteCoinToEth({ coinAddress, amount });
console.log(`Holdings: ${amount}`);
console.log(`ETH value: ${Number(ethValue) / 1e18} ETH`);
console.log(`Raw wei: ${ethValue}`);
