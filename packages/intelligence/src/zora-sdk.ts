import * as zoraSdk from "@zoralabs/coins-sdk";

export interface ExploreEdge<Node> {
  node?: Node | null;
  cursor?: string | null;
}

export interface ExploreListResponse<Node> {
  data?: {
    exploreList?: {
      edges?: Array<ExploreEdge<Node>> | null;
    } | null;
  } | null;
}

export interface CoinNode {
  address?: string | null;
  symbol?: string | null;
  name?: string | null;
  coinType?: string | null;
  creatorAddress?: string | null;
  createdAt?: string | null;
  marketCap?: number | string | null;
  volume24h?: number | string | null;
  totalVolume?: number | string | null;
  chainId?: number | string | null;
  uniqueHolders?: number | string | null;
  poolCurrencyToken?: {
    address?: string | null;
  } | null;
  tokenPrice?: {
    priceInUsdc?: number | string | null;
  } | null;
}

export interface CoinSwapNode {
  id?: string | number | null;
  transactionHash?: string | null;
  activityType?: string | null;
  senderAddress?: string | null;
  recipientAddress?: string | null;
  blockTimestamp?: string | null;
  senderProfile?: {
    handle?: string | null;
  } | null;
  currencyAmountWithPrice?: {
    priceUsdc?: number | string | null;
    currencyAmount?: {
      amountDecimal?: number | string | null;
    } | null;
  } | null;
  coinAmount?: number | string | null;
  timestamp?: number | string | null;
  createdAt?: string | null;
  type?: string | null;
  isBuy?: boolean | null;
  amountUsdc?: number | string | null;
  amount_usdc?: number | string | null;
}

export interface CoinSwapsResponse {
  data?: {
    zora20Token?: {
      swapActivities?: {
        edges?: Array<ExploreEdge<CoinSwapNode>> | null;
      } | null;
    } | null;
    coinSwaps?: {
      edges?: Array<ExploreEdge<CoinSwapNode>> | null;
    } | null;
  } | null;
}

export interface HolderBalanceNode {
  ownerAddress?: string | null;
  ownerProfile?: {
    handle?: string | null;
  } | null;
  balance?: string | null;
}

export interface PageInfo {
  hasNextPage?: boolean | null;
  endCursor?: string | null;
}

export interface CoinHoldersResponse {
  data?: {
    zora20Token?: {
      tokenBalances?: {
        edges?: Array<ExploreEdge<HolderBalanceNode>> | null;
        pageInfo?: PageInfo | null;
      } | null;
    } | null;
  } | null;
}

export interface ProfileCoinBalanceNode {
  coin?: {
    address?: string | null;
    symbol?: string | null;
    name?: string | null;
  } | null;
  balance?: string | number | null;
}

export interface ProfileBalancesResponse {
  data?: {
    profile?: {
      coinBalances?: {
        edges?: Array<ExploreEdge<ProfileCoinBalanceNode>> | null;
      } | null;
    } | null;
  } | null;
}

export interface CommentNode {
  userAddress?: string | null;
  userProfile?: {
    handle?: string | null;
  } | null;
  comment?: string | null;
  timestamp?: number | string | null;
}

export interface CoinCommentsResponse {
  data?: {
    zora20Token?: {
      zoraComments?: {
        edges?: Array<ExploreEdge<CommentNode>> | null;
      } | null;
    } | null;
  } | null;
}

export interface CoinResponse {
  data?: {
    coin?: CoinNode | null;
    zora20Token?: CoinNode | null;
  } | null;
}

type SdkArgs = Record<string, unknown>;

interface CoinsSdkExports {
  getCoinsLastTraded?: (args: SdkArgs) => Promise<ExploreListResponse<CoinNode>>;
  getCoinSwaps?: (args: SdkArgs) => Promise<CoinSwapsResponse>;
  getCoinsNew?: (args: SdkArgs) => Promise<ExploreListResponse<CoinNode>>;
  getCoinsTopVolume24h?: (args: SdkArgs) => Promise<ExploreListResponse<CoinNode>>;
  getCoin?: (args: SdkArgs) => Promise<CoinResponse>;
  getCoinHolders?: (args: SdkArgs) => Promise<CoinHoldersResponse>;
  getCoinComments?: (args: SdkArgs) => Promise<CoinCommentsResponse>;
  getProfileBalances?: (args: SdkArgs) => Promise<ProfileBalancesResponse>;
  getCoinsTopGainers?: (args: SdkArgs) => Promise<ExploreListResponse<CoinNode>>;
  getCoinsLastTradedUnique?: (args: SdkArgs) => Promise<ExploreListResponse<CoinNode>>;
  setApiKey?: (apiKey: string) => void;
}

const sdk = zoraSdk as unknown as CoinsSdkExports;

function requireSdkFunction<K extends keyof CoinsSdkExports>(name: K): NonNullable<CoinsSdkExports[K]> {
  const fn = sdk[name];
  if (typeof fn !== "function") {
    throw new Error(`@zoralabs/coins-sdk is missing export ${String(name)}`);
  }
  return fn as NonNullable<CoinsSdkExports[K]>;
}

export const getCoinSwaps = requireSdkFunction("getCoinSwaps");
export const getCoinsNew = requireSdkFunction("getCoinsNew");
export const getCoinsTopVolume24h = requireSdkFunction("getCoinsTopVolume24h");
export const getCoinsLastTraded = requireSdkFunction("getCoinsLastTraded");
export const getCoin = requireSdkFunction("getCoin");
export const getCoinHolders = requireSdkFunction("getCoinHolders");
export const getCoinComments = requireSdkFunction("getCoinComments");
export const getProfileBalances = requireSdkFunction("getProfileBalances");
export const getCoinsTopGainers = requireSdkFunction("getCoinsTopGainers");
export const getCoinsLastTradedUnique = requireSdkFunction("getCoinsLastTradedUnique");
export const setApiKey = sdk.setApiKey;

export function exploreEdges<Node>(response: ExploreListResponse<Node>): Array<ExploreEdge<Node>> {
  return response.data?.exploreList?.edges ?? [];
}

export function coinHolderEdges(response: CoinHoldersResponse): Array<ExploreEdge<HolderBalanceNode>> {
  return response.data?.zora20Token?.tokenBalances?.edges ?? [];
}

export function coinHolderPageInfo(response: CoinHoldersResponse): PageInfo | null {
  return response.data?.zora20Token?.tokenBalances?.pageInfo ?? null;
}

export function profileBalanceEdges(response: ProfileBalancesResponse): Array<ExploreEdge<ProfileCoinBalanceNode>> {
  return response.data?.profile?.coinBalances?.edges ?? [];
}

export function commentEdges(response: CoinCommentsResponse): Array<ExploreEdge<CommentNode>> {
  return response.data?.zora20Token?.zoraComments?.edges ?? [];
}

export function coinSwapEdges(response: CoinSwapsResponse): Array<ExploreEdge<CoinSwapNode>> {
  return response.data?.zora20Token?.swapActivities?.edges ?? response.data?.coinSwaps?.edges ?? [];
}
