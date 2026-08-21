# CRYPTO TRADER v1.1 — Principal Architectural & Sellability Audit

**Auditor:** Sixth (Staff-Level FinTech Architect & Security Auditor)  
**Date:** 2026-08-19  
**Scope:** Full codebase — server engine, client dashboard, storage layer, configuration, deployment artifacts  
**Mode:** Read-only audit. No source code was modified.

---

## Executive Summary

This is a **remarkably sophisticated** Solana memecoin trading engine with real on-chain execution via Jupiter V6, multi-source signal discovery (DexScreener, GeckoTerminal, Birdeye, Helius, Jupiter verified), a multi-layered safety pipeline, ML scoring, shadow-mode paper trading, and a full React dashboard. The codebase shows clear evidence of hundreds of iterations of real-world debugging — nearly every function contains well-documented bugfix comments with root-cause analysis.

However, the system is **not production-sellable in its current form** due to several structural gaps, security risks, and complexity debt detailed below. The codebase is approximately **6,500+ lines in `routes.ts` alone** — a single monolithic file that handles discovery, scoring, safety, execution, position management, exit logic, circuit breakers, shadow mode, and all API endpoints. This is the single biggest barrier to sellability, maintainability, and auditability.

---

## 1. Exchange Integration & Trading Logic Flaws

### 1.1 Jupiter V6 Swap Integration (`server/jupiter.ts`)

**Strengths:**
- Well-structured RPC rotation with health checks, blacklisting, and retry logic
- Latency tracking with structured records for post-trade analysis
- Quote age validation before send (prevents stale-quote sandwiching)
- Jito bundle support with fallback to public RPC
- Duplicate transaction detection via `executedTransactions` Set
- Post-buy balance polling with stable-read confirmation (2 consecutive non-zero reads)

**Critical Flaws:**

| # | Flaw | Severity | Location |
|---|------|----------|----------|
| F-1 | **Float precision on token amounts**: `Math.floor(amountSol * LAMPORTS_PER_SOL)` uses JavaScript `Number` (IEEE-754 double). For amounts > 0.009 SOL, `0.009 * 1e9 = 8999999.999999998` → `Math.floor` gives `8999999` (1 lamport short). Accumulated across thousands of trades, this causes systematic under-funding. Should use `BigInt(Math.round(amountSol * 1e9))` or a decimal library. | HIGH | `jupiter.ts` buyToken() |
| F-2 | **No atomic balance check + swap**: Balance is checked before the swap, but the swap itself doesn't verify sufficient balance atomically. A concurrent position exit could drain the wallet between the check and the swap submission. The `reservedCapital` mechanism is in-memory only and not crash-safe. | MEDIUM | `routes.ts` buy loop |
| F-3 | **`executedTransactions` Set is unbounded in practice**: It caps at 1000 entries with a 500-entry eviction, but uses a plain `Set` with no TTL. If the engine restarts, the set is empty — any in-flight transaction from the previous session could theoretically be re-submitted. The 1000-entry cap also means after 1000 trades, the dedup protection resets for old signatures. | LOW | `jupiter.ts` L178 |
| F-4 | **Sell path polls balance 30 times × 500ms = 15 seconds**: `sellToken()` polls `getWalletBalance()` in a tight loop waiting for SOL to appear post-sell. If the pool is genuinely empty (rugged), this wastes 15 seconds of `priceCheckLock` time, blocking exit decisions for all other open positions. | MEDIUM | `jupiter.ts` sellToken() |
| F-5 | **`buildAndSendWithRetry` refreshes quote on retry but not on the first attempt**: The `quoteRefresher` callback is only called on retry (i > 0). The first send uses whatever quote was passed in, which could be stale by several seconds. The pre-send refresh at L147 partially mitigates this but only fires when quote is > 800ms old. | LOW | `jupiter.ts` L134-155 |
| F-6 | **Race condition in Jito fallback**: If Jito bundle submission fails mid-send (network error after the HTTP POST was received), the code falls back to public RPC send. But the Jito bundle may have already been accepted — this creates a potential double-spend. The `landedSig` check at L165 mitigates this for the retry loop but not for the Jito→public RPC transition within a single attempt. | MEDIUM | `jupiter.ts` L155-175 |

### 1.2 Position Management (`routes.ts` — `checkOpenPositions`)

