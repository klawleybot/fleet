export interface Wallet {
  id: number;
  name: string;
  address: `0x${string}`;
  cdpAccountName: string;
  ownerAddress: `0x${string}`;
  type: "smart";
  isMaster: boolean;
  createdAt: string;
}

export interface TradeRecord {
  id: number;
  walletId: number;
  fromToken: `0x${string}`;
  toToken: `0x${string}`;
  amountIn: string;
  userOpHash: `0x${string}` | null;
  txHash: `0x${string}` | null;
  status: "pending" | "complete" | "failed";
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
  status: "pending" | "complete" | "failed";
  errorMessage: string | null;
  createdAt: string;
}

