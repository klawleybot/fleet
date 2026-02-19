import { describe, it, expect, vi } from "vitest";
import { decodeAbiParameters, decodeFunctionData } from "viem";
import {
  applySlippage,
  encodeQuoteExactInputCalldata,
  quoteExactInput,
  getQuoterAddress,
  V4_QUOTER_ADDRESSES,
  type QuoteClient,
} from "../src/services/v4Quoter.js";

const WETH = "0x4200000000000000000000000000000000000006" as const;
const NATIVE_ETH = "0x0000000000000000000000000000000000000000" as const;
const TOKEN_A = "0x1111111111111111111111111111111111111111" as const;
const TOKEN_B = "0x2222222222222222222222222222222222222222" as const;

const DEFAULT_POOL_PARAMS = {
  fee: 3000,
  tickSpacing: 60,
  hooks: "0x0000000000000000000000000000000000000000" as `0x${string}`,
  hookData: "0x" as `0x${string}`,
};

const quoteExactInputAbi = [
  {
    name: "quoteExactInput",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      {
        name: "params",
        type: "tuple",
        components: [
          { name: "exactCurrency", type: "address" },
          {
            name: "path",
            type: "tuple[]",
            components: [
              { name: "intermediateCurrency", type: "address" },
              { name: "fee", type: "uint24" },
              { name: "tickSpacing", type: "int24" },
              { name: "hooks", type: "address" },
              { name: "hookData", type: "bytes" },
            ],
          },
          { name: "exactAmount", type: "uint128" },
        ],
      },
    ],
    outputs: [
      { name: "deltaAmounts", type: "int128[]" },
      { name: "sqrtPriceX96AfterList", type: "uint160[]" },
      { name: "initializedTicksCrossedList", type: "uint32[]" },
    ],
  },
] as const;

