# Handoff Prompt — Solana Trading Bot: New-Mint Lane TDD Completion

> Paste everything below the line into Antigravity as the task prompt. It is written so a fresh agent with no prior context can take over and finish.

---

## ROLE & MISSION

You are a senior TypeScript/Node engineer taking over an in-progress, test-driven hardening of a Solana memecoin trading bot. A previous agent built a "new-mint early-survivor" entry lane and just unblocked it. Your job: **drive it to a proven, measurable, paper-mode result using strict TDD**, then leave it in a clean, documented, pre-live state. Do NOT enable live trading.

**Repo root:** `C:\god_ai\crypto-trader-v1_1\`
**Primary file under work:** the Express route/engine file `routes.ts` (~439 KB, ~6300 lines; lives under the server source tree — locate it with a search, it contains `goldHunterTradeEntry` and `pollNewMintsHelius`).
**OS/shell:** Windows. **Runtime:** Node 24, `tsx`, Python 3 (ML server). Mode (`paper`) and `PAPER_SEED` are read from `.env`.

---

## THE END GOAL (Definition of Done)

The strategy is **−EV globally** at the historical level (raw round-trip cost ~3.76% vs typical 1–2% peak capture). The new-mint lane is a bet that *early-survivor selection* changes the population enough to be +EV. **It is unproven — there is ZERO trade data yet.** Done means ALL of:

1. **First entries fire.** Paper run produces `[GOLD-ENTRY] ENTERING … tier=NEW_MINT … mode=SNIPER` lines (this milestone has never been reached before).
2. **Per-lane P&L is measured.** You can report realized paper P&L for `tier=NEW_MINT` entries *separately* from scanner/GMGN trades, across a statistically meaningful sample (target ≥ 30 closed paper trades, or as many as a multi-hour hot-regime run yields).
3. **A decision is made on evidence:** either (a) the lane beats the ~3.76% round-trip cost → document the winning config; or (b) it does not → document why and leave the lane gated OFF by default (raise `NEW_MINT_MIN_SCORE` or set an enable flag to false).
4. **Regression tests pass** (unit + integration) and `npm run check` is clean (modulo the documented env-noise diagnostics).
5. **Pre-live checklist** (bottom of this doc) is reviewed and annotated. Live stays disabled.

---

## WHERE THE PREVIOUS AGENT ENDED (current state)

All in `routes.ts`, inside `goldHunterTradeEntry` (starts ~line 5807) and the new-mint poller `pollNewMintsHelius`:

- **New-mint detector** `pollNewMintsHelius` (Raydium V4 `675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8` + PumpSwap `pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA`), 6s interval, bootstrap 6 polls, heartbeat `[NEW-MINT-DIAG] okPrograms=2/2`.
- **Confirmation funnel** `promoteNewMintWatchlist()`: 90s delay (`NEW_MINT_ENTRY_DELAY_MS`=90000), token-age filter (`NEW_MINT_MAX_TOKEN_AGE_MIN`=60 → drops re-listed old pools), liquidity floor (`NEW_MINT_MIN_LIQ_USD`=25000), net m5 buyers, `NEW_MINT_MIN_M5_CHANGE`≥−5. Concurrency guard `_promoteRunning` (try/finally). On confirm it builds `sig = { tier:'NEW_MINT', score:0, … }` and calls `goldHunterTradeEntry` (~line 6213, logs `… -> normal-gate entry`).
- **Entry gate (just fixed):** new-mint survivors use a dedicated floor `NEW_MINT_MIN_SCORE` (default **65**, env-overridable) instead of the global 90 wall, force `qualifiedMode='SNIPER'`, and **bypass EDGE_POCKET** (added `!_isNewMintSurvivor` to the bypass at ~line 5930), same as LEGENDARY picks. The global scanner/GMGN path is untouched at 90.
- **Safety still hard-vetoes** LP-unlocked-whale-distribution (`netSell≥3`) and single-holder ownership and honeypot — confirmed firing (`$JCGSWA`, `$HANSEMS` blocked). LP-unlocked and single-holder PAPER-probes (`[LP-VETO-PAPER-PROBE:PAPER]`, `[GOLD-SH-PROBE:PAPER]`) admit those names for PAPER/SHADOW measurement only; LIVE remains hard-vetoed.

**Key discovery that motivated the fix:** the entry function re-fetches + re-scores, so a token shown as combined 77–87 in the funnel breakdown re-scores to ~63–75 at the gate. That is why the old 80 floor produced zero entries. Confirmed candidates last run: `$3zYGCp` (gate 67, 102s, $121k liq, +12.8%), `$H8NoF4` (75, 90s, $97k, +30.6%), `$ztXmc4` (66), `$xGatR5` (63, +82% — just missed 65), `$6kA2JK` (35, correctly skipped).

---

## HARD INVARIANTS — DO NOT VIOLATE

1. **Never lower the global `engineSettings.minScoreToTrade` (90)** or the scanner-path gate. There's an in-code warning at ~line 297: the 70–79 band was the worst historical band (−3.90%/trade); every band ≥80 was positive. The new-mint floor (65) is a *separate, paper-only, tier-gated* lane — keep it that way.
2. **MODE must stay `paper`.** Do not set live. LP-unlocked / single-holder admissions are PAPER/SHADOW measurement ONLY; live hard-veto must remain.
3. **`routes.ts` is CRLF.** When editing programmatically, do single-line `str_replace` edits, or read→modify→write with `newline=''` + `.replace('\n','\r\n')` and assert exactly one replacement before writing. PowerShell here-strings with nested quotes corrupt the file — avoid them.
4. **`esbuild` does NOT type-check.** Always run real `tsc`. Ignore these env-noise diagnostics only: `TS2591` (process/console), `TS7006`, `TS2307`, `TS2304` (incl. global/setImmediate), `TS2322`. Any OTHER error is real.
5. **Don't touch `node_modules`.** Don't add network-dependent deps unless network is confirmed on — prefer the dependency-free `tsx` harness below.
6. **One variable per experiment.** When tuning, change a single env knob, re-run, compare. Don't batch-tune.

---

## TDD PROCESS TO FOLLOW (red → green → refactor)

There is currently **no test runner**. Build a zero-dependency harness using `tsx` (already installed) so tests run without network.

### Step 1 — Extract pure logic so it's testable
The gate logic is currently inline in `goldHunterTradeEntry`. Refactor the *decision* into a pure, exported function (no I/O), e.g. in a new `server/lib/newMintGate.ts`:
```ts
export interface GateInput {
  tier: string; combinedScore: number; mlScore: number;
  px5m: number; volMom: number; bp5m: number; pc5m: number;
  qualifiedMode: string | null;
  env: { NEW_MINT_MIN_SCORE?: number; EDGE_POCKET_ONLY?: boolean; /* … */ };
}
export interface GateDecision { admit: boolean; reason: string; mode: string | null; effectiveMinScore: number; }
export function evaluateNewMintGate(i: GateInput): GateDecision { /* mirror routes.ts logic */ }
```
Then call this function from `routes.ts` so production and tests share one code path. (Red first: write the test, watch it fail, then wire it in.)

### Step 2 — Unit tests (write FIRST, from the real run data)
Create `tests/newMintGate.test.ts`. Encode the observed cases as the spec:
- `$H8NoF4` score 75, pc5m +30.6% → **ADMIT** (mode SNIPER).
- `$3zYGCp` score 67, pc5m +12.8% → **ADMIT**.
- `$ztXmc4` score 66, pc5m +1% → **ADMIT**.
- `$xGatR5` score 63 → **REJECT at 65** (document this boundary; it's the +82% one — decide later if a momentum-override is warranted).
- `$6kA2JK` score 35 → **REJECT**.
- A `tier:'NEW_MINT'` survivor must **bypass EDGE_POCKET** (admit at score 67 even though < 80).
- A `tier:'HIGH'`/scanner token at score 67 must **still be REJECTED** (global 90 wall intact) — this is the critical regression guard.
- LP-unlocked / single-holder inputs → live=REJECT, paper=admit-for-measurement.

### Step 3 — Run red, implement, run green, refactor. Repeat for each new rule.

### Step 4 — Integration test (real processes, paper mode) — see commands below.

### Step 5 — Analyze logs, compute per-lane P&L, decide, document.

---

## COMMANDS

> Run from `C:\god_ai\crypto-trader-v1_1\`.

### A. Build & type-check (must be green before any run)
```bat
npm install            :: only if deps are stale
npm run check          :: tsc --noEmit (the real type gate)
npm run build          :: = npm run check && tsx script/build.ts && build:liquidator
```
Fast hot-file checks while iterating:
```bat
npx esbuild server\routes.ts --format=esm > NUL   :: syntax only (does NOT type-check)
npx tsc --noEmit --skipLibCheck                    :: real type check (ignore documented env-noise)
```

### B. Unit tests (zero-dependency tsx harness)
```bat
npx tsx tests\newMintGate.test.ts          :: exits non-zero on failure
:: or, if you add a script:  npm run test:unit
```
(If you prefer a runner and network is ON: `npm i -D vitest` then `npx vitest run`. Otherwise stick with tsx + node:assert.)

### C. FULL END-TO-END INTEGRATION TEST (paper mode, all 3 processes) — CANONICAL COMMAND
This is the project's official E2E launch command. It builds, then opens three console windows (ML server, fast scanner, TSX trading engine). Run it from a Windows `cmd` shell at the repo root:
```bat
npm run build && start "ML Server" cmd /k "python solana_hybrid_sniper_ultra/ml_server.py" && start "Fast Scanner" cmd /k "node fast_scanner.cjs" && start "TSX Server" cmd /k "npx cross-env NODE_ENV=development tsx server/index.ts"
```
- `MODE=paper` and `PAPER_SEED=0.03` come from `.env` (verify the startup banner prints `[CONFIG] MODE=paper from .env applied`). Keep it paper.
- To override a lane knob for an experiment, set it in `.env` (or prepend `cross-env`), changing **one** at a time, e.g. `NEW_MINT_MIN_SCORE=65`, `NEW_MINT_ENTRY_DELAY_MS=60000`.
- Let it run **30–120 min** — you need real RAYV4/PumpSwap launches during a `[REGIME] Runner regime ON` window; a cold feed produces no entries by design.

**Capture the engine log for analysis** (the canonical command leaves logs in each window). For an assertable run, launch the TSX window so it also tees to a file — replace the last segment with:
```bat
start "TSX Server" cmd /k "npx cross-env NODE_ENV=development tsx server/index.ts > logs\paper_run.log 2>&1"
```
(or pipe through a tee utility) so step D has a file to grep. Create the `logs\` folder first if needed.

### D. Integration assertions (what "green" means)
After the run, grep the captured engine log:
```bat
findstr /C:"GOLD-ENTRY] ENTERING" /C:"tier=NEW_MINT" logs\paper_run.log   :: MUST have >=1 entry line
findstr /C:"NEW-MINT] CONFIRM" logs\paper_run.log                        :: funnel reaching entry
findstr /C:"okPrograms=2/2" logs\paper_run.log                           :: detector healthy
findstr /C:"SAFETY-VETO" /C:"HARD-VETO" logs\paper_run.log                :: vetoes still firing
findstr /C:"Runner regime ON" logs\paper_run.log                         :: confirm a hot window occurred
```
Then write `scripts/analyze-pnl.ts` (run with `npx tsx scripts\analyze-pnl.ts`) that parses the paper-trade ledger / DB, filters `tier === 'NEW_MINT'`, and prints: count, win rate, mean & median round-trip %, total P&L, and net-of-cost edge vs 3.76%. **This is the deliverable that decides Done.**

---

## TUNING KNOBS (env; change one at a time, re-run C+D)
- `NEW_MINT_MIN_SCORE` (default 65) — the lane floor.
- `NEW_MINT_MAX_TOKEN_AGE_MIN` (60) — loosen only if a real rocket is dropped for age just over 60.
- `NEW_MINT_ENTRY_DELAY_MS` (90000) — next experiment: try 60000 to catch movers before migration.
- `NEW_MINT_MIN_LIQ_USD` (25000), `NEW_MINT_MIN_M5_CHANGE` (−5).
- `EDGE_EXPLOSIVE_SCORE` / `EDGE_EXPLOSIVE_ML` (consider 68 / 60 per prior notes).

---

## SUGGESTED EXPERIMENT BACKLOG (in order)
1. Get first `tier=NEW_MINT` entries; confirm the harness + P&L analyzer work end to end.
2. Measure baseline P&L at floor=65, delay=90s.
3. Single-variable: delay 90s → 60s. Re-measure. Keep if better.
4. Evaluate the +82% boundary case (`$xGatR5`, gate 63): decide whether to add an explosive-momentum override (high px5m + score≥60) vs. holding the 65 floor — justify with data, don't guess.
5. Review how LP-unlocked / single-holder PAPER-probe shadow trades resolve before trusting/relaxing those discriminators.

---

## PRE-LIVE CHECKLIST (review; keep live OFF)
- [ ] New-mint lane proven +EV in paper over a real sample, OR gated off by default.
- [ ] Re-validate the 65 floor + EDGE_POCKET bypass against realized paper P&L (the in-code warning is about LIVE EV on the old population).
- [ ] Gold bypass currently lets LEGENDARY (and via this change, NEW_MINT survivors) skip soft gates — confirm scope; consider LEGENDARY-only for the older bypass.
- [ ] `npm run check` fully clean (modulo documented env-noise).
- [ ] Remove stale `BIRDEYE_API_KEY` from Windows OS env (still loading: `[BIRDKEY] 1 Birdeye API key(s) loaded`).
- [ ] Confirm safety hard-vetoes (LP-unlocked, single-holder, honeypot) active on the LIVE path.

---

## REPORTING
When done, produce a short report: tests added (and what they lock in), integration run duration + regime windows hit, `tier=NEW_MINT` trade count, win rate, mean round-trip %, net edge vs 3.76% cost, the config that produced it, and a clear go/no-go recommendation for live. Be honest about sample size — a 5-trade sample is not proof.
