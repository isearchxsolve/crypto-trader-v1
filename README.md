CREATE DATABASE crypto_db;

npx drizzle-kit pushset

set BIRDEYE_API_KEY=05f10e59e3824f438c6446d195f49c56

set SOLANA_RPC_URL=https://mainnet.helius-rpc.com/?api-key=85a848b0-d314-4477-a123-1a294ac0908b

set SOLANA_RPC_BACKUP_URL=https://twilight-old-diamond.solana-mainnet.quiknode.pro/1653af2ba52ff5de6fdcf42ab06867d797df8399/

set SOLANA_RPC_TERTIARY_URL=https://api.mainnet-beta.solana.com

set JITO_ENGINE_URL=https://tokyo.mainnet.block-engine.jito.wtf/api/v1/transactions

JITO_TIP_LAMPORTS=100000

set WALLET_PRIVATE_KEY=DHt9ipNNB5KmqDv87etG3kfvCU9dsVQcyo13t2U33RHDc7ik3Frex5FuoD5K4veqRJ58zVNaPQm3Kd5EcCcCDzx

set PRIORITY_FEE_LAMPORTS=100000

set DATABASE_URL=postgres://postgres:postgres@localhost:5432/crypto_db

npm run build && start "ML Server" cmd /k "python solana_hybrid_sniper_ultra/ml_server.py" && start "Fast Scanner" cmd /k "node fast_scanner.cjs" && start "TSX Server" cmd /k "npx cross-env NODE_ENV=development tsx server/index.ts"

