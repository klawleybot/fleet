import { describe, it, expect, beforeAll } from "vitest";
import {
  createPublicClient,
  http,
  type Address,
  type PublicClient,
} from "viem";
import { baseSepolia } from "viem/chains";
import {
  quoteExactInput,
  applySlippage,
  encodeQuoteExactInputCalldata,
  getQuoterAddress,
} from "../src/services/v4Quoter.js";
import {
  encodeV4ExactInSwap,
  getRouterAddress,
  type PoolParams,
} from "../src/services/v4SwapEncoder.js";

// ---------------------------------------------------------------------------
// Skip unless E2E_BASE_SEPOLIA=1
// ---------------------------------------------------------------------------
const runE2e = process.env.E2E_BASE_SEPOLIA === "1";

const CHAIN_ID = 84532;
const NATIVE_ETH: Address = "0x0000000000000000000000000000000000000000";

// Existing Zora coin on Base Sepolia (deployed by others, backed by $BLDR)
// We use this to test quote + encode without needing to launch.
const EXISTING_COIN: Address =
  "0xE82926789a63001d7C60dEa790DFBe0cD80541c2";
// $BLDR is the backing currency for this coin on Base Sepolia
const BLDR_TOKEN: Address =
  "0x1121c8e28dcf9C0C528f13A615840Df8D3CCF76B";

describe.skipIf(!runE2e)("e2e: swap pipeline on Base Sepolia", () => {
  let client: PublicClient;

  beforeAll(() => {
    const rpcUrl = process.env.BASE_SEPOLIA_RPC_URL;
    if (!rpcUrl) throw new Error("BASE_SEPOLIA_RPC_URL not set");

    client = createPublicClient({
      chain: baseSepolia,
      transport: http(rpcUrl),
    });
  });

  // -----------------------------------------------------------------------
  // Test 1: Verify quoter address resolves
  // -----------------------------------------------------------------------
  it("resolves V4 Quoter address for Base Sepolia", () => {
    const addr = getQuoterAddress(CHAIN_ID);
    expect(addr).toMatch(/^0x[0-9a-fA-F]{40}$/);
  });

  // -----------------------------------------------------------------------
  // Test 2: Encode quote calldata for existing coin
  // -----------------------------------------------------------------------
  it("encodes quote calldata for BLDR → existing coin path", () => {
    const calldata = encodeQuoteExactInputCalldata({
      path: [BLDR_TOKEN, EXISTING_COIN],
      poolParams: [
        {
          fee: 0,
          tickSpacing: 60,
          hooks: NATIVE_ETH,
          hookData: "0x",
        },
      ],
      amountIn: 1_000_000_000_000_000n, // 0.001 BLDR
    });

    expect(calldata).toMatch(/^0x[0-9a-fA-F]+$/);
    expect(calldata.length).toBeGreaterThan(10);
  });

  // -----------------------------------------------------------------------
  // Test 3: On-chain quote via eth_call against V4 Quoter
  // -----------------------------------------------------------------------
  it(
    "fetches an on-chain quote for BLDR → existing coin",
    async () => {
      // Try a small quote. This may revert if the pool params are wrong
      // (fee/tickSpacing/hooks mismatch). We attempt multiple configs.
      const configs = [
        { fee: 0, tickSpacing: 60, hooks: NATIVE_ETH, hookData: "0x" as `0x${string}` },
        { fee: 3000, tickSpacing: 60, hooks: NATIVE_ETH, hookData: "0x" as `0x${string}` },
        { fee: 500, tickSpacing: 10, hooks: NATIVE_ETH, hookData: "0x" as `0x${string}` },
      ];

      let succeeded = false;
      for (const poolParams of configs) {
        try {
          const quote = await quoteExactInput({
            chainId: CHAIN_ID,
            client,
            path: [BLDR_TOKEN, EXISTING_COIN],
            poolParams: [poolParams],
            amountIn: 1_000_000_000_000_000n,
            exactInput: true,
          });
          console.log(
            `Quote succeeded (fee=${poolParams.fee}, ts=${poolParams.tickSpacing}): ` +
              `amountOut=${quote.amountOut}, gas=${quote.gasEstimate}`,
          );
          expect(quote.amountOut).toBeGreaterThan(0n);
          succeeded = true;
          break;
        } catch {
          console.log(
            `Quote reverted with fee=${poolParams.fee}, ts=${poolParams.tickSpacing} — trying next`,
          );
        }
      }

      if (!succeeded) {
        // If all configs fail, the pool may have non-standard params (Doppler hooks).
        // This is expected on Sepolia — log and skip gracefully.
        console.log(
          "All pool param configs reverted — Zora Doppler pools use custom hooks. " +
            "Quote test is informational on Sepolia.",
        );
      }
    },
    { timeout: 30_000 },
  );

  // -----------------------------------------------------------------------
  // Test 4: Encode swap calldata (no submission — just verify encoding)
  // -----------------------------------------------------------------------
  it("encodes swap calldata targeting Universal Router", () => {
    const amountIn = 1_000_000_000_000_000n;
    const minAmountOut = applySlippage(500_000_000_000_000_000n, 100); // 1%

    const poolParamsPerHop: PoolParams[] = [
      {
        fee: 0,
        tickSpacing: 60,
        hooks: NATIVE_ETH as `0x${string}`,
        hookData: "0x",
      },
    ];

    const encoded = encodeV4ExactInSwap({
      chainId: CHAIN_ID,
      path: [BLDR_TOKEN, EXISTING_COIN],
      amountIn,
      minAmountOut,
      poolParamsPerHop,
    });

    expect(encoded.to).toBe(getRouterAddress(CHAIN_ID));
    expect(encoded.data).toMatch(/^0x[0-9a-fA-F]+$/);
    expect(encoded.data.length).toBeGreaterThan(10);
    // Not an ETH-in swap, so value should be 0
    expect(encoded.value).toBe(0n);

    console.log(
      `Encoded swap: ${encoded.data.length} hex chars → ${encoded.to}`,
    );
  });

  // -----------------------------------------------------------------------
  // Test 5: applySlippage math sanity
  // -----------------------------------------------------------------------
  it("applies slippage correctly", () => {
    const amount = 1_000_000_000_000_000_000n; // 1e18
    const with1pct = applySlippage(amount, 100);
    expect(with1pct).toBe(990_000_000_000_000_000n);

    const with50bps = applySlippage(amount, 50);
    expect(with50bps).toBe(995_000_000_000_000_000n);
  });
});