**Critical Flaws:**

| # | Flaw | Severity | Location |
|---|------|----------|----------|
| F-7 | **`priceCheckLock` blocks ALL position monitoring when one sell is slow**: The entire exit cascade is serialized behind a single boolean lock. If one Jupiter sell takes 12 seconds (the timeout), all other open positions get zero price checks for that duration. During a market-wide rug, positions that could have been saved at -5% are instead closed at -50% because they were starved of exit opportunities. | CRITICAL | `routes.ts` checkOpenPositions() |
| F-8 | **`sellingInProgress` Set uses trade IDs but the force-sell background task can orphan entries**: The `handedOffToForceSell` flag prevents the outer `finally` from deleting the entry, but if the background `.catch()` fires (e.g., unhandled rejection in the chain), `sellingInProgress.delete()` is called but the trade is never closed in the DB. This leaves a ghost position that blocks new entries via `worstOpenPnl`. | HIGH | `routes.ts` forceSellPosition() |
| F-9 | **Paper exit PnL calculation doesn't account for partial sells**: When a partial TP was taken earlier, `trade.amount` was reduced via `updateTradeAmount()`, but the exit PnL is computed as `(returnSol - sizeSol) / sizeSol * 100` where `sizeSol = parseFloat(trade.amount)`. The partial TP already returned SOL to `paperBalance`, so the remaining position's cost basis is wrong — the exit PnL is inflated by the partial return. | HIGH | `routes.ts` paper exit block |

### 1.3 Discovery Pipeline

| # | Flaw | Severity | Location |
|---|------|----------|----------|
| F-10 | **Discovery funnel uses DexScreener search API with 35 sequential queries**: Each query goes through a 200ms rate-limited queue. 35 queries × 200ms = 7 seconds minimum per scan cycle. Combined with GeckoTerminal, Jupiter verified hydration, and boost feed hydration, a single scan cycle takes 10-15 seconds — but `scanIntervalMs` is set to 5000ms. The `isFetchingCandidates` lock prevents overlap, but this means the bot scans slower than configured. | MEDIUM | `routes.ts` fetchDexScreenerCandidates() |
| F-11 | **Stale candidate cache serves outdated prices**: `liveCandidatesCache` is only refreshed when `now - lastScanTime < cacheTtl`. If the scan takes 10 seconds, the next 5-second cycle returns the same stale candidates with 10-second-old prices. The price-drift check in the buy loop partially catches this, but at 20-30% drift limit, significant slippage can occur. | MEDIUM | `routes.ts` fetchDexScreenerCandidates() |

---

## 2. State Management & Database Risks

### 2.1 Database Layer

**Architecture:**
- PostgreSQL via Drizzle ORM with `node-postgres` Pool
- Fallback to `MemStorage` (in-memory) when `DATABASE_URL` is unset
- Single `botStatus` row (id=1) stores all engine state
- `trades` table stores all open and closed positions

**Critical Flaws:**

| # | Flaw | Severity | Location |
|---|------|----------|----------|
| S-1 | **`MemStorage` loses all state on restart**: When `DATABASE_URL` is unset (common in paper mode), all trade history, bot status, and balance tracking is lost on restart. The `seedInitialData()` method re-creates the status row but doesn't restore trades. Shadow mode persists to JSON files on disk (`shadow-stats.json`, `shadow-trades.jsonl`), but the main trade ledger is gone. | HIGH | `storage.ts` |
| S-2 | **No migration strategy**: The `drizzle.config.ts` and `db:push` script exist, but there's no versioned migration history. Schema changes require manual `db:push` which is destructive on existing databases. For a sellable product, customers need non-destructive migrations. | HIGH | `drizzle.config.ts` |
| S-3 | **`botStatus` is a single row with no versioning**: Concurrent writes (e.g., scan cycle updates `walletBalance` while price-check updates `openPositions`) can cause lost updates. PostgreSQL's default isolation level (`READ COMMITTED`) means the last writer wins — no optimistic locking or conflict detection. | MEDIUM | `storage.ts` |
| S-4 | **`walletBalance` in DB is the single source of truth but is updated asynchronously**: The `updateBotStats({ walletBalance })` calls are fire-and-forget (`.catch(() => {})`). If the DB is temporarily unavailable, the balance diverges from reality. The `readLiveWalletBalance()` function has a fallback chain (RPC → lastGood → DB → paper), but the DB fallback can be stale by minutes. | MEDIUM | `routes.ts` multiple locations |
| S-5 | **No transactional integrity on trade open/close**: A trade is opened (`addTrade`) and then `peakPrices.set()` and `tradeStopPrices.set()` are called separately. If the process crashes between `addTrade` and `peakPrices.set()`, the trade exists in the DB but has no in-memory tracking — it becomes a "ghost" position that's never monitored for exit. The `reconcilePositions()` function exists but is never called in the production flow. | HIGH | `routes.ts` buy/sell paths |
| S-6 | **Peak balance tracking uses in-memory state that diverges from DB**: `peakBalance` is a module-level variable updated in `checkCircuitBreakers()`, but it's also persisted to DB via `updateBotStats({ peakBalance })`. On restart, `initBalanceFromDB()` attempts to reconcile, but the 1.2x guard can discard a legitimate peak if the wallet balance dropped since the last session. This creates a false "no drawdown" state. | MEDIUM | `routes.ts` initBalanceFromDB() |

