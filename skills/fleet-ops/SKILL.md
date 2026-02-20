---
name: fleet-ops
description: Operate Zora coin trading fleets — create fleets, fund wallets, buy/sell coins with drip+jiggle, monitor P&L, sweep ETH. Start/stop fleet server. For Kelley or Flick.
---

# Fleet Ops Skill

Multi-wallet Zora coin trading on Base. Creates fleets of smart account wallets that buy/sell coins with randomized timing and amounts to avoid detection.

## Repo & Layout

- **Repo:** `/Users/user/.openclaw/workspace/fleet`
- **Server:** `packages/server/`
- **CLI:** `packages/server/src/cli/fleet-ops.ts` (trading ops)
- **Service:** `packages/server/src/cli/fleet-service.ts` (start/stop server)

## Two Modes of Operation

### 1. CLI Mode (Recommended for one-off ops)

Direct script execution — no server needed. Uses Doppler for secrets.

```bash
cd /Users/user/.openclaw/workspace/fleet/packages/server
doppler run --project onchain-tooling --config dev -- npx tsx src/cli/fleet-ops.ts <command>
```

**Commands:**

| Command | Description |
|---------|-------------|
| `route <coin>` | Resolve swap path and quote |
| `buy <coin> --amount-eth 0.002 --slippage 500` | Buy from master wallet |
| `sell <coin> --slippage 500` | Sell all from master wallet |
| `status [coin]` | Master wallet balances |
| `verify` | Check key↔DB consistency |
| `fleet list` | List all fleets |
| `fleet create <name> --wallets N [--fund-eth 0.001]` | Create fleet + fund |
| `fleet status <name> [--refresh]` | Fleet positions & P&L |
| `fleet buy <name> <coin> --amount-eth 0.01 [--over 10m] [--slippage 500]` | Fleet buy (drip if --over) |
| `fleet sell <name> <coin> --amount-eth 0.01 [--over 10m] [--slippage 500]` | Fleet sell |
| `fleet sweep <name> [--to-fleet X \| --to-address 0x...]` | Sweep ETH |

**Drip flags:** `--over 10m` (duration), `--intervals N`, `--no-jiggle`

### 2. Server Mode (For persistent API access)

Fleet HTTP server managed via PM2.

```bash
cd /Users/user/.openclaw/workspace/fleet/packages/server
doppler run --project onchain-tooling --config dev -- npx tsx src/cli/fleet-service.ts <command>
```

| Command | Description |
|---------|-------------|
| `start` | Start server (PM2 + Doppler, port 4020) |
| `stop` | Stop server |
| `restart` | Restart server |
| `status` | PM2 status + health check |
| `logs` | Tail server logs |
| `health` | Hit /health endpoint |

**API endpoints (when server is running):**

- `GET /health` — health check
- `GET /dashboard` — global P&L, master balance, all fleets
- `GET /dashboard/fleet/:name` — fleet-specific P&L
- `POST /fleets` — create fleet `{name, wallets, fundAmountWei}`
- `GET /fleets` — list fleets
- `GET /fleets/:name/status` — fleet status
- `POST /fleets/:name/buy` — `{coinAddress, totalAmountWei, slippageBps, overMs?}`
- `POST /fleets/:name/sell` — same params
- `POST /fleets/:name/sweep` — `{targetFleet?, targetAddress?}`

## How to Handle Requests

### "Buy [coin] with [N] wallets"

**Prefer CLI mode** for one-off operations:

1. Route check: `fleet-ops route <coin>` — confirm path exists
2. Create fleet (if needed): `fleet-ops fleet create alpha --wallets 5 --fund-eth 0.001`
3. Buy: `fleet-ops fleet buy alpha <coin> --amount-eth 0.005 --over 10m --slippage 500`
4. Status: `fleet-ops fleet status alpha --refresh`

### "Sell [coin]" / "Exit"

1. `fleet-ops fleet sell alpha <coin> --amount-eth <total> --slippage 500`
2. Check P&L: `fleet-ops fleet status alpha`
3. Optional sweep: `fleet-ops fleet sweep alpha`

### "Start/stop the server"

1. `fleet-service start` — starts via PM2 with Doppler secrets
2. `fleet-service status` — shows process info + health
3. `fleet-service stop` — graceful shutdown

### "Quick master-only trade"

For fast trades without setting up a fleet:
1. `fleet-ops buy <coin> --amount-eth 0.002 --slippage 500`
2. `fleet-ops sell <coin> --slippage 500`

## Key Facts

- **Route auto-discovery**: No need to specify paths. System reads on-chain coin ancestry.
- **3-hop paths common**: coin → parent → ZORA → ETH. Quoted per-hop (Doppler hooks block multi-hop).
- **Slippage**: Use 300-500 bps for Doppler pools.
- **Gas**: ~0.0003 ETH per UserOp on Base.
- **Permit2**: Required for sells. Handled automatically.
- **Jiggle**: Randomizes per-wallet amounts (±15%). Total preserved exactly.
- **Drip**: Spreads buys over time with random jitter within intervals.
- **Smart Accounts**: All wallets are Coinbase Smart Accounts (4337). Owner key ≠ smart account address (by design).
- **Key validation**: Server validates key↔DB consistency on every startup.

## Talking to Kelley vs Flick

- **Kelley**: Plain language. "Your fleet bought 0.005 ETH of the coin across 5 wallets over 10 minutes."
- **Flick**: Technical details welcome. Tx hashes, per-wallet breakdowns, gas costs.

## Tests

```bash
cd /Users/user/.openclaw/workspace/fleet
yarn test    # 109+ tests
```

## Troubleshooting

- **Key mismatch on startup**: Run `fleet-ops verify` to diagnose. Either restore the correct key or delete the DB master record.
- **Server won't start**: Check `fleet-service logs` for crash reason.
- **Bundler errors**: Verify `PIMLICO_BASE_BUNDLER_URL` is set in Doppler.
- **"HookNotImplemented"**: Doppler pools block multi-hop quoting. System auto-falls back to per-hop.
