# E2E Readiness Report — Fleet V4 Swap Pipeline

**Last updated:** 2026-02-19 (post-mainnet validation)

## Test Inventory

| Layer | File | Tests | Status |
|-------|------|-------|--------|
| V4 Swap Encoder | `v4-swap-encoder.spec.ts` | 11 | ✅ Pass |
| V4 Quoter | `v4-quoter.spec.ts` | 16 | ✅ Pass |
| Coin Launcher | `coin-launcher.spec.ts` | 5 | ✅ Pass |
| Swap Routing | `swap-route.spec.ts` | 6 | ✅ Pass |
| Sell Route + ERC20 | `sell-route.spec.ts` | 5 | ✅ Pass |
| Pool Discovery | `pool-discovery.spec.ts` | 7 | ✅ Pass |
| Coin Route Resolver | `coin-route.spec.ts` | 5 | ✅ Pass |
| Bundler Config | `bundler-config.spec.ts` | 4 | ✅ Pass |
| API + Policy | `e2e.api-policy.spec.ts` | 5 | ✅ Pass |
| Fleet E2E (Anvil) | `e2e.fleet.spec.ts` | 1 | ✅ Pass |
| Fleet Roundtrip | `e2e.fleet-roundtrip.spec.ts` | 1 | ✅ Pass |
| Autonomy Soak | `e2e.autonomy-soak.spec.ts` | 1 | ✅ Pass |
| Local Backend | `local-backend.spec.ts` | 1 | ✅ Pass |
| **Swap Lifecycle (Sepolia)** | `e2e.swap-lifecycle.spec.ts` | 4 | ⏭️ Skipped (`E2E_BASE_SEPOLIA=1`) |
| **Mainnet Buy+Sell** | `e2e.mainnet-swap.spec.ts` | 4 | ⏭️ Skipped (`E2E_BASE_MAINNET=1`) |
| **Total** | | **73 pass, 12 skipped** | |

## Mainnet Validation ✅

Full roundtrip executed on Base mainnet (2026-02-19):

| Step | Tx | Details |
|------|-----|---------|
| Buy | `0xe668...2344` | 0.001 ETH → 11.17T coin (3-hop: ETH→ZORA→kelleymiller→coin) |
| Permit2 Approve | `0xe3d5...0813` | coin→Permit2, Permit2→Router approvals |
| Sell | `0x7e27...17c` | All coins → 0.000914 ETH recovered |
| **Net cost** | | ~0.000086 ETH (~$0.20) in fees + gas |

**Smart Account:** `0x351D...798D` (Coinbase SA v1.1)

### Key Mainnet Findings

- **Permit2 required for sells** — V4 Router uses Permit2 `transferFrom` for `SETTLE_ALL`, not regular ERC20 approve. Flow: `coin.approve(Permit2)` → `Permit2.approve(coin, Router, amount, expiry)` → `V4_SWAP`
- **3-hop quoting works** — Sequential `quoteExactInputSingle` per hop (Doppler hooks block multi-hop `quoteExactInput`)
- **Pool params from storage slots** — `CoinCreatedV4` events not found for older coins; EIP-1167 proxy storage slots contain packed fee/tickSpacing/hooks
- **Pimlico bundler required** — DRPC lacks `eth_estimateUserOperationGas`; must use Pimlico bundler endpoint
- **No paymaster for mainnet** — Self-funded UserOps from smart account ETH balance

## Pipeline Components

### ✅ Complete

1. **V4 Swap Encoder** (`v4SwapEncoder.ts`)
   - Pure viem calldata: V4_SWAP → SWAP_EXACT_IN → SETTLE_ALL → TAKE_ALL
   - Deterministic — no OPEN_DELTA sentinels, explicit amounts everywhere
   - Multi-hop support via PathKey[]

2. **V4 Quoter** (`v4Quoter.ts`)
   - On-chain `eth_call` against V4 Quoter contract
   - `quoteExactInput()` + `quoteExactInputSingle()` + `applySlippage()`
   - WETH→address(0) mapping for native ETH

3. **Pool Discovery** (`poolDiscovery.ts`)
   - Strategy 1: CoinCreatedV4 events from ZoraFactory
   - Strategy 2: Storage slot fallback for older EIP-1167 proxy coins
   - Reads fee, tickSpacing, hooks from packed storage layout

4. **Coin Route Resolver** (`coinRoute.ts`)
   - Full ancestry walk via `currency()` calls (coin → parent → ... → ZORA)
   - Storage slot reading for pool params at each hop
   - Returns complete buy/sell paths with pool params

5. **ERC20 + Permit2** (`erc20.ts`)
   - `ensurePermit2Approval()` — checks allowances, returns needed approve calls
   - `PERMIT2_ADDRESS`, `encodePermit2Approve` for V4 Router compatibility

6. **Sell Path** (wired in `cdp.ts`)
   - Detects sells (fromToken ≠ root), uses reverse route
   - Permit2 approval flow prepended to swap call
   - WETH→address(0) mapping on last path element

7. **Fleet Coordination** (clusters + operations)
   - Multi-wallet clusters with sync/staggered strategies
   - Support-coin (buy) + exit-coin (sell) operations
   - Autonomy worker with auto-approve policies
   - Fleet-of-2 roundtrip validated in e2e test

### Contract Addresses

| Contract | Base | Base Sepolia |
|----------|------|-------------|
| Universal Router | `0x6ff5693b99212da76ad316178a184ab56d299b43` | `0x492e6456d9528771018deb9e87ef7750ef184104` |
| V4 Quoter | `0x0d5e0f971ed27fbff6c2837bf31316121532048d` | `0x4a6513c898fe1b2d0e78d3b0e0a4a151589b1cba` |
| PoolManager | `0x498581ff718922c3f8e6a244956af099b2652b2b` | `0x05E73354cFDd6745C338b50BcFDfA3Aa6fA03408` |
| ZoraFactory | `0x777777751622c0d3258f214F9DF38E35BF45baF3` | `0xaF88840cb637F2684A9E460316b1678AD6245e4a` |
| Permit2 | `0x000000000022D473030F116dDEE9F6B43aC78BA3` | same |
| ZORA Token | `0x1111111111166b7FE7bd91427724B487980aFc69` | — |
| WETH | `0x4200000000000000000000000000000000000006` | same |

## Running Tests

```bash
# Unit + integration (73 tests)
yarn workspace @fleet/server test

# Base Sepolia e2e (needs doppler env)
E2E_BASE_SEPOLIA=1 doppler run --project onchain-tooling --config dev -- \
  yarn workspace @fleet/server test -- tests/e2e.swap-lifecycle.spec.ts

# Base mainnet e2e (needs doppler env, costs ~$0.20)
E2E_BASE_MAINNET=1 doppler run --project onchain-tooling --config dev -- \
  yarn workspace @fleet/server test -- tests/e2e.mainnet-swap.spec.ts
```

## Remaining Work

1. **Gas estimation tuning** — Quoter returns gas estimate but not used for gas limit optimization
2. **Multi-agent fleet coordination** — Autonomy worker + signal-driven buys/sells at scale
3. **Zora coin intelligence integration** — Wire zora-intelligence analytics into signal selection
4. **Production monitoring** — Trade P&L tracking, position management dashboard
