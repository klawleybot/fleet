import { getCreatorCoinPoolConfig, setApiKey } from "@zoralabs/coins-sdk";

async function main() {
  if (process.env.ZORA_API_KEY) setApiKey(process.env.ZORA_API_KEY);
  const result = await getCreatorCoinPoolConfig({ query: {} });
  console.log(JSON.stringify(result.data, null, 2));
}

main().catch(console.error);