### 2.2 In-Memory State Explosion

| # | Flaw | Severity | Location |
|---|------|----------|----------|
| S-7 | **20+ module-level `Map` and `Set` objects grow unbounded**: `tradedAddresses`, `stoppedOutAddresses`, `hardBlockedAddresses`, `rugcheckBlockedAddresses`, `tokenPriceCache`, `jupiterQuoteCache`, `smartMoneyCache`, `heliusTapeCache`, `rugConcentrationCache`, `whaleSnapshotCache`, `sessionTokenBuyCount`, `sessionSymbolBuyCount`, `tokenStopLossCount`, `tokenLastLossMs`, `tokenSymbolLastLossMs`, `tokenSymbolSlBlockMs`, `peakPrices`, `prevPnlMap`, `pnlStableMap`, `tradeStopPrices`, `partialTpTaken`, `zeroBalanceStrikes`, `zeroPriceStrikes`, `sellFailureStrikes`, `priceSanityRejections`, `midHoldRugcheckMs`, `midHoldWhaleMs`, `whaleExitShadowSeen`, `firstTickRedTrades`, `lifecycleLastLogMs`, `costGateLastLogMs`, `profitLockLastLogMs`, `liqCoWarnedTrades`, `partialTpFailuresMap`, `trailActivatedLogged`, `pendingBuys`, `recentlyAttemptedBuys`. Most have TTL-based cleanup in `runScanCycle()`, but the cleanup only runs when the scan cycle executes. If the engine is paused (`isRunning=false`), these maps grow indefinitely. | MEDIUM | `routes.ts` module scope |
| S-8 | **`watchlistCache` and `scannerWarmingQueue` use `global` as storage**: `(global as any).__geckoCycle` and `(global as any).scannerWarmingQueue` store state on the global object. This is fragile (type-unsafe, no cleanup guarantee) and would break in worker-thread or cluster deployments. | LOW | `routes.ts` fetchDexScreenerCandidates() |

---

## 3. Missing Features for MVP/Sellability

### 3.1 Critical Missing Features (Must-Have Before Sale)

