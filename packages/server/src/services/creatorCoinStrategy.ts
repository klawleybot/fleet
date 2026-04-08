import { createPublicClient, erc20Abi, formatUnits, http, type Address } from "viem";
import { getChainConfig } from "./network.js";
import { getKlawleyAccountInfo } from "./cdp.js";
import { resolveCoinRoute, type CoinRoute } from "./coinRoute.js";

export const CREATOR_COIN_ADDRESS = "0x2e6e49e3f1c76d9b8c7ca0bee2005ed6de0e2046" as Address;
export const ZORA_TOKEN_ADDRESS = "0x1111111111166b7fe7bd91427724b487980afc69" as Address;
export const WETH_ADDRESS = "0x4200000000000000000000000000000000000006" as Address;

export type CampaignFundingSource = "ETH" | "ZORA" | "CREATOR_COIN";
export type CreatorCoinRegime = "strong" | "neutral" | "weak";

export interface TreasuryBalances {
  ethWei: bigint;
  zoraRaw: bigint;
  creatorCoinRaw: bigint;
  creatorCoinFormatted: string;
  zoraFormatted: string;
}

export interface CreatorCoinStrategySnapshot {
  smartWalletAddress: Address;
  creatorCoinAddress: Address;
  creatorCoinRoute: CoinRoute | null;
  balances: TreasuryBalances;
  creatorCoinVsZora: {
    hopCount: number;
    terminalAnchor: Address | null;
    ancestry: Address[];
  };
  regime: CreatorCoinRegime;
  preferredSnipeSource: CampaignFundingSource;
  preferredPaintSource: CampaignFundingSource;
  preferredCreatorCoinExitTarget: CampaignFundingSource;
  notes: string[];
}

function ratioBps(numerator: bigint, denominator: bigint): number {
  if (denominator <= 0n) return 0;
  return Number((numerator * 10_000n) / denominator);
}

function classifyRegime(args: {
  creatorCoinRaw: bigint;
  zoraRaw: bigint;
  route: CoinRoute | null;
}): { regime: CreatorCoinRegime; notes: string[] } {
  const notes: string[] = [];
  const creatorVsZoraBps = ratioBps(args.creatorCoinRaw, args.zoraRaw === 0n ? 1n : args.zoraRaw);
  const hopCount = args.route?.buyPath.length ? Math.max(0, args.route.buyPath.length - 1) : 99;

  if (args.creatorCoinRaw === 0n) {
    notes.push("creator coin inventory empty");
    return { regime: "weak", notes };
  }

  if (hopCount <= 2 && creatorVsZoraBps >= 5_000) {
    notes.push("creator coin inventory materially exceeds ZORA and route is short");
    return { regime: "strong", notes };
  }

  if (hopCount >= 4) {
    notes.push("creator coin route is deep; treat as weak until better pricing arrives");
    return { regime: "weak", notes };
  }

  if (creatorVsZoraBps < 1_500) {
    notes.push("creator coin inventory small relative to ZORA reserves");
    return { regime: "weak", notes };
  }

  notes.push("creator coin inventory is usable but not dominant");
  return { regime: "neutral", notes };
}

function chooseSources(regime: CreatorCoinRegime, balances: TreasuryBalances): Pick<CreatorCoinStrategySnapshot, "preferredSnipeSource" | "preferredPaintSource" | "preferredCreatorCoinExitTarget"> {
  if (balances.creatorCoinRaw > 0n) {
    if (regime === "strong") {
      return {
        preferredSnipeSource: "CREATOR_COIN",
        preferredPaintSource: "CREATOR_COIN",
        preferredCreatorCoinExitTarget: "ETH",
      };
    }

    if (regime === "neutral") {
      return {
        preferredSnipeSource: "CREATOR_COIN",
        preferredPaintSource: balances.zoraRaw > 0n ? "ZORA" : "CREATOR_COIN",
        preferredCreatorCoinExitTarget: "ETH",
      };
    }
  }

  return {
    preferredSnipeSource: balances.zoraRaw > 0n ? "ZORA" : "ETH",
    preferredPaintSource: balances.zoraRaw > 0n ? "ZORA" : "ETH",
    preferredCreatorCoinExitTarget: "CREATOR_COIN",
  };
}

export async function getCreatorCoinStrategySnapshot(): Promise<CreatorCoinStrategySnapshot | null> {
  const account = getKlawleyAccountInfo();
  if (!account) return null;

  const chain = getChainConfig();
  const client = createPublicClient({ chain: chain.chain, transport: http(chain.rpcUrl) });

  const [ethWei, zoraRaw, creatorCoinRaw, creatorCoinRoute] = await Promise.all([
    client.getBalance({ address: account.smartWalletAddress }),
    client.readContract({ address: ZORA_TOKEN_ADDRESS, abi: erc20Abi, functionName: "balanceOf", args: [account.smartWalletAddress] }),
    client.readContract({ address: CREATOR_COIN_ADDRESS, abi: erc20Abi, functionName: "balanceOf", args: [account.smartWalletAddress] }),
    resolveCoinRoute({ client, coinAddress: CREATOR_COIN_ADDRESS }).catch(() => null),
  ]);

  const balances: TreasuryBalances = {
    ethWei,
    zoraRaw,
    creatorCoinRaw,
    creatorCoinFormatted: formatUnits(creatorCoinRaw, 18),
    zoraFormatted: formatUnits(zoraRaw, 18),
  };

  const classification = classifyRegime({ creatorCoinRaw, zoraRaw, route: creatorCoinRoute });
  const sources = chooseSources(classification.regime, balances);

  return {
    smartWalletAddress: account.smartWalletAddress,
    creatorCoinAddress: CREATOR_COIN_ADDRESS,
    creatorCoinRoute,
    balances,
    creatorCoinVsZora: {
      hopCount: creatorCoinRoute ? Math.max(0, creatorCoinRoute.buyPath.length - 1) : 0,
      terminalAnchor: creatorCoinRoute?.ancestry.at(-1) ?? null,
      ancestry: creatorCoinRoute?.ancestry ?? [],
    },
    regime: classification.regime,
    preferredSnipeSource: sources.preferredSnipeSource,
    preferredPaintSource: sources.preferredPaintSource,
    preferredCreatorCoinExitTarget: sources.preferredCreatorCoinExitTarget,
    notes: classification.notes,
  };
}

export async function getCreatorCoinTreasuryBalances(): Promise<TreasuryBalances | null> {
  const snapshot = await getCreatorCoinStrategySnapshot();
  return snapshot?.balances ?? null;
}
