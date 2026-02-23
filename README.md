# Pump It Up

Local control plane for managing a fleet of Coinbase CDP Smart Accounts on Base.

## What it does

- Create a master smart account and a fleet of smart accounts
- Track wallet state in SQLite
- Distribute ETH from the master wallet to selected fleet wallets
- Execute coordinated swaps across selected wallets (`cdp` backend supports smartAccount.swap(); `local` backend currently supports native ETH transfer flow and custom call execution, with swap routing to be added)
- Manage wallet clusters and operation requests (`FUNDING_REQUEST`, `SUPPORT_COIN`, `EXIT_COIN`)
- Execute cluster strategies (`sync`, `staggered`, `momentum` placeholder behavior)
- View latest funding and trade results in a web UI

## Setup

1. Install dependencies with yarn install
2. Add env vars for one signer backend:
   - `SIGNER_BACKEND=local` (default): `LOCAL_SIGNER_SEED` (required), optional `MASTER_WALLET_PRIVATE_KEY` to pin master funding wallet
   - `SIGNER_BACKEND=cdp` (explicit opt-in): `CDP_API_KEY_ID`, `CDP_API_KEY_SECRET`, `CDP_WALLET_SECRET`
   - Bundler routing (recommended):
     - `BUNDLER_PRIMARY_NAME=pimlico`
     - `PIMLICO_BASE_BUNDLER_URL`
     - `PIMLICO_BASE_SEPOLIA_BUNDLER_URL`
   - Shared: `BASE_RPC_URL`, `BASE_SEPOLIA_RPC_URL`, `PORT`
   - Optional: `APP_NETWORK=base|base-sepolia` (default `base`)
3. Run backend: yarn dev:server
4. Run frontend: yarn dev:web
5. Open http://localhost:5179

## E2E test harness (Anvil Base/Base-Sepolia fork)

Prereqs:
- Foundry (`anvil`, `forge`, `cast`) installed
  - macOS: `curl -L https://foundry.paradigm.xyz | bash && foundryup`
  - if you see a `libusb` error: `brew install libusb`
- RPC secrets available (recommended via Doppler `openclaw/dev`)
  - `BASE_RPC_URL`
  - `BASE_SEPOLIA_RPC_URL`

Run tests:
```bash
# base mainnet fork
APP_NETWORK=base yarn workspace @pump-it-up/server test:e2e

# base sepolia fork
APP_NETWORK=base-sepolia yarn workspace @pump-it-up/server test:e2e

# both using Doppler
yarn test:e2e:doppler
```

What this validates end-to-end:
- Base fork starts via Anvil
- fleet server boots with CDP mock signer + existing operation flow
- wallet creation, cluster assignment, funding request/execute
- support coin request/execute
- zora signal selection + support-from-signal + autonomy tick auto-approval/execute

## New API (cluster operations)

- `POST /clusters` → create a named wallet cluster
- `PUT /clusters/:id/wallets` → assign wallet ids to a cluster
- `POST /operations/request-funding` → queue a funding request for a cluster
- `POST /operations/support-coin` → queue a cluster buy operation
- `POST /operations/exit-coin` → queue a cluster exit operation
- `GET /operations/zora-signals` → inspect zora-intelligence candidates (`top_momentum` / `watchlist_top`)
- `POST /operations/support-from-zora-signal` → queue a buy operation from signal selection
- `POST /operations/:id/approve-execute` → approve and execute the queued operation
- `GET /autonomy/status` → inspect worker/autonomy status
- `POST /autonomy/start` / `POST /autonomy/stop` → control loop
- `POST /autonomy/tick` → run one autonomous cycle on demand

## Risk controls (env)

- `FLEET_KILL_SWITCH` (default `false`)
- `MAX_FUNDING_WEI` (per-wallet funding ceiling)
- `MAX_TRADE_WEI` (total trade ceiling per operation)
- `MAX_PER_WALLET_WEI` (per-wallet trade/funding cap)
- `MAX_SLIPPAGE_BPS` (default `400`)
- `CLUSTER_COOLDOWN_SEC` (default `45`)
- `REQUIRE_WATCHLIST_COIN` (default `true`; uses zora-intelligence watchlist)
- `REQUIRE_WATCHLIST_NAME` (optional list constraint)
- `ALLOWED_COIN_ADDRESSES` (comma-separated coin allowlist)
- `ZORA_INTEL_DB_PATH` (path to `zora-intelligence` sqlite db)
- `FLEET_WATCHLIST_NAME` (watchlist for auto-tracking positions; default `Active Positions`)

## Autonomy + owner approval policy (env)

- `AUTONOMY_ENABLED` (master toggle)
- `AUTONOMY_AUTO_START` (start loop on server boot)
- `AUTONOMY_INTERVAL_SEC` (tick cadence)
- `AUTONOMY_CLUSTER_IDS` (comma-separated cluster ids to manage)
- `AUTONOMY_SIGNAL_MODE` (`watchlist_top` or `top_momentum`)
- `AUTONOMY_WATCHLIST_NAME` (optional watchlist filter)
- `AUTONOMY_MIN_MOMENTUM` (for `top_momentum` mode)
- `AUTONOMY_TOTAL_AMOUNT_WEI`, `AUTONOMY_SLIPPAGE_BPS`
- `AUTONOMY_STRATEGY_MODE` (`sync|staggered|momentum` override)
- `AUTONOMY_REQUESTED_BY` (default requester tag)
- `AUTONOMY_CREATE_REQUESTS` and `AUTONOMY_AUTO_APPROVE_PENDING`

Auto-approval constraints:
- `AUTO_APPROVE_ENABLED`
- `AUTO_APPROVE_APPROVER`
- `AUTO_APPROVE_REQUESTERS` (comma list)
- `AUTO_APPROVE_OPERATION_TYPES` (default `SUPPORT_COIN`)
- `AUTO_APPROVE_MAX_FUNDING_WEI`
- `AUTO_APPROVE_MAX_TRADE_WEI`

## Continuous validation on every update
- GitHub Actions workflow: `.github/workflows/ci.yml`
- Runs on push + PR: server typecheck + E2E harness on Anvil fork
