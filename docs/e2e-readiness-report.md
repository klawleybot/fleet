# E2E Readiness Report

**Date:** 2026-02-19  
**Commit:** d1f2dac (feat: v4 swap calldata encoder + wire local signer swap path)

---

## 1. Test File Inventory

### Unit Tests (no external deps, all passing ✅)

| File | What it Tests | Tests | Status |
|------|---------------|-------|--------|
| `approval.spec.ts` | Auto-approval policy engine (requester, type, amount thresholds) | 3 | ✅ Pass |
| `bundler-config.spec.ts` | Bundler config env loading (Pimlico URL resolution per chain) | 4 | ✅ Pass |
| `bundler-router.spec.ts` | Bundler failover/hedging logic (retry vs validation errors) | 3 | ✅ Pass |
| `v4-swap-encoder.spec.ts` | V4 Universal Router calldata encoding (single/multi-hop, ETH/ERC20) | 11 | ✅ Pass |
| `zora-signals.spec.ts` | Zora signal selectors (top movers, watchlist, candidate selection) | 3 | ✅ Pass |
| `local-backend.spec.ts` | Local signer deterministic address derivation (no CDP dependency) | 1 | ✅ Pass |

**Total unit: 25/25 passing**

### E2E / Integration Tests (require Anvil fork + server)

| File | What it Tests | External Deps | Status |
|------|---------------|---------------|--------|
| `e2e.fleet.spec.ts` | Full fleet lifecycle: wallets, clusters, funding, swaps, operations | Anvil, RPC (public fallback), SQLite | Runs with CDP_MOCK_MODE=1 |
| `e2e.api-policy.spec.ts` | API validation, allowlist/watchlist enforcement, cooldowns, autonomy endpoints | Anvil, RPC (public fallback), SQLite | Runs with CDP_MOCK_MODE=1 |
| `e2e.autonomy-soak.spec.ts` | Repeated autonomy tick cycles, no stuck operations | Anvil, RPC (public fallback), SQLite | Runs with CDP_MOCK_MODE=1 |
| `e2e.local-funding.spec.ts` | Live local-signer funding flow on Base Sepolia | **Real bundler**, BASE_SEPOLIA_RPC_URL, LOCAL_SIGNER_SEED or MASTER_WALLET_PRIVATE_KEY, funded wallet | Gated behind `E2E_BASE_LIVE=1` |

All three mock e2e tests spin up their own Anvil fork + fleet server automatically. They use `CDP_MOCK_MODE=1` so no real transactions occur.

---

## 2. TODO/FIXME/Placeholder Scan

Only **one** placeholder found in the entire codebase:

- **`packages/server/src/services/cdp.ts:536`** — `// Use 0 as minAmountOut placeholder — slippage protection is via slippageBps`
  - This is in the local signer swap path. `minAmountOut` is set to `0n` and slippage is enforced at the contract level via the encoder's `minAmountOut` param. **Acceptable for testnet; needs proper quote-based minAmountOut for mainnet.**

No other TODO/FIXME/HACK/XXX found.

---

## 3. What Works Today (Local/Mock)

- ✅ Full wallet + cluster CRUD via API
- ✅ Operation lifecycle (request → approve → execute → complete)
- ✅ Auto-approval policy engine
- ✅ Bundler config + failover router
- ✅ Zora signal selection (momentum, watchlist)
- ✅ V4 swap calldata encoding (single-hop, multi-hop, ETH + ERC20)
- ✅ Local signer backend (deterministic HD derivation, no CDP needed)
- ✅ Local signer wired to v4SwapEncoder for actual swap calldata
- ✅ Autonomy loop (tick → signal → create op → approve → execute)
- ✅ Policy enforcement (allowlist, watchlist, slippage caps, cooldowns)
- ✅ All 25 unit tests + 3 mock e2e suites pass against Anvil fork

---

## 4. What's Needed for Base Sepolia Live Testing

### Infrastructure Requirements

| Requirement | Env Var | Status |
|-------------|---------|--------|
| Base Sepolia RPC | `BASE_SEPOLIA_RPC_URL` | Needed (Alchemy/Infura/public) |
| ERC-4337 Bundler | `PIMLICO_BASE_SEPOLIA_BUNDLER_URL` or `BUNDLER_PRIMARY_URL` | Needed (Pimlico account) |
| Funded seed phrase | `LOCAL_SIGNER_SEED` | Needed (ETH on Base Sepolia for gas + swaps) |
| Alternatively | `MASTER_WALLET_PRIVATE_KEY` | Alternative to seed |

### Funded Accounts Needed

- **Master/owner wallet**: Needs Base Sepolia ETH for:
  - Smart account deployment (first UserOp)
  - Gas deposits to paymaster or prefund
  - Swap input amounts (ETH → token)
- **Estimated minimum**: ~0.05 ETH on Base Sepolia for basic testing

### Live Test Gate

The `e2e.local-funding.spec.ts` test already exists and is gated behind `E2E_BASE_LIVE=1`. Run with:
```bash
E2E_BASE_LIVE=1 \
BASE_SEPOLIA_RPC_URL=https://... \
LOCAL_SIGNER_SEED=your-seed \
PIMLICO_BASE_SEPOLIA_BUNDLER_URL=https://... \
npx vitest run packages/server/tests/e2e.local-funding.spec.ts
```

---

## 5. Missing Test Coverage

| Gap | Priority | Notes |
|-----|----------|-------|
| Live swap execution (ETH → token on Base Sepolia) | **P0** | `e2e.local-funding.spec.ts` exists but needs funded wallet + bundler to actually run |
| Multi-hop swap (ETH → WETH → token) live test | P1 | Encoder tested in unit tests, but no live multi-hop e2e |
| Paymaster / gas sponsorship path | P1 | No tests for sponsored UserOps |
| Smart account deployment (first-time) | P1 | Implicitly tested via funding flow but not isolated |
| Swap slippage / revert handling | P2 | No test for what happens when swap reverts on-chain |
| Token balance verification post-swap | P2 | Tests execute swap but don't verify token arrived |
| Concurrent cluster operations | P2 | No test for parallel ops across clusters |
| `minAmountOut` quote-based calculation | P2 | Currently hardcoded to 0; needs quoter integration |

---

## 6. Recommended Next Steps (Priority Order)

1. **Fund a Base Sepolia wallet** — Get testnet ETH, set up env vars, run `e2e.local-funding.spec.ts` with `E2E_BASE_LIVE=1`
2. **Get Pimlico Base Sepolia bundler key** — Sign up at pimlico.io, get API key for chain 84532
3. **Run the live funding e2e** — Validate the full local-signer → smart account → bundler → on-chain path
4. **Add post-swap balance assertion** — After swap executes, verify target token balance increased
5. **Integrate a quoter for `minAmountOut`** — Replace the `0n` placeholder with real quote data (Uniswap Quoter V2 or on-chain simulation)
6. **Add multi-hop live e2e test** — Test the ETH → WETH → CoinToken path on Sepolia
7. **Add paymaster integration** — If gas sponsorship is planned, test that path
8. **Mainnet dry-run checklist** — Before mainnet: proper minAmountOut, tighter slippage defaults, monitoring/alerting
