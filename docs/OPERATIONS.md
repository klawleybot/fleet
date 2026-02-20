# Fleet Operations Guide

How to create, fund, trade, and monitor fleets. Written for operators and agents.

## Quick Reference

| Action | Command/Endpoint | Notes |
|--------|------------------|-------|
| Create fleet | `POST /fleets` | Pre-validates funding |
| Fund fleet | Included in create, or sweep from another | |
| Buy coin | `POST /fleets/:name/buy` | Supports jiggle + drip |
| Sell coin | `POST /fleets/:name/sell` | Handles Permit2 automatically |
| Sweep ETH | `POST /fleets/:name/sweep` | To master, another fleet, or address |
| Fleet status | `GET /dashboard/fleet/:name` | Balances + P&L |
| Global status | `GET /dashboard` | All fleets + master + aggregate P&L |

---

## 1. Creating a Fleet

```bash
POST /fleets
{
  "name": "alpha",
  "wallets": 5,
  "fundAmountWei": "2000000000000000",    # 0.002 ETH per wallet
  "sourceFleetName": "treasury",           # optional: fund from another fleet
  "strategyMode": "sync"                   # sync | staggered | momentum
}
```

**What happens:**
1. Checks funding source (master SA or source fleet) has enough balance for all transfers + gas
2. If insufficient, returns the funding address + exact deficit — no wallets created
3. Creates N deterministic smart account wallets
4. Transfers `fundAmountWei` to each wallet
5. Verifies all wallets received funds on-chain

**Budget planning:** Each wallet needs ETH for:
- Trading amount (what you want to buy with)
- Gas per trade (~0.0003 ETH per UserOp on Base)
- Number of trades planned (buy intervals + sell)

Example: 5 wallets, 0.001 ETH buy each, 2 drip intervals + 1 sell = 3 UserOps × 0.0003 = 0.0009 gas per wallet. Fund ~0.002 ETH per wallet.

## 2. Market Operations

### Buy (with drip + jiggle)

```bash
POST /fleets/:name/buy
{
  "coin": "0x...",
  "totalAmountWei": "5000000000000000",   # 0.005 ETH total across fleet
  "slippageBps": 300,                      # 3% (recommended for Doppler pools)
  "overMs": 600000,                        # drip over 10 minutes
  "intervals": 2,                          # split into 2 rounds
  "jiggle": true,                          # randomize per-wallet amounts (default on)
  "jiggleFactor": 0.15                     # ±15% variance (default)
}
```

**Drip behavior:** Buys are spread across `intervals` rounds over `overMs` duration. Within each round, each wallet executes with random jitter (0-30s). Amounts per wallet are jiggled so no two wallets buy the exact same amount.

### Sell (immediate)

```bash
POST /fleets/:name/sell
{
  "coin": "0x...",
  "slippageBps": 300
}
```

Sells each wallet's full coin balance. Handles Permit2 approval automatically (one-time per coin per wallet).

### Route Discovery

Routes are auto-discovered on-chain. No env vars needed. The system:
1. Reads `currency()` from the coin contract (Zora coins are EIP-1167 clones)
2. Walks the ancestry chain: coin → parent → ... → ZORA → ETH
3. Reads pool params (fee, tickSpacing, hooks) from EIP-1167 proxy storage slots
4. Quotes each hop individually via `quoteExactInputSingle` (Doppler hooks block multi-hop quotes)

## 3. Monitoring

### Fleet Dashboard

```bash
GET /dashboard/fleet/alpha
```

Returns:
- Per-wallet ETH balances
- Total fleet ETH
- Cost basis (total ETH spent on buys)
- Total received (ETH from sells)
- Realized P&L
- Coin position summaries (holdings, buy/sell counts)

### Global Dashboard

```bash
GET /dashboard
```

Returns:
- Master SA balance
- All fleet dashboards
- Total available ETH (master + all fleets)
- Global realized P&L

## 4. Sweep (Consolidate ETH)

```bash
POST /fleets/:name/sweep
{
  "targetFleet": "bravo",           # sweep to another fleet
  # OR
  "targetAddress": "0x...",         # sweep to any address
  # OR omit both → sweeps to master SA
  
  "reserveWei": "500000000000000"   # leave 0.0005 ETH for gas (default)
}
```

Each wallet sends `balance - reserveWei`. Returns per-wallet transfer results.

## 5. Starting the Server

```bash
# With Doppler (recommended)
doppler run --project onchain-tooling --config dev -- \
  npx tsx packages/server/src/index.ts

# Required env vars
SIGNER_BACKEND=local          # or cdp
APP_NETWORK=base              # or base-sepolia
PORT=4001                     # default 4020

# For live trading
CDP_MOCK_MODE=0
FLEET_KILL_SWITCH=false
```

### Direct Script Execution (no server)

For one-off operations, direct script execution avoids HTTP server stability issues:

```bash
doppler run --project onchain-tooling --config dev -- \
  node --import tsx/esm packages/server/scripts/live-fleet-run.ts
```

## 6. Risk Controls

| Env Var | Default | Purpose |
|---------|---------|---------|
| `FLEET_KILL_SWITCH` | `false` | Emergency stop — blocks all trades |
| `MAX_PER_WALLET_WEI` | `1000000000000000` (0.001) | Max ETH per wallet per operation |
| `MAX_TRADE_WEI` | - | Total trade ceiling per operation |
| `MAX_SLIPPAGE_BPS` | `400` | Max allowed slippage |
| `CLUSTER_COOLDOWN_SEC` | `45` | Min seconds between cluster operations |

## Common Workflows

### "Buy a coin with a fleet"

1. `GET /dashboard` — check available ETH
2. `POST /fleets` — create fleet (or use existing)
3. `POST /fleets/:name/buy` — buy with drip + jiggle
4. `GET /dashboard/fleet/:name` — check positions

### "Exit and consolidate"

1. `POST /fleets/:name/sell` — sell all positions
2. `GET /dashboard/fleet/:name` — verify P&L
3. `POST /fleets/:name/sweep` — sweep ETH back to master

### "Rotate to a new coin"

1. Sell old coin: `POST /fleets/:name/sell`
2. Buy new coin: `POST /fleets/:name/buy` (wallets still funded)
