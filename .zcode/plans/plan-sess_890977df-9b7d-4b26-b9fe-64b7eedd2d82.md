# Monster Moonshot E2E via Continuous TDD — Implementation Plan

## Phase A summary (current state, with evidence)

**Verified OK:**
- `npx tsc` → exit 0, no errors. Syntax gate is GREEN. (Stale `tsc_err.txt` ignored.)
- `npx vitest run` → 304 tests / 12 files passing. Module-level smoke + integration is GREEN.

**Defects found:**
- **D1 (CRITICAL, OBJECTIVE DEFECT):** No test imports `server/routes.ts` (6809 lines, the trading core). The existing `full-pipeline.integration.test.ts` only chains pure submodules — it's a clean-room re-composition, never exercising the production orchestration.
- **D2 (MEDIUM):** `routes.test.ts` (at repo root, the only test that imports `routes.ts`) is excluded from vitest by config glob, so the main file has zero gated coverage today. Its mock scaffold (`vi.mock('./server/storage')`, `vi.mock('./server/jupiter')`, `process.env.DATABASE_URL`) is the working proof that the DB/RPC deps are fully mockable.
- **D3 (MEDIUM, FRAGILE):** `npm test` in `package.json` runs `node --test` — wrong runner. A CI call to `npm test` runs a different (mostly empty) subset than vitest. No single command enforces smoke → syntax → integration order.
- **D4 (LOW):** No smoke layer that just asserts the two main files parse and import without side effects. (Importing `routes.ts`/`jupiter.ts` is provably side-effect-free per the Explore report — no DB/RPC/fs calls at module-eval time.)

## Phase B — construction

### Step 1. Smoke layer — `tests/smoke.test.ts`
- `it('routes.ts imports cleanly')` — `await import('../server/routes')` with no mocks; asserts no throw, asserts top-level exports exist (`executeEnhancedEdgeFilter`, `getShadowTrades`, `setShadowModeEnabled`).
- `it('jupiter.ts imports cleanly')` — `await import('../server/jupiter')`; asserts `JupiterService`, `createJupiterService`, `SOL_MINT` are defined.
- Proves the zero-side-effect boundary the Explore report established. ~30 lines.

### Step 2. Un-exclude `routes.test.ts` and bring it inside the gated vitest layer
- Move `routes.test.ts` (repo root) into `server/routes.http.test.ts` (or keep it but remove the `routes.test.ts` exclude-glob in `vitest.config.ts` once mocks are confirmed sufficient). The mock surface is already proven — Postgres is fully stubbed via `vi.mock('./server/storage')`. Bring it inside the gate.
- This single action converts D1+D2 from CRITICAL untested → tested.

### Step 3. Integration E2E layer for the main files — `server/main.integration.test.ts`
Exercises the real code paths in the two main files against stubbed DB / RPC / fetch. Each test imports the real `routes.ts`/`jupiter.ts`, never a pure mirror.
- **routes.ts paths** (lift the mock scaffold from `routes.test.ts` verbatim):
  - `setShadowModeEnabled(true)` → `getShadowTrades()` fails-fast or returns `{open:[],closed:[]}` — setter/getter round trip.
  - `getShadowTrades()` after `setShadowModeEnabled(false)` returns the documented shape (`{open: ShadowTrade[], closed: ShadowTrade[]}`).
  - `executeEnhancedEdgeFilter(...)` with mocked `global.fetch` (stub rugcheck/DexScreener responses) → returns the expected scored decision shape, asserts the gold-score / liquidity / safety outputs are present, no throw. Stub `checkAdvancedFilters` via `vi.mock('./server/advanced_filters')`.
  - Boot `registerRoutes(httpServer, app)` with `supertest` against the mocked storage/jupiter/fetch surface → drive `GET /api/bot/status`, `/api/bot/trades`, `/api/engine/risk-status`, `/api/settings` → assert 200 + JSON schema (this is what `routes.test.ts` already does; we either reuse it or extend with a buy-path-stub exercise).
- **jupiter.ts paths** (lift the canonical `rpc.exec` spy from `server/jupiter.test.ts`):
  - Construct `new JupiterService([dummyUrl], Keypair.generate() private key)`.
  - `vi.spyOn(service['rpc'], 'exec').mockResolvedValue(...)` → drive `getWalletBalance`, `getTokenBalance`, `preflightQuote`, `executeBuy` (partial-fill < 70% path), `executeSell`.
  - **Use `vi.useFakeTimers()`** to neutralize the 30s `setInterval(runHealthChecks)` scheduled by `RpcRotator` construction (the Explore report's note). Otherwise Vitest hangs on open handles.
- Naming: these mirror the production entry points (`runScanCycle` is the orchestrator at `routes.ts:3210` but it is a giant inline block — we do NOT extract it; we exercise its reachable exports + the HTTP surface that wraps it).

**Honest scope note (Q4 finding surfaced to the user):** `routes.ts` re-implements 4 of the 6 pipeline layers inline rather than calling the pure modules. The new integration E2E therefore exercises **routes.ts's own inline implementations**, NOT the same six pure functions `full-pipeline.integration.test.ts` chains. We will not silently conflate the two; the test names will state exactly which layer they verify.

### Step 4. Wire the layered gate — `package.json` + `vitest.config.ts`
- Add an `npm run gate` script that runs the three layers in order and stops on first failure:
  1. `npm run check` (`tsc` — syntax, already exists)
  2. `npx vitest run tests/smoke.test.ts` (smoke)
  3. `npx vitest run` (full integration incl. `routes.test.ts` and the new `main.integration.test.ts`)
- **Fix `npm test`**: change `"test": "node --test"` → `"test": "npm run gate"` so a CI call to `npm test` runs the same command a human runs. (Resolves D3.)
- Update `vitest.config.ts`: remove the silent exclude for `routes.test.ts` (now mockable) and any stale excludes; commit the explicit smoke-vs-integration grouping in a comment.
- Add a one-line smoke note to `package.json` so the gated order is documented in the manifest.

## Phase C/D — convergence (post-implementation)
- Re-run `npm test` (= `npm run gate`): smoke → tsc → integration. All three must pass.
- Re-run `npx vitest run` standalone to confirm no regression in the existing 304.
- Defects D1–D4 are individually walked and re-traced at their boundaries (fake-timer race, mock-storage coverage, HTTP status assertions) per Phase C.
- Convergence when: zero new defects, all layers green, AND every uncommitted in-flight change (`server/routes.ts` diff, etc.) is either reverted if it wasn't ours or covered by a green test.

## What this plan does NOT do (stated honestly)
- Does NOT refactor `routes.ts` to extract `runScanCycle` into a testable orchestrator. Out of scope — would be a main-file rewrite, not a test gate.
- Does NOT add live RPC / on-chain integration (H8: a paper/-5% stop cannot fill on a rug). All E2E is against mocked surfaces; forward/paper validation remains a separate, wall-clock-bound activity (the GOAL is the gate, not a live run).
- Does NOT claim the existing `full-pipeline.integration.test.ts` exercises production layers — it is flagged in this plan as a clean-room mirror.