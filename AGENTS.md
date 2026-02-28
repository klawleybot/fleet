# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Development
yarn dev:server          # backend (tsx watch, port 4020)
yarn dev:web             # frontend (Vite, port 5179)

# Tests
yarn test                # unit tests (vitest run, CDP_MOCK_MODE=1 auto-set)
yarn workspace @pump-it-up/server test   # same, from root

# Run a single test file
yarn workspace @pump-it-up/server vitest run tests/jiggle.spec.ts

# Typecheck
yarn typecheck           # both packages

# E2E (requires Foundry + RPC env vars)
APP_NETWORK=base yarn workspace @pump-it-up/server test:e2e
APP_NETWORK=base-sepolia yarn workspace @pump-it-up/server test:e2e
yarn test:e2e:doppler    # both networks via Doppler

# Production daemon
pm2 start ecosystem.config.cjs
```

The server default port is `4020`. The DB path defaults to `packages/server/.data/fleet.db`; override with `SQLITE_PATH`.

## Architecture

Yarn workspaces monorepo with two packages:
- **`packages/server`** — Express + better-sqlite3 + viem backend (ESM TypeScript, `tsx watch` in dev)
- **`packages/web`** — React + Vite + Tailwind frontend (reads from `http://localhost:4020`)

### Server layer map

```
src/index.ts              ← Express app, mounts all routers, calls ensureMasterWallet() on start
src/routes/               ← Thin HTTP handlers; delegate to services
src/services/             ← All business logic
src/db/index.ts           ← better-sqlite3 DAO (all SQL lives here)
src/db/schema.ts          ← runMigrations() — additive ALTER TABLE pattern for migrations
src/types.ts              ← Shared TypeScript interfaces (WalletRecord, TradeRecord, OperationRecord, etc.)
```

### Key services

| Service | Responsibility |
|---------|---------------|
| `cdp.ts` | Signer backends (CDP SDK or local/viem), smart account creation, `swapFromSmartAccount()` |
| `wallet.ts` | `ensureMasterWallet()`, `createFleetWallets()` — deterministic smart account derivation |
| `trade.ts` | `strategySwap()`, `coordinatedSwap()`, `dripSwap()`, `jiggleAmounts()` |
| `operations.ts` | Operation lifecycle: `requestFundingOperation()`, `requestSupportCoinOperation()`, `requestExitCoinOperation()`, `approveAndExecuteOperation()` |
| `autonomy.ts` | Background tick loop: signal selection → operation creation → auto-approval |
| `policy.ts` | Risk controls (`getPolicy()`, `assertTradeRequestAllowed()`, `assertFundingRequestAllowed()`) |
| `approval.ts` | Auto-approval policy (`evaluateAutoApproval()`) |
| `zoraSignals.ts` | Reads external `zora-intelligence` SQLite DB for coin signals; watchlist management |
| `network.ts` | `getChainConfig()` — resolves chain/RPC from `APP_NETWORK` env var |
| `bundler/` | ERC-4337 bundler routing (Pimlico primary; fallback logic in `router.ts`) |

### Operation flow

All coordinated trades go through the operations state machine:
```
pending → approved → executing → complete | failed
```
`SUPPORT_COIN` = buy (ETH → coin), `EXIT_COIN` = sell (coin → ETH). The `MAX_TRADE_WEI` / `MAX_PER_WALLET_WEI` risk checks apply only to buys; `EXIT_COIN` skips them since `totalAmountWei` is a raw token amount.

### Signer backends

- **`local`** (default): Derives EOA owner keys from `LOCAL_SIGNER_SEED` via keccak256 hashing of `${seed}:${walletName}`. Uses viem `toCoinbaseSmartAccount` + ERC-4337 bundler.
- **`cdp`**: Delegates to Coinbase CDP SDK (requires `CDP_API_KEY_ID`, `CDP_API_KEY_SECRET`, `CDP_WALLET_SECRET`).
- **`CDP_MOCK_MODE=1`**: Skips all on-chain calls; returns synthetic results. All unit tests run in mock mode automatically.

### Zora Intelligence integration

`zoraSignals.ts` connects read-only to a sibling SQLite database at `../zora-intelligence/data/zora-intelligence.db` (override: `ZORA_INTEL_DB_PATH`). The watchlist gate (`REQUIRE_WATCHLIST_COIN=true` by default) blocks buys for coins not in the zora-intelligence watchlist.

## Code standards (from CONTRIBUTING.md)

- **TypeScript strict ESM** — no `as any`, use `satisfies` or structural interfaces
- **Pure viem** — no Uniswap SDK dependencies; all swap encoding is hand-rolled
- **No module-scoped `process.env`** — always read env inside functions so values are testable and not import-order dependent
- **Conventional commits** — `feat|fix|refactor|test|docs|chore|ci|perf(scope): summary`; one logical concern per commit, aim for <300 lines changed

## Testing

Unit tests (`tests/*.spec.ts`, not `e2e.*`) run with `CDP_MOCK_MODE=1` and a temp SQLite DB set by `vitest.config.ts`. E2E tests spin up an Anvil fork of Base/Base-Sepolia and a real server child process; configured in `vitest.e2e.config.ts` with 180s timeouts and `fileParallelism: false`.

To add a new test file it must match `tests/**/*.spec.ts`.
