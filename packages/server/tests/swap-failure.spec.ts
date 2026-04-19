import { encodeErrorResult } from "viem";
import { describe, expect, it } from "vitest";
import { describeSwapFailure, isSlippageFailureMessage } from "../src/services/swapFailure.js";

describe("swap failure decoding", () => {
  it("decodes V4TooLittleReceived revert data into a readable message", () => {
    const revertData = encodeErrorResult({
      abi: [
        {
          name: "V4TooLittleReceived",
          type: "error",
          inputs: [
            { name: "minAmountOutReceived", type: "uint256" },
            { name: "amountReceived", type: "uint256" },
          ],
        },
      ] as const,
      errorName: "V4TooLittleReceived",
      args: [100n, 90n],
    });

    const message = describeSwapFailure(revertData);

    expect(message).toBe("Too little received: got 90, needed at least 100");
    expect(isSlippageFailureMessage(message)).toBe(true);
  });
});
