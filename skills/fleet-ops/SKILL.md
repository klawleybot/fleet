---
name: fleet-ops
description: Operate Zora coin trading fleets — create fleets, fund wallets, buy/sell coins with drip+jiggle, monitor P&L, sweep ETH. For Kelley or Flick.
---

# Fleet Ops Skill

Multi-wallet Zora coin trading on Base. Creates fleets of smart account wallets that buy/sell coins with randomized timing and amounts to avoid detection.

## Setup

**Read first:** `docs/OPERATIONS.md` in the fleet repo for full API reference.

**Repo:** `/Users/user/.openclaw/workspace/fleet` (yarn workspaces, server at `packages/server/`)

**Start server:**
```bash
cd /Users/user/.openclaw/workspace/fleet
doppler run --project onchain-tooling --config dev -- \
  SIGNER_BACKEND=local CDP_MOCK_MODE=0 APP_NETWORK=base PORT=4001 \
  FLEET_KILL_SWITCH=false MAX_PER_WALLET_WEI=10000000000000000 \
  npx tsx packages/server/src/index.ts
```

Or for one-off ops, use direct script execution (more reliable than HTTP server).

## How to Handle Requests

### "Buy [coin] with [N] wallets"

1. Check dashboard: `GET /dashboard` — confirm available ETH
2. Create fleet (if needed): `POST /fleets` with `name`, `wallets`, `fundAmountWei`
   - Pre-validates funding — will tell you if master needs more ETH
3. Buy: `POST /fleets/:name/buy` with `coin`, `totalAmountWei`, `slippageBps: 300`
   - Add `overMs` and `intervals` for drip (spread over time)
   - Jiggle is ON by default (±15% per-wallet variance)
4. Report: `GET /dashboard/fleet/:name` — show positions and P&L

### "Sell [coin]" or "Exit"

1. Sell: `POST /fleets/:name/sell` with `coin`, `slippageBps: 300`
2. Report P&L: `GET /dashboard/fleet/:name`
3. Optional sweep: `POST /fleets/:name/sweep` to consolidate ETH back to master

### "How are we doing?" / "Status"

1. `GET /dashboard` — global view: master balance, all fleets, total ETH, global P&L
2. For specific fleet: `GET /dashboard/fleet/:name`

### "Move ETH from X to Y"

Use sweep: `POST /fleets/:name/sweep` with `targetFleet` or `targetAddress`

## Key Facts

- **Route auto-discovery**: No need to specify paths. System reads on-chain coin ancestry.
- **3-hop paths common**: coin → parent → ZORA → ETH. Quoted per-hop (Doppler hooks block multi-hop).
- **Slippage**: Use 300 bps (3%) for Doppler pools. Tighter for simple pools.
- **Gas**: ~0.0003 ETH per UserOp on Base. Budget per wallet = trade amount + (gas × number of trades).
- **Permit2**: Required for sells. Handled automatically.
- **Jiggle**: Randomizes per-wallet amounts (±15%). Total is always preserved exactly.
- **Drip**: Spreads buys over time in intervals. Random jitter within each interval.

## Talking to Kelley vs Flick

- **Kelley**: Use plain language. "Your fleet bought 0.005 ETH of the coin across 5 wallets over 10 minutes. You're up 0.0007 ETH so far."
- **Flick**: Technical details welcome. Include tx hashes, per-wallet breakdowns, gas costs.

## Running Tests

```bash
cd /Users/user/.openclaw/workspace/fleet
yarn test    # 109+ tests, all should pass
```
