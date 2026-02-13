export type WalletType = "smart";

export interface WalletRecord {
  id: number;
  name: string;
  address: `0x${string}`;
  cdpAccountName: string;
  ownerAddress: `0x${string}`;
  type: WalletType;
  isMaster: boolean;
  createdAt: string;
}

export type TradeStatus = "pending" | "complete" | "failed";
export type FundingStatus = "pending" | "complete" | "failed";

export interface TradeRecord {
  id: number;
  walletId: number;
  fromToken: `0x${string}`;
  toToken: `0x${string}`;
  amountIn: string;
  userOpHash: `0x${string}` | null;
  txHash: `0x${string}` | null;
  status: TradeStatus;
  errorMessage: string | null;
  createdAt: string;
}

export interface FundingRecord {
  id: number;
  fromWalletId: number;
  toWalletId: number;
  amountWei: string;
  userOpHash: `0x${string}` | null;
  txHash: `0x${string}` | null;
  status: FundingStatus;
  errorMessage: string | null;
  createdAt: string;
}

export interface FundingRequestBody {
  toWalletIds: number[];
  amountWei: string;
}

export interface SwapRequestBody {
  walletIds: number[];
  fromToken: `0x${string}`;
  toToken: `0x${string}`;
  amountInWei: string;
  slippageBps: number;
}

