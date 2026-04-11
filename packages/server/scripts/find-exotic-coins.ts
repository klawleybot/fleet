import { createPublicClient, http, parseAbiItem, type Address, decodeAbiParameters, parseAbiParameters, type Hex } from "viem";
import { base } from "viem/chains";

async function main() {
  const client = createPublicClient({ chain: base, transport: http(process.env.BASE_RPC_URL || undefined) });
  const FACTORY = "0x777777751622c0d3258f214F9DF38E35BF45baF3" as Address;
  const ZORA = "0x1111111111166b7fe7bd91427724b487980afc69".toLowerCase();

  const latestBlock = await client.getBlockNumber();
  console.log("Latest block:", latestBlock);

  // Scan recent 10k blocks for CoinCreatedV4
  const startBlock = latestBlock - 10000n;

  const events = await client.getLogs({
    address: FACTORY,
    event: parseAbiItem(
      "event CoinCreatedV4(address indexed caller, address indexed payoutRecipient, address indexed platformReferrer, address currency, string uri, string name, string symbol, address coin, (address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks) poolKey, bytes32 poolKeyHash, string version)"
    ),
    fromBlock: startBlock,
    toBlock: latestBlock,
  });

  const KNOWN_CURRENCIES = new Set([
    ZORA,
    "0x4200000000000000000000000000000000000006", // WETH
    "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", // USDC
  ]);

  const exotic = events.filter(e => !KNOWN_CURRENCIES.has(e.args.currency!.toLowerCase()));
  console.log("Total CoinCreatedV4 events:", events.length);
  console.log("Non-standard currency coins:", exotic.length);

  for (const e of exotic.slice(0, 20)) {
    console.log(JSON.stringify({
      coin: e.args.coin,
      currency: e.args.currency,
      name: e.args.name,
      symbol: e.args.symbol,
      block: Number(e.blockNumber),
      tx: e.transactionHash,
    }));
  }

  // Now get the poolConfig from the deploy transaction for the first exotic coin
  if (exotic.length > 0) {
    const tx = exotic[0];
    console.log("\n--- Fetching deploy TX input data ---");
    console.log("TX:", tx.transactionHash);

    const txData = await client.getTransaction({ hash: tx.transactionHash! });
    // The TX goes to EntryPoint, so we need to decode from UserOp or get it from the factory call
    // Let's check the transaction receipt for the deploy event's input
    const receipt = await client.getTransactionReceipt({ hash: tx.transactionHash! });

    // Look for the poolConfig in raw logs - the factory emits it
    // Actually let's use trace or just decode the factory call from the internal txs
    // Easier: read the coin's storage directly for its pool config
    // The coin has a poolKey in the event, but we need the full Doppler config
    // Let's read the poolConfig from the factory's deploy call input data

    // Alternative approach: use the Zora API to get the coin's config
    console.log("Coin address:", tx.args.coin);
    console.log("Currency:", tx.args.currency);
    console.log("Pool key:", JSON.stringify(tx.args.poolKey));
  }
}

main().catch(console.error);
