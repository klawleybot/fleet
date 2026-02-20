# Fleet Status

## Current State (2026-02-20)

**Production-ready for manual operation on Base mainnet.**

### What Works
- Named fleets: create, fund (pre-validated), buy, sell, sweep
- Drip trading: spread buys over time in intervals with random jitter
- Jiggle: ±15% per-wallet amount variance (total preserved exactly)
- Auto route discovery: on-chain coin ancestry + pool params from storage slots
- Sequential single-hop quoting: works around Doppler hook limitations
- Permit2 approval flow for ERC20 sells
- Position tracking: per-wallet, per-coin cost basis and realized P&L
- Dashboard: global and per-fleet P&L + available ETH
- Sweep: consolidate ETH to master, another fleet, or any address

### Live Test Results
- **10/10 buys** across 5 wallets with drip + jiggle ✅
- **5/5 sells** — all positions exited ✅
- **Net P&L: +0.0007 ETH** on 0.0025 ETH investment

### Test Coverage
- 109 tests passing, 12 skipped (e2e gated behind env flags)

## Architecture

See `docs/OPERATIONS.md` for the full operational guide.

## Roadmap

- [x] P0: Production monitoring
- [x] P1: Named fleets
- [x] P2: Temporal streaming (drip)
- [x] P3: Jiggle
- [ ] P4: Momentum intelligence (deferred)
- [ ] P5: Gas optimization
- [ ] Service mode: pm2 + structured logging (see `docs/SERVICE.md`)
- [ ] OpenClaw skill packaging

## Last Updated
2026-02-20 (America/Denver)
