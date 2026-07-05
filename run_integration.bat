@echo off
npm run build && start "ML Server" cmd /k "python solana_hybrid_sniper_ultra/ml_server.py" && start "Fast Scanner" cmd /k "node fast_scanner.cjs" && start "TSX Server" cmd /k "npx cross-env NODE_ENV=development tsx server/index.ts"
