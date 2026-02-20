---
name: fleet-ops
description: Manage Zora coin fleet operations — spin up wallets, fund them, coordinate buys/sells, and exit positions. Uses the fleet server's trade, wallet, and funding services.
---

# Fleet Ops

Coordinate multi-wallet Zora coin trading operations on Base.

## Prerequisites

- Fleet server code at `packages/server/` in the fleet repo
- Doppler env: `doppler run --project onchain-tooling --config dev`
- Funded master wallet (`MASTER_WALLET_PRIVATE_KEY` in Doppler)
- Pimlico bundler configured (`PIMLICO_BASE_BUNDLER_URL`)

## Commands

### 1. Support a Coin (Full Fleet Buy)

When user says "support [coin address] with [N] wallets" or similar:

1. **Resolve route**: Use `resolveCoinRoute()` from `coinRoute.ts` to auto-discover the full swap path and pool params
2. **Create fleet wallets**: `createFleetWallets(N)` from `wallet.ts`
3. **Fund wallets**: `bootstrapFleetFunding({ amountWei })` from `funding.ts` — transfers ETH from master to each fleet wallet
4. **Coordinate buy**: `strategySwap({ walletIds, fromToken: WETH, toToken: coinAddress, ... })` from `trade.ts`

Amount per wallet: User specifies total ETH or per-wallet amount. Default 0.001 ETH per wallet.

### 2. Exit Position (Full Fleet Sell)

When user says "exit [coin address]" or "sell all [coin]":

1. **Get fleet wallets**: `listWallets()` from `wallet.ts`
2. **Check balances**: For each wallet, query `balanceOf(wallet, coin)` 
3. **Ensure Permit2**: Each wallet needs Permit2 approval (one-time per coin)
4. **Coordinate sell**: Each wallet sells its full coin balance back to ETH

### 3. Fleet Status

When user asks about fleet status:

1. List wallets with ETH balances
2. Show coin balances for any active positions
3. Show trade history

## Key Architecture

```
coinRoute.ts    — Auto-discovers swap path: coin ancestry + pool params from storage
v4Quoter.ts     — On-chain quotes via V4 Quoter (quoteExactInputSingle per hop)
v4SwapEncoder.ts — Encodes Universal Router V4_SWAP calldata
erc20.ts        — Permit2 approval helpers (required for ERC20 sells)
trade.ts        — Coordinated/strategy multi-wallet swaps
wallet.ts       — Fleet wallet creation (deterministic from seed)
funding.ts      — ETH distribution from master to fleet wallets
cdp.ts          — UserOp submission via Pimlico bundler
```

## Critical Notes

- **Permit2 required for sells**: V4 Router uses Permit2 for ERC20 SETTLE_ALL. `ensurePermit2Approval()` handles this.
- **3-hop paths**: Zora coins can be nested (coin → parent_coin → ZORA → ETH). Route resolver handles this automatically.
- **ETH/ZORA pool**: Standard V4 pool (fee=3000, tickSpacing=60, no hooks). Always first/last hop.
- **Doppler hooks**: Zora coin pools use custom Doppler hooks. Must use `quoteExactInputSingle` per hop (not `quoteExactInput`).
- **Slippage**: Use 500bps (5%) for 3-hop Doppler paths. Tighter for 2-hop.
- **Smart accounts**: Coinbase Smart Account v1.1, deterministic from `LOCAL_SIGNER_SEED` + wallet name.

## Running Tests

```bash
# Unit tests (no network)
cd packages/server && npx vitest run

# Mainnet e2e (real transactions!)
E2E_BASE_MAINNET=1 doppler run --project onchain-tooling --config dev -- \
  npx vitest run packages/server/tests/e2e.mainnet-swap.spec.ts
```
