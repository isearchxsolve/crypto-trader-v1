# Crypto-Trader Agent Instructions

## Architecture

- Node Engine: `server/routes.ts` (complete trading pipeline)
- ML Service: `ml_server.py` (XGBoost v5 on port 5001)
- Scanner: `fast_scanner.cjs` (DexScreener candidates.csv)
- Supervisor: `live-runner.js` (PM2 managed self-healing)
- Failsafe: `failsafe.cjs` (dual-signal watchdog + liquidator)

## Beast Tier (opt-in, additive quality layer)

- Discovery: `server/beast-scanner.ts` (10-surface pre-valuator, returns HIGH/LEGENDARY/MEDIUM/SKIP)
- Safety: `server/beast-safety.ts` (6-surface fail-closed rug/honeypot/LP gate, fail-closed by default)
- Exit: `server/beast-exit.ts` (asymmetric moonshot engine: 6-tier bag, 7-step TP ladder 1.5x→1000x, dead-cat disabled ≥10x)
- Integration: wired into `routes.ts` at line ~3809 (entry gate, after checkTokenSafety) and ~5224 (exit cascade, before __patchForceExit)
- Tests: `server/beast-pipeline.integration.test.ts` (10 tests, all green)

## Environment Flags (Beast Tier)

- `BEAST_SAFETY_ENABLED=false` (default): enables Beast discovery + safety gate at entry
- `BEAST_EXIT_ENABLED=false` (default): enables Beast asymmetric moonshot exit engine
- `BEAST_REQUIRED=false` (default): if true, Beast VETO blocks entry (fail-closed for entry)
- `BEAST_FAIL_OPEN=false` (default): Beast safety gate is fail-closed by default

## Defect Registry — All Resolved

- OD-1: CLOSED — real data retraining via `load_real_data()` in train.py
- OD-2: FIXED — f(x) gate + liquidity floors block un-winnable entries
- OD-3: FIXED — partial TP disabled when exit cost exceeds threshold
- OD-4: VERIFIED OK — score remains input to f(x) never standalone trigger
- FIX-2: DONE — paper mode logs descriptive-prior hypothesis [PHASE-E]
- FIX-3: DONE — Beast tier wired into routes.ts (entry gate ~line 3809, exit cascade ~line 5224); backward-compat via BEAST_SAFETY_ENABLED/BEAST_EXIT_ENABLED defaults

## How to Run

```powershell
npm run build
start "ML Server" cmd /k "python solana_hybrid_sniper_ultra/ml_server.py"
start "Fast Scanner" cmd /k "node fast_scanner.cjs"
start "TSX Server" cmd /k "npx cross-env NODE_ENV=development tsx server/index.ts"
```

## Testing

```powershell
npm run test:smoke
npm run test:integration
npm run gate          # check + smoke + integration — run before committing
npx vitest run
```

## Rules for agents

- **Never commit secrets.** API keys, RPC URLs, and especially `WALLET_PRIVATE_KEY`
  belong in `.env` (git-ignored), never in README, code, or commits. Real keys were
  committed here once and had to be redacted — do not repeat that.
- This is a live-trading system. Do not change order sizing, fee, or wallet logic
  without an explicit instruction; flag such changes clearly.
- No `.tmp`, `.bak`, or `* - Copy*` files. Delete scratch files; don't commit them.
- Keep commit messages action-oriented (`Fix jupiter slippage calc`).
