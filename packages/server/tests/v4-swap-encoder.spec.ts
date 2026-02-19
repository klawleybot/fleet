import { describe, it, expect } from "vitest";
import { decodeAbiParameters, decodeFunctionData } from "viem";
import {
  encodeV4ExactInSwap,
  getRouterAddress,
  UNIVERSAL_ROUTER_ADDRESSES,
  DEFAULT_POOL_PARAMS,
} from "../src/services/v4SwapEncoder.js";

const WETH = "0x4200000000000000000000000000000000000006" as const;
const NATIVE_ETH = "0x0000000000000000000000000000000000000000" as const;
const TOKEN_A = "0x1111111111111111111111111111111111111111" as const;
const TOKEN_B = "0x2222222222222222222222222222222222222222" as const;
const ZORA = "0x3333333333333333333333333333333333333333" as const;

const executeAbi = [
  {
    name: "execute",
    type: "function",
    stateMutability: "payable",
    inputs: [
      { name: "commands", type: "bytes" },
      { name: "inputs", type: "bytes[]" },
      { name: "deadline", type: "uint256" },
    ],
    outputs: [],
  },
] as const;

describe("v4SwapEncoder", () => {
  describe("getRouterAddress", () => {
    it("returns Base mainnet router", () => {
      expect(getRouterAddress(8453)).toBe(UNIVERSAL_ROUTER_ADDRESSES[8453]);
    });

    it("returns Base Sepolia router", () => {
      expect(getRouterAddress(84532)).toBe(UNIVERSAL_ROUTER_ADDRESSES[84532]);
    });

    it("throws for unknown chainId", () => {
      expect(() => getRouterAddress(999)).toThrow("No Universal Router address");
    });
  });

  describe("single-hop ETH → Token", () => {
    const result = encodeV4ExactInSwap({
      chainId: 8453,
      path: [NATIVE_ETH, TOKEN_A],
      amountIn: 1000000000000000000n, // 1 ETH
      minAmountOut: 500n,
      deadline: 9999999999n,
    });

    it("targets the router", () => {
      expect(result.to).toBe(UNIVERSAL_ROUTER_ADDRESSES[8453]);
    });

    it("sets value for native ETH", () => {
      expect(result.value).toBe(1000000000000000000n);
    });

    it("encodes valid execute calldata", () => {
      const decoded = decodeFunctionData({ abi: executeAbi, data: result.data });
      expect(decoded.functionName).toBe("execute");

      const [commands, inputs, deadline] = decoded.args;
      // commands = 0x10
      expect(commands).toBe("0x10");
      expect(inputs).toHaveLength(1);
      expect(deadline).toBe(9999999999n);
    });

    it("has correct action bytes in v4swap input", () => {
      const decoded = decodeFunctionData({ abi: executeAbi, data: result.data });
      const [, inputs] = decoded.args;
      const v4Input = inputs[0];

      // Decode the V4_SWAP input: (bytes actions, bytes[] params)
      const [actions] = decodeAbiParameters(
        [{ type: "bytes" }, { type: "bytes[]" }],
        v4Input as `0x${string}`,
      );
      // actions should be 0x070c0f
      expect(actions).toBe("0x070c0f");
    });
  });

  describe("two-hop ETH → ZORA → CoinToken", () => {
    const result = encodeV4ExactInSwap({
      chainId: 8453,
      path: [NATIVE_ETH, ZORA, TOKEN_B],
      amountIn: 500000000000000000n,
      minAmountOut: 100n,
      deadline: 9999999999n,
    });

    it("sets value for native ETH", () => {
      expect(result.value).toBe(500000000000000000n);
    });

    it("encodes two path keys", () => {
      const decoded = decodeFunctionData({ abi: executeAbi, data: result.data });
      const [, inputs] = decoded.args;
      const [actions, params] = decodeAbiParameters(
        [{ type: "bytes" }, { type: "bytes[]" }],
        inputs[0] as `0x${string}`,
      );
      expect(actions).toBe("0x070c0f");
      expect(params).toHaveLength(3);
    });
  });

  describe("ERC20 → ERC20 swap", () => {
    const result = encodeV4ExactInSwap({
      chainId: 8453,
      path: [TOKEN_A, TOKEN_B],
      amountIn: 1000n,
      minAmountOut: 900n,
      deadline: 9999999999n,
    });

    it("has value=0n for ERC20 input", () => {
      expect(result.value).toBe(0n);
    });
  });

  describe("roundtrip encode/decode", () => {
    it("decodes back to valid structure", () => {
      const result = encodeV4ExactInSwap({
        chainId: 84532,
        path: [NATIVE_ETH, TOKEN_A],
        amountIn: 1n,
        minAmountOut: 0n,
        deadline: 12345n,
      });

      const decoded = decodeFunctionData({ abi: executeAbi, data: result.data });
      const [commands, inputs, deadline] = decoded.args;

      expect(commands).toBe("0x10");
      expect(deadline).toBe(12345n);
      expect(inputs).toHaveLength(1);

      // Decode inner v4 swap input
      const [actions, params] = decodeAbiParameters(
        [{ type: "bytes" }, { type: "bytes[]" }],
        inputs[0] as `0x${string}`,
      );

      expect(actions).toBe("0x070c0f");
      expect(params).toHaveLength(3); // SWAP_EXACT_IN, SETTLE_ALL, TAKE_ALL

      // Decode SETTLE_ALL params
      const [settleCurrency, settleMax] = decodeAbiParameters(
        [{ type: "address" }, { type: "uint256" }],
        params[1] as `0x${string}`,
      );
      expect((settleCurrency as string).toLowerCase()).toBe(NATIVE_ETH.toLowerCase());
      expect(settleMax).toBe(1n);

      // Decode TAKE_ALL params
      const [takeCurrency, takeMin] = decodeAbiParameters(
        [{ type: "address" }, { type: "uint256" }],
        params[2] as `0x${string}`,
      );
      expect((takeCurrency as string).toLowerCase()).toBe(TOKEN_A.toLowerCase());
      expect(takeMin).toBe(0n);
    });
  });
});
