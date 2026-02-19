# Deterministic Multi-Hop Exact-In Swaps for Uniswap v4-Style Paths on Base

## Quick Reference

### Router Addresses
- **Base (8453):** `0x6ff5693b99212da76ad316178a184ab56d299b43`
- **Base Sepolia (84532):** `0x492e6456d9528771018deb9e87ef7750ef184104`

### WETH (Base OP-stack predeploy)
`0x4200000000000000000000000000000000000006`

### Command + Action IDs
| ID | Name | Purpose |
|----|------|---------|
| `0x10` | `V4_SWAP` | Universal Router command |
| `0x07` | `SWAP_EXACT_IN` | Multi-hop exact-in swap action |
| `0x0c` | `SETTLE_ALL` | Pay pool manager (capped by max) |
| `0x0f` | `TAKE_ALL` | Withdraw output (enforcing minimum) |

### Minimal Deterministic Execution Plan
```
UniversalRouter.execute(
  commands = 0x10,           // V4_SWAP
  inputs[0] = abi.encode(
    actions = [0x07, 0x0c, 0x0f],
    params = [
      abi.encode(ExactInputParams),   // SWAP_EXACT_IN
      abi.encode(currency, maxIn),    // SETTLE_ALL
      abi.encode(currency, minOut),   // TAKE_ALL
    ]
  ),
  deadline
)
```

### v4 Path Structure (NOT v3 packed bytes)
```solidity
struct PathKey {
  Currency intermediateCurrency;
  uint24 fee;
  int24 tickSpacing;
  IHooks hooks;
  bytes hookData;
}

struct ExactInputParams {
  Currency currencyIn;
  PathKey[] path;
  uint128 amountIn;
  uint128 amountOutMinimum;
}
```

### Native ETH-in
- Use router-payable pattern: `poolManager.settle{value: amount}()` when currency is `address(0)`
- `msg.value >= amountIn` required
- Wrap-first (`WRAP_ETH` / `0x0b`) only needed for WETH-denominated pools

### SDK Tooling
- `@uniswap/v4-sdk` (1.27.0) — PathKey encoding, `encodeRouteToPath()`
- `@uniswap/universal-router-sdk` (4.30.0) — Universal Router calldata encoding

### Critical Notes
- Avoid `ActionConstants.OPEN_DELTA` sentinels for deterministic calldata
- Multi-hop slippage checked only on final output (not per-hop)
- Router package version is unspecified on deployments page — verify against on-chain ABI
- `PathKey[]` is NOT packed; nested ABI encoding with dynamic `bytes hookData`

---

*Full report: see original research document from 0xflick (2026-02-19)*
