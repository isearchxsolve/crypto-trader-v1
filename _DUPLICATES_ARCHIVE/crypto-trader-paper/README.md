# Crypto Trader (Paper) — Setup

> ⚠️ **SECURITY:** Real credentials were previously committed here and have been
> removed. Load secrets from `.env` (never commit it). If any key below was ever
> pushed to a remote, treat it as compromised and rotate it.

```sql
CREATE DATABASE crypto_db;
```

```powershell
npx drizzle-kit push
```

Set these in `.env` (see `.env.example`), not in the repo:

```powershell
set BIRDEYE_API_KEY=<your-birdeye-key>

set SOLANA_RPC_URL=<your-helius-or-rpc-url>

set SOLANA_RPC_BACKUP_URL=<your-backup-rpc-url>

set SOLANA_RPC_TERTIARY_URL=https://api.mainnet-beta.solana.com

set JITO_ENGINE_URL=https://tokyo.mainnet.block-engine.jito.wtf/api/v1/transactions

set JITO_TIP_LAMPORTS=100000

set WALLET_PRIVATE_KEY=<your-wallet-private-key>

set PRIORITY_FEE_LAMPORTS=100000

set DATABASE_URL=postgres://postgres:postgres@localhost:5432/crypto_db
```

Run:

```powershell
npx cross-env NODE_ENV=development tsx server/index.ts

python solana_hybrid_sniper_ultra/ml_server.py
```
