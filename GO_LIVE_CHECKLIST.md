# Base Go-Live Checklist (AA + External Bundler)

## 0) Hard Rules
- No CDP submission path in production execution.
- No silent fallback to direct EOA sends.
- AA/bundler failures must fail loud with actionable errors.

## 1) Environment & Secrets
- `APP_NETWORK=base` (or `base-sepolia` for final rehearsal)
- `SIGNER_BACKEND=local`
- `CDP_MOCK_MODE=false`
- `BUNDLER_PRIMARY_NAME=pimlico`
- `PIMLICO_BASE_BUNDLER_URL` (mainnet)
- `PIMLICO_BASE_SEPOLIA_BUNDLER_URL` (rehearsal)
- `LOCAL_SIGNER_SEED` or `MASTER_WALLET_PRIVATE_KEY`
- Master wallet funded for expected operation budget

## 2) Safety Controls
- `FLEET_KILL_SWITCH=false` confirmed and toggle path tested
- conservative max amounts configured
- slippage caps configured (`MAX_SLIPPAGE_BPS`)
- allowlist/watchlist policy configured (`ALLOWED_COIN_ADDRESSES`, watchlist gates)
- cooldown configured (`CLUSTER_COOLDOWN_SEC`)
- auto-approval scoped to explicit requester and op types only

## 3) Infra Preflight
- RPC healthy for target chain
- Bundler endpoint reachable and authorized
- Entrypoint matches expected chain/version
- DB path writable and healthy
- `/health` endpoint green

## 4) Test Gates (must pass)
From `packages/server`:
- `npm run typecheck`
- `npm run test:e2e`
- `doppler run -- npm run test:e2e:base-live` (base-sepolia rehearsal)

## 5) Live Rehearsal (Base Sepolia)
- Run tiny funding operation end-to-end
- Confirm operation status transitions: `pending -> executing -> complete`
- Confirm `userOpHash` and `txHash` recorded in history
- Confirm no hidden fallback path used
- Confirm failures (if induced) are loud and descriptive

## 6) Mainnet Launch Steps
1. Start with one small cluster and tiny notional.
2. Run one manual funding + one manual support operation.
3. Verify onchain tx + internal history consistency.
4. Increase cluster count/notional gradually.
5. Enable autonomy only after repeated clean manual runs.

## 7) Rollback Plan
- Set `FLEET_KILL_SWITCH=true` to halt execution.
- Revert to last known-good deployment/config.
- Keep approval gating strict during recovery.
- Capture logs: userOpHash, txHash, provider, and error payload.

## 8) Post-Launch Monitoring (first 24h)
- success/failure ratio by operation type
- avg inclusion latency (userOp sent -> receipt)
- bundler error categories
- unexpected policy rejects
- wallet balance drift / gas spend vs expectation
