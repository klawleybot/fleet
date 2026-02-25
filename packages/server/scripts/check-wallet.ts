import { createPublicClient, http } from "viem";
import { base } from "viem/chains";
import { getChainConfig } from "../src/services/network.js";

const cfg = getChainConfig();
const client = createPublicClient({ chain: base, transport: http(cfg.rpcUrl) });

const addr = (process.argv[2] ?? "0x5866Db862bc125AC8C84876D62523c16e57e0151") as `0x${string}`;

const balance = await client.getBalance({ address: addr });
const code = await client.getCode({ address: addr });

console.log("Address:", addr);
console.log("Balance:", Number(balance) / 1e18, "ETH");
console.log("Deployed:", code && code !== "0x" ? "YES" : "NO (counterfactual)");