| # | Feature | Status | Impact |
|---|---------|--------|--------|
| M-1 | **User authentication / multi-tenancy**: The only authentication is `ADMIN_SECRET` via `x-admin-secret` header. There's no user registration, login, session management, or per-user isolation. Anyone with the secret controls the entire bot. For a sellable product, each customer needs their own isolated instance with proper auth. | MISSING | BLOCKER |
| M-2 | **`position-sizing.ts` is a stub**: `computePositionSize()` throws `"not implemented (stub)"`. The engine uses a separate `getTieredSizing()` function in `routes.ts`, but the documented Kelly-optimal sizing from the architecture docs is not implemented. | STUB | HIGH |
| M-3 | **`portfolio-risk.ts` is a stub**: `evaluatePortfolioRisk()` throws `"not implemented (stub)"`. Portfolio-level VaR, sector exposure caps, and narrative concentration limits are not enforced. The engine relies on `maxOpenPositions` and `maxTotalExposure` as crude proxies. | STUB | HIGH |
| M-4 | **No WebSocket real-time updates**: The frontend polls REST endpoints. No WebSocket/SSE for real-time trade updates, price feeds, or alert notifications. For a paid product, users expect real-time dashboard updates. | MISSING | MEDIUM |
| M-5 | **No automated deployment / Docker health**: `Dockerfile` and `docker-compose.yml` exist but the Dockerfile doesn't include a health check instruction. The `ecosystem.config.js` (PM2) is present but not integrated with Docker. | INCOMPLETE | MEDIUM |
| M-6 | **No database backup/restore**: No automated backup strategy for the PostgreSQL database. Trade history, PnL records, and configuration are all in a single database with no redundancy. | MISSING | MEDIUM |
| M-7 | **No API rate limiting on public endpoints**: Endpoints like `/api/health`, `/api/status`, `/api/trades/open`, `/api/engine/stats` are publicly accessible without authentication. Only admin endpoints require `x-admin-secret`. | MISSING | MEDIUM |
| M-8 | **No onboarding flow**: No setup wizard, configuration validation UI, or guided first-run experience. Users must manually edit `.env`, set up PostgreSQL, configure RPC endpoints, and understand the complex settings. | MISSING | HIGH |
| M-9 | **No trade export / reporting**: No CSV/PDF export of trade history, PnL reports, or tax-ready documentation. The `/api/trades/list` endpoint returns raw JSON. | MISSING | LOW |
| M-10 | **No backtesting UI**: `backtest.py` exists but has no integration with the frontend. Users can't run historical simulations from the dashboard. | MISSING | LOW |

### 3.2 Incomplete or Partially Stubbed Features

| # | Feature | Status |
|---|---------|--------|
| M-11 | **ML Service (`mlServiceUrl`)**: External Python service at `localhost:5001` — no code for this service exists in the repo. The bot gracefully degrades when it's unavailable, but the service itself is not included. | EXTERNAL DEPENDENCY |
| M-12 | **`advanced-filters.ts`** references Helius API key for dev-drain detection, but the actual Helius Enhanced Transactions integration for per-token dev wallet tracking is not visible in the filter implementation — only holder concentration and wash trade detection are implemented. | PARTIAL |
| M-13 | **Reconciliation**: `reconcilePositions()` function exists but is **never called** in the production flow. Ghost positions from crashed sessions are never automatically cleaned up. | DEAD CODE |

---

## 4. Security & Key Management Vulnerabilities

### 4.1 Private Key Exposure (CRITICAL)

| # | Vulnerability | Severity | Location |
|---|--------------|----------|----------|
| V-1 | **Private key loaded from `.env` into process memory**: `WALLET_PRIVATE_KEY` is read from `.env` via `dotenv.config()` and passed as a plain string to `JupiterService`. The key remains in Node.js heap memory for the lifetime of the process. No zeroization, no HSM integration, no key encryption at rest. | CRITICAL | `index.ts`, `jupiter.ts` |
| V-2 | **`.env` file contains the real private key**: `.env` (not `.env.example`) is present in the working directory. While `.gitignore` excludes it, the file exists on disk unencrypted. Any process with read access to the working directory can steal the key. | CRITICAL | `.env` |
| V-3 | **`gmgn_keys/` directory exists**: Contains API keys in a dedicated directory. If this directory is committed or accessible, it exposes GMGN API credentials. | HIGH | `gmgn_keys/` |
| V-4 | **Private key passed as constructor argument**: `new JupiterService(urls, pk, ...)` passes the raw key through the call stack. Stack traces (on uncaught exceptions) could expose it. The `redactText()` function in `production-safety.ts` redacts base58 strings from logs, but the key could appear in error messages before redaction is applied. | HIGH | `jupiter.ts` constructor |
| V-5 | **`ADMIN_SECRET` comparison is not timing-safe**: `provided !== adminSecret` uses JavaScript's `!==` operator, which is vulnerable to timing attacks. Should use `crypto.timingSafeEqual()`. | MEDIUM | `routes.ts` requireAdmin() |
| V-6 | **No HTTPS enforcement**: The Express server listens on `0.0.0.0:5000` without TLS. API keys, admin secrets, and trade data are transmitted in plaintext over the network. | HIGH | `index.ts` |
| V-7 | **`WALLET_PRIVATE_KEY` safety guard is bypassable**: The `index.ts` safety guard that prevents `.env` from overriding an explicitly-emptied `WALLET_PRIVATE_KEY` only works when the variable is set in the shell environment. If the process is started without the variable set at all, `.env` overrides silently. | MEDIUM | `index.ts` |