describe("v4Quoter", () => {
  describe("getQuoterAddress", () => {
    it("returns Base mainnet quoter", () => {
      expect(getQuoterAddress(8453)).toBe(V4_QUOTER_ADDRESSES[8453]);
    });

    it("returns Base Sepolia quoter", () => {
      expect(getQuoterAddress(84532)).toBe(V4_QUOTER_ADDRESSES[84532]);
    });

    it("throws for unknown chainId", () => {
      expect(() => getQuoterAddress(999)).toThrow("No V4 Quoter address");
    });
  });

  describe("applySlippage", () => {
    it("0 bps returns original amount", () => {
      expect(applySlippage(1000n, 0)).toBe(1000n);
    });

    it("50 bps (0.5%)", () => {
      expect(applySlippage(10000n, 50)).toBe(9950n);
    });

    it("100 bps (1%)", () => {
      expect(applySlippage(1000n, 100)).toBe(990n);
    });

    it("500 bps (5%)", () => {
      expect(applySlippage(1000n, 500)).toBe(950n);
    });

    it("10000 bps (100%) returns 0", () => {
      expect(applySlippage(1000n, 10000)).toBe(0n);
    });

    it("rounds down (truncates)", () => {
      // 333 * 9900 / 10000 = 329.67 → 329
      expect(applySlippage(333n, 100)).toBe(329n);
    });

    it("throws for negative bps", () => {
      expect(() => applySlippage(1000n, -1)).toThrow("slippageBps must be between");
    });

    it("throws for bps > 10000", () => {
      expect(() => applySlippage(1000n, 10001)).toThrow("slippageBps must be between");
    });
  });

  describe("encodeQuoteExactInputCalldata", () => {
    it("encodes single-hop ETH → Token correctly", () => {
      const calldata = encodeQuoteExactInputCalldata({
        path: [WETH, TOKEN_A],
        poolParams: [DEFAULT_POOL_PARAMS],
        amountIn: 1000000000000000000n,
      });

      const decoded = decodeFunctionData({ abi: quoteExactInputAbi, data: calldata });
      expect(decoded.functionName).toBe("quoteExactInput");

      const params = decoded.args[0];
      // WETH should be mapped to address(0)
      expect(params.exactCurrency.toLowerCase()).toBe(NATIVE_ETH);
      expect(params.path).toHaveLength(1);
      expect(params.path[0].intermediateCurrency.toLowerCase()).toBe(TOKEN_A.toLowerCase());
      expect(params.path[0].fee).toBe(3000);
      expect(params.path[0].tickSpacing).toBe(60);
      expect(params.exactAmount).toBe(1000000000000000000n);
    });

    it("encodes multi-hop path correctly", () => {
      const calldata = encodeQuoteExactInputCalldata({
        path: [WETH, TOKEN_A, TOKEN_B],
        poolParams: [DEFAULT_POOL_PARAMS, { ...DEFAULT_POOL_PARAMS, fee: 10000, tickSpacing: 200 }],
        amountIn: 500n,
      });

      const decoded = decodeFunctionData({ abi: quoteExactInputAbi, data: calldata });
      const params = decoded.args[0];

      expect(params.path).toHaveLength(2);
      expect(params.path[0].intermediateCurrency.toLowerCase()).toBe(TOKEN_A.toLowerCase());
      expect(params.path[0].fee).toBe(3000);
      expect(params.path[1].intermediateCurrency.toLowerCase()).toBe(TOKEN_B.toLowerCase());
      expect(params.path[1].fee).toBe(10000);
      expect(params.path[1].tickSpacing).toBe(200);
      expect(params.exactAmount).toBe(500n);
    });

    it("does not map non-WETH tokens to address(0)", () => {
      const calldata = encodeQuoteExactInputCalldata({
        path: [TOKEN_A, TOKEN_B],
        poolParams: [DEFAULT_POOL_PARAMS],
        amountIn: 100n,
      });

      const decoded = decodeFunctionData({ abi: quoteExactInputAbi, data: calldata });
      const params = decoded.args[0];
      expect(params.exactCurrency.toLowerCase()).toBe(TOKEN_A.toLowerCase());
      expect(params.path[0].intermediateCurrency.toLowerCase()).toBe(TOKEN_B.toLowerCase());
    });
  });

  describe("quoteExactInput", () => {
    it("parses response correctly for single-hop", async () => {
      const { encodeAbiParameters } = await import("viem");

      // Mock response: deltaAmounts = [1000000000000000000, -500000]
      const mockReturnData = encodeAbiParameters(
        [{ type: "int128[]" }, { type: "uint160[]" }, { type: "uint32[]" }],
        [
          [1000000000000000000n, -500000n],
          [79228162514264337593543950336n],
          [3],
        ],
      );

      const mockClient = {
        call: vi.fn().mockResolvedValue({ data: mockReturnData }),
      } satisfies QuoteClient;

      const result = await quoteExactInput({
        chainId: 8453,
        client: mockClient,
        path: [WETH, TOKEN_A],
        poolParams: [DEFAULT_POOL_PARAMS],
        amountIn: 1000000000000000000n,
        exactInput: true,
      });

      expect(result.amountOut).toBe(500000n);
      expect(result.sqrtPriceX96After).toEqual([79228162514264337593543950336n]);
      expect(result.initializedTicksCrossed).toEqual([3]);

      // Verify the call was made to the right address
      expect(mockClient.call).toHaveBeenCalledWith({
        to: V4_QUOTER_ADDRESSES[8453],
        data: expect.any(String),
      });
    });

    it("throws on empty response", async () => {
      const mockClient = {
        call: vi.fn().mockResolvedValue({ data: undefined }),
      } satisfies QuoteClient;

      await expect(
        quoteExactInput({
          chainId: 8453,
          client: mockClient,
          path: [WETH, TOKEN_A],
          poolParams: [DEFAULT_POOL_PARAMS],
          amountIn: 1000n,
          exactInput: true,
        }),
      ).rejects.toThrow("empty response");
    });
  });
});
