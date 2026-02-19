export type Hex = `0x${string}`;

export interface UserOperationLike {
  [key: string]: unknown;
}

export interface UserOperationGasEstimate {
  preVerificationGas: Hex;
  verificationGasLimit: Hex;
  callGasLimit: Hex;
}

export interface SendUserOperationResult {
  userOpHash: Hex;
  requestId?: string;
  provider: string;
}

export interface UserOperationReceipt {
  included: boolean;
  txHash?: Hex;
  blockNumber?: bigint;
  success?: boolean;
  actualGasCost?: Hex;
  actualGasUsed?: Hex;
  reason?: string;
  raw?: unknown;
}

export interface BundlerAdapter {
  readonly name: string;
  readonly chainId: number;
  readonly entryPoint: Hex;

  estimateUserOperationGas(userOp: UserOperationLike): Promise<UserOperationGasEstimate>;
  sendUserOperation(userOp: UserOperationLike): Promise<SendUserOperationResult>;
  getUserOperationReceipt(userOpHash: Hex): Promise<UserOperationReceipt>;
  getUserOperationByHash(userOpHash: Hex): Promise<unknown | null>;
  supportedEntryPoints(): Promise<Hex[]>;
}

export interface BundlerRouterConfig {
  sendTimeoutMs: number;
  hedgeDelayMs: number;
  receiptPollMs: number;
  receiptTimeoutMs: number;
}

export interface BundlerRouterSendResult {
  primary: string;
  attempts: Array<{ provider: string; ok: boolean; error?: string }>;
  selected: SendUserOperationResult;
}

export type BundlerErrorCategory =
  | "retryable"
  | "rate_limit"
  | "underpriced"
  | "validation"
  | "fatal";
