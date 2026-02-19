import { rpcCall } from "./jsonRpc.js";
import type {
  BundlerAdapter,
  Hex,
  SendUserOperationResult,
  UserOperationGasEstimate,
  UserOperationLike,
  UserOperationReceipt,
} from "./types.js";

interface HttpBundlerAdapterInput {
  name: string;
  rpcUrl: string;
  chainId: number;
  entryPoint: Hex;
  timeoutMs: number;
}

export class HttpBundlerAdapter implements BundlerAdapter {
  readonly name: string;
  readonly chainId: number;
  readonly entryPoint: Hex;

  private readonly rpcUrl: string;
  private readonly timeoutMs: number;

  constructor(input: HttpBundlerAdapterInput) {
    this.name = input.name;
    this.rpcUrl = input.rpcUrl;
    this.chainId = input.chainId;
    this.entryPoint = input.entryPoint;
    this.timeoutMs = input.timeoutMs;
  }

  async estimateUserOperationGas(userOp: UserOperationLike): Promise<UserOperationGasEstimate> {
    return rpcCall<UserOperationGasEstimate>(
      this.rpcUrl,
      "eth_estimateUserOperationGas",
      [userOp, this.entryPoint],
      this.timeoutMs,
    );
  }

  async sendUserOperation(userOp: UserOperationLike): Promise<SendUserOperationResult> {
    const userOpHash = await rpcCall<Hex>(
      this.rpcUrl,
      "eth_sendUserOperation",
      [userOp, this.entryPoint],
      this.timeoutMs,
    );

    return {
      provider: this.name,
      userOpHash,
    };
  }

  async getUserOperationReceipt(userOpHash: Hex): Promise<UserOperationReceipt> {
    const raw = await rpcCall<any>(
      this.rpcUrl,
      "eth_getUserOperationReceipt",
      [userOpHash],
      this.timeoutMs,
    );

    if (!raw) return { included: false };

    const blockNumber = raw.receipt?.blockNumber ? BigInt(raw.receipt.blockNumber) : null;

    return {
      included: true,
      txHash: raw.receipt?.transactionHash,
      ...(blockNumber !== null ? { blockNumber } : {}),
      success: raw.success,
      actualGasCost: raw.actualGasCost,
      actualGasUsed: raw.actualGasUsed,
      raw,
    };
  }

  async getUserOperationByHash(userOpHash: Hex): Promise<unknown | null> {
    return rpcCall<unknown | null>(this.rpcUrl, "eth_getUserOperationByHash", [userOpHash], this.timeoutMs);
  }

  async supportedEntryPoints(): Promise<Hex[]> {
    return rpcCall<Hex[]>(this.rpcUrl, "eth_supportedEntryPoints", [], this.timeoutMs);
  }
}
