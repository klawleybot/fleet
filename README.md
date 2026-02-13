# Pump It Up

Local control plane for managing a fleet of Coinbase CDP Smart Accounts on Base.

## What it does

- Create a master smart account and a fleet of smart accounts
- Track wallet state in SQLite
- Distribute ETH from the master wallet to selected fleet wallets
- Execute coordinated swaps across selected wallets using CDP smartAccount.swap()
- View latest funding and trade results in a web UI

## Setup

1. Install dependencies with yarn install
2. Add env vars: CDP_API_KEY_ID, CDP_API_KEY_SECRET, CDP_WALLET_SECRET, BASE_RPC_URL, PORT
3. Run backend: yarn dev:server
4. Run frontend: yarn dev:web
5. Open http://localhost:5179
