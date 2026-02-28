import * as zoraSdk from "@zoralabs/coins-sdk";
import { env } from "../src/config.js";
import { db } from "../src/db.js";

const getCoinSwaps = (zoraSdk as any).getCoinSwaps;
const setApiKey = (zoraSdk as any).setApiKey;
if (env.ZORA_API_KEY && setApiKey) setApiKey(env.ZORA_API_KEY);

const res = await getCoinSwaps({ address: "0xb23c6e17fe82f958ade869d31055c445f76c5c43", chain: 8453, first: 5 });
const edges = res?.data?.zora20Token?.swapActivities?.edges ?? [];
console.log(edges.length, "swaps from API");

for (const e of edges) {
  const n = e.node;
  const existing = db.prepare("SELECT id FROM coin_swaps WHERE id = ?").get(n.id);
  console.log(n.blockTimestamp, n.activityType, existing ? "ALREADY IN DB" : "NEW", String(n.id).slice(0, 40));
}
