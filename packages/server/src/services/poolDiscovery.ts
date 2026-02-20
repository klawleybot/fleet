import { parseEventLogs, type Address, type Log } from "viem";
import type { HopPoolParams } from "./swapRoute.js";
import { zoraFactoryAbi, ZORA_FACTORY_ADDRESSES } from "./coinLauncher.js";

/** Minimal client interface for reading logs. */
export interface PoolDiscoveryClient {
  getLogs(args: {
    address: Address;
    event: (typeof zoraFactoryAbi)[number];
    fromBlock: bigint;
    toBlock: "latest";
  }): Promise<Log[]>;
}

/**
 * Discover pool params for a Zora coin by scanning CoinCreatedV4 events
 * from the ZoraFactory contract.
 */
export async function discoverPoolParams(params: {
  client: PoolDiscoveryClient;
  chainId: number;
  coinAddress: Address;
}): Promise<HopPoolParams> {
  const { client, chainId, coinAddress } = params;

  const factoryAddress = ZORA_FACTORY_ADDRESSES[chainId];
  if (!factoryAddress) {
    throw new Error(`No ZoraFactory address for chainId ${chainId}`);
  }

  const coinCreatedV4Event = zoraFactoryAbi.find(
    (item) => item.type === "event" && item.name === "CoinCreatedV4",
  );
  if (!coinCreatedV4Event) {
    throw new Error("CoinCreatedV4 event not found in ABI");
  }

  const logs = await client.getLogs({
    address: factoryAddress,
    event: coinCreatedV4Event,
    fromBlock: 0n,
    toBlock: "latest",
  });

  const parsed = parseEventLogs({
    abi: zoraFactoryAbi,
    eventName: "CoinCreatedV4",
    logs,
  });

  const coinNorm = coinAddress.toLowerCase();
  const matching = parsed.find(
    (ev) => ev.args.coin.toLowerCase() === coinNorm,
  );

  if (!matching) {
    throw new Error(
      `No CoinCreatedV4 event found for coin ${coinAddress} on chain ${chainId}`,
    );
  }

  const poolKey = matching.args.poolKey;
  return {
    fee: poolKey.fee,
    tickSpacing: poolKey.tickSpacing,
    hooks: poolKey.hooks,
    hookData: "0x",
  };
}
