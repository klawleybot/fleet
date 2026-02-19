# E2E Readiness Report — Fleet V4 Swap Pipeline

**Last updated:** 2026-02-19

## Test Inventory

| Layer | File | Tests | Status |
|-------|------|-------|--------|
| V4 Swap Encoder | `v4-swap-encoder.spec.ts` | 11 | ✅ Pass |
| V4 Quoter | `v4-quoter.spec.ts` | 16 | ✅ Pass |
| Coin Launcher | `coin-launcher.spec.ts` | 5 | ✅ Pass |
| Swap Routing | `swap-route.spec.ts` | 6 | ✅ Pass |
| Bundler Config | `bundler-config.spec.ts` | 4 | ✅ Pass |
| API + Policy | `e2e.api-policy.spec.ts` | 5 | ✅ Pass |
| Fleet E2E (Anvil) | `e2e.fleet.spec.ts` | 1 | ✅ Pass |
| Autonomy Soak | `e2e.autonomy-soak.spec.ts` | 1 | ✅ Pass |
| **Swap Lifecycle (Base Sepolia)** | `e2e.swap-lifecycle.spec.ts` | 4 | ⏭️ Skipped (needs `E2E_BASE_SEPOLIA=1`) |
| **Total** | | **53 pass, 4 skipped** | |

## Pipeline Components

### ✅ Complete

1. **V4 Swap Encoder** (`v4SwapEncoder.ts`)
   - Pure viem calldata encoder: V4_SWAP → SWAP_EXACT_IN → SETTLE_ALL → TAKE_ALL
   - Deterministic — no OPEN_DELTA sentinels, explicit amounts everywhere
   - Multi-hop support via PathKey[] encoding

2. **V4 Quoter** (`v4Quoter.ts`)
   - On-chain quote via `eth_call` against V4 Quoter contract
   - `quoteExactInput()` — returns amountOut, sqrtPriceX96After, gas estimate
   - `applySlippage()` — BPS-based with correct floor rounding
   - WETH→address(0) mapping for native ETH

3. **Quoter Wired into cdp.ts**
   - Local signer path now pre-quotes before encoding swap
   - `minAmountOut` derived from quote + `slippageBps` (no more `0n` placeholder)

4. **Coin Launcher** (`coinLauncher.ts`)
   - Deploy test Zora coins via ZoraFactory in one tx
   - Parses CoinCreated events for coin address extraction
   - ETH-backed coins only (Base Sepolia constraint)

5. **E2E Swap Lifecycle Test** (`e2e.swap-lifecycle.spec.ts`)
   - Launch coin → quote → encode → submit swap
   - Gated behind `E2E_BASE_SEPOLIA=1` env var
   - Uses doppler env (`onchain-tooling/dev`) for keys + RPC

### Contract Addresses

| Contract | Base | Base Sepolia |
|----------|------|-------------|
| Universal Router | `0x6ff5...9b43` | `0x492e...4104` |
| V4 Quoter | `0x0d5e...48d` | `0x4a65...1cba` |
| PoolManager | `0x4985...2b2b` | `0x05E7...3408` |
| ZoraFactory | `0x7777...aF3` | `0x7777...aF3` |

## Running the E2E Test

```bash
# From fleet root
E2E_BASE_SEPOLIA=1 doppler run --project onchain-tooling --config dev -- \
  yarn workspace @fleet/server test -- tests/e2e.swap-lifecycle.spec.ts
```

## Remaining Gaps

1. **Pool params discovery** — e2e test uses default params (fee=0, tickSpacing=60). Production should discover actual pool params from on-chain state or Zora API.
2. **Sell path** — only buy (ETH→coin) is wired. Sell (coin→ETH) needs approve + reverse path encoding.
3. **Multi-hop production routes** — tested in unit tests, but no e2e coverage for WETH→ZORA→coin paths yet.
4. **Gas estimation** — quoter returns gas estimate but it's not used for gas limit tuning yet.

## Next Steps

1. Run the e2e test on Base Sepolia with live doppler env
2. Fix any pool param issues discovered during live test
3. Wire sell path (coin→ETH) with approval flow
4. Add production pool params discovery
