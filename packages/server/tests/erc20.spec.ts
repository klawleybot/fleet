import { describe, it, expect } from "vitest";
import {
  encodeApproveCalldata,
  encodeAllowanceCalldata,
  decodeAllowanceResult,
  checkAndApprove,
} from "../src/services/erc20.js";
import { encodeAbiParameters } from "viem";

const TOKEN = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as const;
const SPENDER = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" as const;
const OWNER = "0xcccccccccccccccccccccccccccccccccccccccc" as const;

describe("erc20 helpers", () => {
  it("encodeApproveCalldata returns correct structure", () => {
    const result = encodeApproveCalldata(TOKEN, SPENDER, 1000n);
    expect(result.to).toBe(TOKEN);
    expect(result.value).toBe(0n);
    expect(result.data).toMatch(/^0x[0-9a-fA-F]+$/);
    // approve(address,uint256) selector = 0x095ea7b3
    expect(result.data.startsWith("0x095ea7b3")).toBe(true);
  });

  it("encodeAllowanceCalldata returns correct structure", () => {
    const result = encodeAllowanceCalldata(TOKEN, OWNER, SPENDER);
    expect(result.to).toBe(TOKEN);
    expect(result.data).toMatch(/^0x[0-9a-fA-F]+$/);
    // allowance(address,address) selector = 0xdd62ed3e
    expect(result.data.startsWith("0xdd62ed3e")).toBe(true);
  });

  it("decodeAllowanceResult round-trips", () => {
    const encoded = encodeAbiParameters(
      [{ type: "uint256" }],
      [5000n],
    );
    const decoded = decodeAllowanceResult(encoded);
    expect(decoded).toBe(5000n);
  });

  it("checkAndApprove returns null when allowance sufficient", async () => {
    const mockClient = {
      call: async () => ({
        data: encodeAbiParameters([{ type: "uint256" }], [10000n]) as `0x${string}`,
      }),
    };
    const result = await checkAndApprove({
      client: mockClient,
      token: TOKEN,
      owner: OWNER,
      spender: SPENDER,
      amount: 5000n,
    });
    expect(result).toBeNull();
  });

  it("checkAndApprove returns approve calldata when allowance insufficient", async () => {
    const mockClient = {
      call: async () => ({
        data: encodeAbiParameters([{ type: "uint256" }], [100n]) as `0x${string}`,
      }),
    };
    const result = await checkAndApprove({
      client: mockClient,
      token: TOKEN,
      owner: OWNER,
      spender: SPENDER,
      amount: 5000n,
    });
    expect(result).not.toBeNull();
    expect(result!.to).toBe(TOKEN);
    expect(result!.value).toBe(0n);
  });
});
