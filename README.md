# Solana paper-trading engine

This repository runs a fail-closed Solana paper-trading engine. The Node engine provides the HTTP API and dashboard; Birdeye/Helius-compatible providers supply market data, Jupiter/Jito code constructs execution, and Drizzle/Postgres stores state. **Paper mode is the supported deployment default.** Do not set `MODE=live` until the full paper gate and a separate execution review have passed.

## Architecture

| Component | Responsibility |
| --- | --- |
| `server/index.ts` | Starts the HTTP listener and heartbeat before database/provider initialization. |
| `server/routes.ts` | Trading pipeline, paper order lifecycle, and daily-loss breaker. |
| `server/runtime-hooks.ts` | Idempotent heartbeat, `.HALT` gate, readiness/health state. |
| `fast_scanner.cjs` | Candidate scanner. |
| `solana_hybrid_sniper_ultra/ml_server.py` | Optional ML scoring service. |
| `failsafe.cjs` / `live-runner.js` | Dual-signal watchdog and restart-loop circuit breaker. |

## Start, stop, and verify

1. Copy `.env.example` to `.env` and provide only variables your deployment needs. Never commit `.env`.
2. Apply migrations with `npm run db:migrate`; create reviewed migrations with `npm run db:generate` (do not use schema push as a production deployment substitute).
3. Build with `npm run build`.
4. Start an explicitly disarmed paper engine in PowerShell:

   ```powershell
   $env:MODE = "paper"
   $env:WALLET_PRIVATE_KEY = ""
   $env:PORT = "5000"
   npm run start:engine
   ```

5. From a second PowerShell window, verify the endpoint:

   ```powershell
   (Invoke-WebRequest http://127.0.0.1:5000/api/health -UseBasicParsing).StatusCode
   Invoke-RestMethod http://127.0.0.1:5000/api/health
   ```

During dependency boot the response is HTTP 200 with `readiness: "starting"`; a fully initialized pipeline returns `readiness: "ready"`. JSON always includes `status`, `uptimeSeconds`, and `openPositions`. A non-200 response means the engine is unhealthy and trading is halted.

For container deployment use `docker compose up --build -d`, verify with `docker compose ps` and the same health URL, and stop with `docker compose down`. The container runs non-root, has an HTTP healthcheck, and uses `unless-stopped` restart policy.

## Environment reference

Credentials are environment variables only. Names are documented here without values:

| Group | Variables | Purpose |
| --- | --- | --- |
| Core | `MODE`, `PORT`, `NODE_ENV`, `SKIP_VITE`, `RUN_ID`, `LOG_LEVEL` | Select paper/live operation, HTTP port, and observability behavior. |
| Persistence | `DATABASE_URL` | Drizzle/Postgres connection; required when arming live mode. |
| Provider credentials | `BIRDEYE_API_KEY`, `BIRDEYE_API_KEY_1`, `HELIUS_KEYS`, `HELIUS_API_KEYS`, `SOLANA_RPC_URL`, `SOLANA_RPC_BACKUP_URL`, `SOLANA_RPC_TERTIARY_URL` | Market-data and RPC configuration; live requirements are validated by name only. |
| Execution | `WALLET_PRIVATE_KEY`, `JITO_ENGINE_URL`, `JITO_TIP_LAMPORTS`, `PRIORITY_FEE_LAMPORTS` | Signing and delivery configuration. Do not set a wallet key for paper runs. |
| Safety | `MAX_DAILY_LOSS_SOL`, `MAX_RESTART_LOOP`, `HEALTH_URL`, `HEALTH_PORT`, `ENGINE_PM2_NAME`, `STARTUP_GRACE_MS` | Daily-loss, supervisor, and watchdog controls. |
| Alerts/repair | `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `ALERT_WEBHOOK_URL`, `AUTO_FIX`, `AUTOFIX_MAX_ATTEMPTS`, `AUTOFIX_WINDOW_MS`, `CANARY_MINUTES`, `AGENT_CMD` | Notification and halted paper-canary recovery controls. |
| Strategy | See `.env.example` for the optional Beast, entry/exit, liquidity, whale, regime, and Helius-polling variables. | Strategy behavior; changes require paper validation. |

Live startup fails fast when `DATABASE_URL`, `SOLANA_RPC_URL`, `BIRDEYE_API_KEY`, or `WALLET_PRIVATE_KEY` are absent. Errors list names only, never values.

## Circuit breakers and watchdogs

- A net daily loss at or above `MAX_DAILY_LOSS_SOL` persists `.HALT`, blocks entries, and invokes the existing flight-to-safety path.
- `live-runner.js` persists `.HALT` and stops the supervisor when `MAX_RESTART_LOOP` crashes occur in its crash window; it requests emergency sell before stopping.
- `failsafe.cjs` requires both a stale/missing heartbeat and failed HTTP health before escalation. It observes startup grace, writes `.HALT`, kills the engine, invokes the liquidator, and records an incident.
- An intentional `.HALT` is not cleared by normal starts. `npm run resume` is an operator action after incident review.

## Quality gate and operations

Run `npm test` for type-checking plus smoke, integration, failsafe, and restart-loop tests. `npm run test:smoke` is the fast smoke subset; `npm run lint` performs parser and secret-log hygiene checks. GitHub Actions runs lint and the full test gate on push and pull request.

Run `npm audit --omit=dev --audit-level=high` before releases. Current dependency exceptions and compatibility requirements are documented in [SECURITY_AUDIT.md](SECURITY_AUDIT.md). Deploy with `npm ci`, never `npm install`.

Do not log, test, document, or commit keys, credential-bearing RPC URLs, wallet material, wallet-address/balance combinations, or unredacted provider payloads. Structured logs include a run ID and redact credential-like data and Solana-sized identifiers.
