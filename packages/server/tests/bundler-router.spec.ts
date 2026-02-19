import { describe, expect, it } from "vitest";
import { BundlerRouter } from "../src/services/bundler/router.js";
import type {
  BundlerAdapter,
  Hex,
  SendUserOperationResult,
  UserOperationGasEstimate,
  UserOperationLike,
  UserOperationReceipt,
} from "../src/services/bundler/types.js";

function adapter(input: {
  name: string;
  sendImpl: (userOp: UserOperationLike) => Promise<SendUserOperationResult>;
  receipt?: UserOperationReceipt;
}): BundlerAdapter {
  return {
    name: input.name,
    chainId: 8453,
    entryPoint: "0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789",
    estimateUserOperationGas: async (): Promise<UserOperationGasEstimate> => ({
      preVerificationGas: "0x1",
      verificationGasLimit: "0x2",
      callGasLimit: "0x3",
    }),
    sendUserOperation: input.sendImpl,
    getUserOperationReceipt: async (_userOpHash: Hex): Promise<UserOperationReceipt> =>
      input.receipt ?? { included: false },
    getUserOperationByHash: async () => null,
    supportedEntryPoints: async () => ["0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789"],
  };
}

describe("BundlerRouter", () => {
  it("fails over to secondary on retryable primary error", async () => {
    const primary = adapter({
      name: "primary",
      sendImpl: async () => {
        throw new Error("RPC failed HTTP 503");
      },
    });

    const secondary = adapter({
      name: "secondary",
      sendImpl: async () => ({ provider: "secondary", userOpHash: "0xabc" }),
    });

    const router = new BundlerRouter(primary, secondary, {
      sendTimeoutMs: 500,
      hedgeDelayMs: 50,
      receiptPollMs: 10,
      receiptTimeoutMs: 100,
    });

    const result = await router.send({});
    expect(result.selected.provider).toBe("secondary");
    expect(result.attempts.length).toBe(2);
  });

  it("does not fail over on validation-like errors", async () => {
    const primary = adapter({
      name: "primary",
      sendImpl: async () => {
        throw new Error("AA23 reverted: invalid signature");
      },
    });

    const secondary = adapter({
      name: "secondary",
      sendImpl: async () => ({ provider: "secondary", userOpHash: "0xabc" }),
    });

    const router = new BundlerRouter(primary, secondary, {
      sendTimeoutMs: 500,
      hedgeDelayMs: 50,
      receiptPollMs: 10,
      receiptTimeoutMs: 100,
    });

    await expect(router.send({})).rejects.toThrow(/invalid signature/i);
  });

  it("returns included receipt from either provider", async () => {
    const primary = adapter({
      name: "primary",
      sendImpl: async () => ({ provider: "primary", userOpHash: "0xabc" }),
      receipt: { included: false },
    });

    const secondary = adapter({
      name: "secondary",
      sendImpl: async () => ({ provider: "secondary", userOpHash: "0xabc" }),
      receipt: { included: true, txHash: "0xdef" },
    });

    const router = new BundlerRouter(primary, secondary, {
      sendTimeoutMs: 500,
      hedgeDelayMs: 50,
      receiptPollMs: 10,
      receiptTimeoutMs: 100,
    });

    const receipt = await router.waitForReceipt("0xabc");
    expect(receipt.included).toBe(true);
    expect(receipt.txHash).toBe("0xdef");
  });
});