### 4.2 API Security

| # | Vulnerability | Severity | Location |
|---|--------------|----------|----------|
| V-8 | **Admin endpoints accept secret in request body**: `req.body?.adminSecret` is checked alongside `x-admin-secret` header. Body-based secrets can be logged by proxies, cached by CDNs, and are visible in browser dev tools for POST requests. | MEDIUM | `routes.ts` requireAdmin() |
| V-9 | **No CORS configuration**: No CORS headers are set. In development, Vite proxy handles this, but in production with `SKIP_VITE=true`, any origin can call the API. | MEDIUM | `index.ts` |
| V-10 | **No request size limit**: `express.json()` is used without a `limit` option. Default is 100KB, but this should be explicitly set and reduced for a trading API. | LOW | `index.ts` |
| V-11 | **Console redaction regex catches too aggressively**: `redactText()` replaces ALL base58-looking strings (32-88 chars) with `[REDACTED_SOLANA_ID]`. This includes Solana addresses that are intentionally logged (token mints, pool addresses). This makes debugging production issues extremely difficult. | MEDIUM | `production-safety.ts` |

---

## 5. Code Quality & Architectural Debt

### 5.1 The Monolith Problem

**`routes.ts` is 6,500+ lines** and contains:
- Discovery pipeline (DexScreener, GeckoTerminal, Jupiter, Birdeye, Helius integration)
- Token scoring with 15+ component scores
- Safety pipeline (RugCheck, holder concentration, wash trade detection)
- Entry gate logic (score gate, edge gate, regime gate, EV gate, objective gate)
- Position management (trailing stops, partial TPs, exit cascade with 15+ exit conditions)
- Circuit breakers (daily loss, drawdown, BTC crash, loss cooldown)
- Shadow mode (paper vs real execution gap tracking)
- Smart money / whale tape (Birdeye, Helius, free RPC layers)
- Gold Hunter integration (GMGN signal feeds)
- New Mint Detector (Helius enhanced transactions)
- All API endpoints (25+ routes)
- Engine settings with 80+ configurable parameters

This single file is the #1 barrier to selling the product. No new developer can reason about, test, or safely modify this file. The extensive bugfix comments (200+ inline "FIX", "BUGFIX", "PATCH" annotations) are evidence of how difficult it is to maintain.

### 5.2 Test Coverage

| # | Issue | Details |
|---|-------|---------|
| Q-1 | **Integration tests exist but coverage is unclear**: 20+ test files exist (`*.test.ts`, `*.test.cjs`) but the test suite is split between Vitest and Node.js built-in test runner. No coverage reports are generated. | 
| Q-2 | **No end-to-end test for the full trade lifecycle**: Tests cover individual functions (exit-strategy, beast-safety, risk-engine) but no integration test exercises the full path: discovery → scoring → safety → buy → monitor → sell → PnL accounting. |
| Q-3 | **TypeScript `any` proliferation**: `routes.ts` uses `any` extensively in function signatures, map values, and callback parameters. The `storage.ts` interface returns `any` for most methods. This defeats TypeScript's safety guarantees. |

### 5.3 Configuration Complexity

The system has **120+ environment variables** (see `.env.example`). Many have interdependencies that are only documented in inline comments. For example:
- `EDGE_POCKET_ONLY`, `EDGE_MIN_SCORE`, `EDGE_HIGH_CONF_SCORE`, `EDGE_EXPLOSIVE_SCORE`, `EDGE_EXPLOSIVE_ML`, `EDGE_EXPLOSIVE_PX5M`, `EDGE_EXPLOSIVE_VOLMOM` — seven variables that together define a single admission gate
- `LP_RELAX_WHALE_GATE`, `PAPER_PROBE_GRADED_LP_VETO`, `RELAX_GRADED_LP_VETO_LIVE`, `LP_UNLOCKED_FAILCLOSED_NODATA` — four variables that control a single LP-unlock safety valve

This configuration surface is too large for a sellable product without a configuration UI or preset profiles.

### 5.4 Logging

