import { describe, it, expect } from "vitest";
import { makePoolKey } from "../src/services/quoter.js";
import type { Address } from "viem";

describe("quoter — makePoolKey", () => {
  const TOKEN_A = "0x1111111111111111111111111111111111111111" as Address;
  const TOKEN_B = "0x2222222222222222222222222222222222222222" as Address;
  const HOOKS = "0x0000000000000000000000000000000000000000" as Address;

  it("orders tokens correctly (A < B)", () => {
    const result = makePoolKey(TOKEN_A, TOKEN_B, { fee: 3000, tickSpacing: 60, hooks: HOOKS });
    expect(result.poolKey.currency0.toLowerCase()).toBe(TOKEN_A.toLowerCase());
    expect(result.poolKey.currency1.toLowerCase()).toBe(TOKEN_B.toLowerCase());
    expect(result.zeroForOne).toBe(true);
  });

  it("orders tokens correctly (B → A, reversed)", () => {
    const result = makePoolKey(TOKEN_B, TOKEN_A, { fee: 3000, tickSpacing: 60, hooks: HOOKS });
    expect(result.poolKey.currency0.toLowerCase()).toBe(TOKEN_A.toLowerCase());
    expect(result.poolKey.currency1.toLowerCase()).toBe(TOKEN_B.toLowerCase());
    expect(result.zeroForOne).toBe(false);
  });

  it("passes through pool params", () => {
    const result = makePoolKey(TOKEN_A, TOKEN_B, { fee: 500, tickSpacing: 10, hooks: HOOKS });
    expect(result.poolKey.fee).toBe(500);
    expect(result.poolKey.tickSpacing).toBe(10);
    expect(result.poolKey.hooks).toBe(HOOKS);
  });
});
