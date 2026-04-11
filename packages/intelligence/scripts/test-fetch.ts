import * as zoraSdk from "@zoralabs/coins-sdk";
import { env } from "../src/config.js";

interface SwapEdge {
  node: {
    blockTimestamp?: string;
    activityType?: string;
    transactionHash?: string;
    currencyAmountWithPrice?: {
      priceUsdc?: string | number;
    };
  };
}

interface GetCoinSwapsResponse {
  data?: {
    zora20Token?: {
      swapActivities?: {
        edges?: SwapEdge[];
      };
    };
  };
}

const sdk = zoraSdk as typeof import("@zoralabs/coins-sdk");
const getCoinSwaps = sdk.getCoinSwaps;
const setApiKey = sdk.setApiKey;
if (env.ZORA_API_KEY && setApiKey) setApiKey(env.ZORA_API_KEY);

const res = await getCoinSwaps({
  address: "0xb23c6e17fe82f958ade869d31055c445f76c5c43",
  chain: 8453,
  first: 10,
}) as GetCoinSwapsResponse;

const edges = res?.data?.zora20Token?.swapActivities?.edges ?? [];
console.log(`API returned ${edges.length} swaps for 0xb23c:`);
for (const e of edges) {
  const n = e.node;
  console.log(`  ${n.blockTimestamp} ${n.activityType} ${n.transactionHash?.slice(0, 16)} $${n.currencyAmountWithPrice?.priceUsdc}`);
}