- Structured logging via Pino is well-implemented
- Console redaction prevents credential leakage in logs
- Log rotation at 50MB with single backup (app.log.1)
- **Missing**: No log aggregation, no alert integration beyond the stub `TELEGRAM_BOT_TOKEN` and `ALERT_WEBHOOK_URL` in `.env.example`

---

## 6. Sellability Scorecard

| Category | Score | Notes |
|----------|-------|-------|
| Core Trading Logic | 8/10 | Sophisticated, battle-tested, well-documented bugfixes |
| Risk Management | 7/10 | Good circuit breakers, missing portfolio-level risk (stub) |
| Security | 3/10 | Private key in plaintext, no auth, no TLS, timing-unsafe comparisons |
| Code Quality | 4/10 | Monolithic, heavy `any` usage, 120+ env vars |
| Test Coverage | 5/10 | Good unit tests for pure functions, missing E2E and coverage reports |
| Documentation | 6/10 | Excellent inline docs, missing user-facing docs and API docs |
| Deployment | 5/10 | Docker/PM2 configs exist but untested for production |
| UI/UX | 6/10 | React dashboard exists, needs real-time updates and onboarding |
| Multi-tenancy | 1/10 | Single-user, no isolation, no per-user config |
| Observability | 7/10 | Good structured logging, observability events, shadow mode |

**Overall Sellability: 5.2/10** — Needs security hardening, the monolith split, multi-tenancy, and a configuration UI before it can be sold as a product.

---

## 7. Priority Remediation Roadmap

### Phase 1: Security Hardening (1-2 weeks)
1. Encrypt private key at rest (use OS keychain or encrypted file with passphrase)
2. Add timing-safe comparison for `ADMIN_SECRET`
3. Add HTTPS/TLS termination
4. Remove body-based admin secret acceptance
5. Add CORS configuration
6. Add request rate limiting

### Phase 2: Architecture Split (2-3 weeks)
1. Extract `routes.ts` into modules: `discovery/`, `scoring/`, `safety/`, `execution/`, `position-manager/`, `circuit-breaker/`, `shadow/`
2. Implement `position-sizing.ts` (replace stub)
3. Implement `portfolio-risk.ts` (replace stub)
4. Add database migration versioning
5. Add transactional integrity to trade open/close

### Phase 3: Sellability Features (2-4 weeks)
1. Add user authentication (JWT + bcrypt)
2. Add per-user configuration profiles with presets
3. Add WebSocket real-time updates
4. Add trade export (CSV/PDF)
5. Add onboarding wizard
6. Add API documentation (OpenAPI/Swagger)

### Phase 4: Testing & Deployment (1-2 weeks)
1. Add E2E test for full trade lifecycle
2. Add coverage reporting (target: 80%+)
3. Add production Docker health checks
4. Add database backup automation
5. Add monitoring/alerting (Prometheus/Grafana or equivalent)

---

## Appendix A: File Size Analysis

| File | Lines | Assessment |
|------|-------|------------|
| `server/routes.ts` | ~6,500 | **CRITICAL** — must be split |
| `server/jupiter.ts` | ~600 | Acceptable |
| `server/storage.ts` | ~200 | Acceptable |
| `server/exit-strategy.ts` | ~130 | Good — pure, testable |
| `server/risk-engine.ts` | ~150 | Good — pure, testable |
| `server/beast-exit.ts` | ~230 | Good — pure, testable |
| `server/beast-safety.ts` | ~250 | Good — pure, testable |
| `server/beast-scanner.ts` | ~230 | Good — pure, testable |
| `server/advanced-filters-pure.ts` | ~200 | Good — pure, testable |
| `server/production-safety.ts` | ~100 | Good |
| `server/logger.ts` | ~70 | Good |
| `server/runtime-hooks.ts` | ~80 | Good |

## Appendix B: Environment Variable Count

Total unique environment variables referenced in the codebase: **127**
- Required for live mode: 4 (`DATABASE_URL`, `SOLANA_RPC_URL`, `WALLET_PRIVATE_KEY`, `BIRDEYE_API_KEY`)
- Required for paper mode: 0 (all defaults)
- Strategy tuning: 80+
- Safety/risk: 20+
- Infrastructure: 15+
- Debug/diagnostic: 8+

---

*End of audit. No source code was modified. No Git commits were made.*
