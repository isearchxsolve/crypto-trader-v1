# Trading Bot Convergence Framework — Corrected v3

> Changes from v2 are marked [FIX]. Every fix includes the defect it corrects and arithmetic proof.

## Core Principle

The bot is a **deterministic algorithm operating on stochastic inputs.** You can PROVE what the code will compute given assumed inputs, but you cannot PROVE market outcomes. Code-correctness is provable from source alone; behavioral prediction requires empirical validation.

---

## Phase 0 — Define the Objective

```
GOAL:              Maximize expected net profit per trade after ALL costs
DECISION VARIABLE: x = enter token T at size s (or skip)

f(x) = captureMult(score) * E[peak_move | liq] - round_trip_cost(liq)

  captureMult(score) = 0.7 + 0.3 * clamp((score - 70) / 20, 0, 1.0)
  ──────────────────────────────────────────────────────────────────
  [FIX-1] v2 used: 0.7 + 1.3 * clamp(..., 0, 1.2) → max = 2.26
  DEFECT: captureMult > 1.0 is physically impossible. You cannot
  capture more than 100% of a price move.
  Proof — score=90, liq $8k, cost=6.6%, peak=5%:
    v2: f(x) = 2.0 * 5% - 6.6% = +3.4%  → ENTERS (wrong)
    v3: f(x) = 1.0 * 5% - 6.6% = -1.6%  → SKIPS  (correct)
  CORRECT RANGE: captureMult ∈ [0.70, 1.00]
    score ≤ 70  → 0.70 (weak signal, conservative capture)
    score = 90  → 1.00 (strong signal, full capture assumed)
    score = 100 → 1.00 (capped; cannot exceed 100% of a move)
  ──────────────────────────────────────────────────────────────────

  round_trip_cost(liq) = entry_slip + exit_slip + fees
    ~8.6% @ $1k–$5k liq   ... ~1.6% @ >$100k liq

DIRECTION:         Maximize f(x)
DECISION RULE:     ENTER iff f(x) > +1.0% (OBJECTIVE_EV_MARGIN); else SKIP
CONVERGENCE CHECK: Realized mean(f(x)) > +1.0% over >= 30 trades (paper or live)
LOSS FUNCTION:     Count of OBJECTIVE defects = paths that are code-correct
                   but do NOT provably raise E[f(x)] given validated inputs
```

### Input Classification (mandatory for every path)

| Input | Type | Allowed Use |
|---|---|---|
| score | DESCRIPTIVE | May scale captureMult; NEVER standalone entry trigger |
| momentum | DESCRIPTIVE | Score component only |
| volume surge | DESCRIPTIVE | Score component only |
| holder growth | DESCRIPTIVE | Score component only |
| social signal | DESCRIPTIVE | Score component only |
| estimated peak | DESCRIPTIVE PRIOR | Feasibility screen in f(x); NOT a forecast |
| liquidity | STRUCTURAL/REAL | Cost model + sizing |
| contract health | STRUCTURAL/REAL | Hard gate (G1) |
| forward signal | PREDICTIVE (if validated) | May trigger entry if forward-validated |

**Rule:** If NO predictive input exists, E[capture] ≈ 0. The bot must:
- (a) acquire and validate a predictive signal, OR
- (b) report objective-infeasible and halt trading

### [FIX-2] OD-1 Consistency Rule (new in v3)

v2 left OD-1 open while still allowing paper trading using descriptive priors in f(x). This is an internal contradiction.

**Resolution:** Paper trading is permitted only under an explicit **descriptive-prior hypothesis** declared at the start of every Phase E run:

> *"estimatedPeakPct(liq) is assumed stable enough to screen feasibility. Score composite is provisionally correlated with outcomes. Both claims are FALSIFIED if paper mean(f(x)) < +1.0%."*

If paper fails, the first diagnosis is OD-1 — not code defects. Do NOT add more gates to fix a failing model.

---

## The Loop

```
Phase 0 (OBJECTIVE) → Phase A (SCAN) → Phase B (FIX) → Phase C (RE-SCAN) → Phase D (CHECK)
         ↑                                                                          |
         └──────────────────────── if defects found ──────────────────────────────┘
```

After Phase D (analytical convergence) → Phase E (EMPIRICAL VALIDATION)

---

## Phase A — SCAN (Comprehensive, No Fixes)

### A1. Enumerate every code path

- Scoring path (base score, bonuses, penalties)
- Entry gates G1–G5 (universe, liquidity, score floor, sniper routing, objective-EV)
- Objective-EV gate (objectiveNetEvPct, OBJECTIVE_EV_MARGIN = 1.0%)
- Cost model (entry_slip, exit_slip, fees)
- Partial TP eligibility check
- Exit paths (stop −5%, trailing arm +8%, partial-TP +3% @ 50%, cooldowns)
- Position sizing (conviction derivation, sizing caps)
- Zero-liquidity guard and edge-pocket path
- All subsystem interaction points

### A2. Trace each path with concrete values

Pick real numbers. Execute mentally. Write every intermediate. Do not hand-wave. If you cannot pick a concrete value, the path is underspecified — that is itself a defect.

### A3. Classify each finding

| Classification | Question | Action |
|---|---|---|
| DEFECT | Value moves objective in wrong direction? | Record. Do NOT fix yet. |
| DEAD CODE | Computed but never used? | Record. Do NOT fix yet. |
| INTERACTION | Two parameters create an impossible combination? | Record. Do NOT fix yet. |
| CONTRADICTION | Comment/config says one thing, value another? | Record. Do NOT fix yet. |
| UNREACHABLE | Threshold above any reachable value? | Record. Do NOT fix yet. |
| UN-WINNABLE | Round-trip cost exceeds achievable peak? | Record. Do NOT fix yet. |
| OBJECTIVE DEFECT | Code-correct but fails to raise E[f(x)]? | Record. Do NOT fix yet. |
| PREDICTIVE-VALIDITY DEFECT | Past-describing signal used as forecast without proof? | Record. Do NOT fix yet. |
| DEFECTIVE APPROACH | Proposed change violates objective or constraint? | Record. Do NOT construct. |
| VERIFIED OK | Path works AND advances the objective? | Mark verified. No action. |

### A4. Record ALL findings before touching code

ID (D1, D2…), severity, file:line + quoted code, current vs correct, arithmetic proof.

### A5. Interaction check

For every pair that feeds each other: *"Can a valid candidate pass ALL gates in sequence and still have f(x) > margin?"*

---

## Phase B — FIX

Apply ALL recorded fixes in one pass. For each:
- Add a comment explaining what was wrong, why the new value is correct, and the arithmetic proof
- Re-read surrounding lines for immediate interactions
- Do NOT build a fix on an unvalidated descriptive prior
- After fixing, verify the code still compiles/transpiles

---

## Phase C — RE-SCAN

Re-run the ENTIRE Phase A scan against the fixed code. Re-trace each path, re-check every interaction. Confirm no fix created a new defect and none was too aggressive (blocking legitimate profitable entries is itself a defect). New defects → back to Phase A.

---

## Phase D — CONVERGENCE CHECK

Did the last full A + C scan find ZERO new defects across ALL representative paths AND all interaction checks pass?

- **YES** → analytically converged. Proceed to Phase E.
- **NO** → back to Phase A.

Analytical convergence is NOT reality convergence. It proves code-correctness and objective alignment for the assumed model. Real-world performance is tested separately.

---

## Phase E — EMPIRICAL VALIDATION

**Rule:** Deploy to PAPER ONLY after Phase D. Live trading only after paper validation.

**[FIX-2 applied]** State the active hypothesis explicitly at Phase E start:

> *"We are running under the descriptive-prior hypothesis: estimatedPeakPct(liq) is a stable-enough prior to screen feasibility, and the score composite has provisional correlation with outcomes. This hypothesis is falsified if paper mean(f(x)) < +1.0%."*

**Acceptance criterion:** Realized mean(f(x)) > +1.0% over >= 30 trades.

**If paper fails:**
- The code has zero defects (proven in Phase D)
- The defect is in the **inputs or model** — descriptive signals treated as predictive, wrong cost estimates, or incorrect peak priors
- Return to Phase 0. Re-examine input classification, cost model, or peak estimates
- Do NOT add more gates to fix a broken model

---

## ANTI-DRIFT RULES — v3

**R1.** Follow phases in order. Never skip Phase 0 or A. Never fix during scan. Never deploy before Phase D.

**R2.** No invented names. Phases 0/A/B/C/D/E. Defects D1/D2/D3.

**R3.** Code is primary evidence. Use logs/trades only to confirm or classify known defects.

**R4.** Trace to source. A bad exit is often born at entry or scoring. Walk upstream.

**R5.** Check interactions. *"Can a valid candidate clear ALL gates AND still have f(x) > margin?"*

**R6.** Record everything. Every defect, fix, and re-scan result. A stale record is drift.

**R7.** No premature convergence. Zero defects across ALL representative paths + ALL interactions.

**R8.** Do not react to one trade. Judge over >= 30 trades.

**R9.** Do not overshoot. A gate that blocks profitable entries is worse than no gate.

**R10.** Converge on the objective, not the code. Zero bugs is necessary, not sufficient.

**R11.** Descriptive ≠ predictive. Score, momentum, and estimated peak describe the past. They inform f(x) but may NOT trigger entry alone until forward-validated.

**R12.** Analytical convergence ≠ empirical success. Phase D proves code. Phase E proves reality. Both are required.

**R13. [FIX-2]** If NO predictive input exists, state the descriptive-prior hypothesis explicitly before Phase E. Do not silently proceed as if the model is validated.

**R14.** If NO predictive input exists AND paper trading is not permitted as a hypothesis test, the bot is infeasible. Fix signal acquisition or halt.

**R15. [FIX-1]** captureMult MUST be ≤ 1.0 at all score values. Any formula yielding captureMult > 1.0 is a CRITICAL defect. Verify at Phase A for every scoring path.

---

## OUTPUT FORMAT FOR EACH FINDING

```
ID:                    D{N}
MODE:                  VERIFY / SOLVE
SEVERITY:              CRITICAL / MEDIUM / LOW
LOCATION:              {file}:{line} — "{quoted code}"
CURRENT VALUE:         {what it is}
CORRECT VALUE:         {what it should be}
CLASSIFICATION:        [see table above]
ARITHMETIC PROOF:      {hand-trace with concrete liq/score/cost values}
OBJECTIVE IMPACT:      {how this changes E[f(x)]}
FIX:                   {exact code change}
BLAST RADIUS:          {what else this affects; what was NOT touched}
INTERACTION CHECK:     {does this interact with other fixes/gates?}
VERIFICATION:          {how to confirm from code}
STILL UNVERIFIED:      {what needs empirical validation}
```

---

## BUG-CLASS CHECKLIST (v3)

- [ ] Symptom-vs-source: bad exit born at scoring/entry
- [ ] Computed-but-not-enforced: value calculated, never gated on
- [ ] Unreachable trigger: threshold above any reachable score/price
- [ ] Reactive floor gapped: price jumps a stop between checks
- [ ] Sunk-cost double-count: re-charging already-paid entry cost in stop or TP check
- [ ] Un-winnable geometry: round-trip cost exceeds achievable peak
- [ ] Boundary errors: < vs <=, > vs >= on score/liq/price gates
- [ ] Two paths that look like one: guard on sniper path, action on momentum path
- [ ] Misleading diagnostics: stale labels causing wrong conclusions
- [ ] Objective defect: gate is code-correct but does not raise E[f(x)]
- [ ] Predictive-validity defect: gate/fix uses a past-describing signal as a forecast
- [ ] Interaction impossibility: score bonus lifts token past a gate whose cost makes f(x) < 0
- [ ] Defective approach: proposed change violates objective or a constraint
- [ ] Double-counting: same variable applied twice in a formula
- [ ] **[NEW — FIX-1] captureMult > 1.0: formula yields physically impossible capture ratio**
- [ ] **[NEW — FIX-2] OD-1 silent bypass: descriptive priors used in f(x) without hypothesis declaration**
- [ ] **[NEW — FIX-3] Partial TP sunk-cost error: TP eligibility check includes already-paid entry slippage**

---

## KNOWN DEFECTS ON RECORD — v3

| ID | Description | Status | Resolution |
|---|---|---|---|
| OD-1 | No validated forward-predictive input | **OPEN** | Requires forward-validation of a signal against >= 30 out-of-sample trades, OR explicit descriptive-prior hypothesis before Phase E |
| OD-2 | Un-winnable liquidity entries | Fixed | f(x) gate + liquidity floors |
| OD-3 | Partial-TP unreachable at low liq | Watch | Disable if `exit_slip(liq) + (fees/2) >= 3%` (FIX-3) |
| OD-4 | Score not EV-validated | Watch | Score must remain INPUT to f(x), never the decision trigger |
| OD-5 | Conviction double-counting | Fixed | f(x) uses captureMult only |
| OD-6 (NEW) | captureMult > 1.0 | **Fixed in v3** | FIX-1: formula corrected to cap at 1.0 |
| OD-7 (NEW) | OD-1 silent bypass | **Fixed in v3** | FIX-2: descriptive-prior hypothesis must be declared before Phase E |

---

## FIX-3 — Partial TP Eligibility Correction

**Defect in v2 bot:** The TP eligibility check was `if 0.03 <= round_trip_cost(liq)`, which includes entry slippage. At the point of TP exit, entry slippage is a sunk cost and must not be re-charged.

**Correct check:** `if exit_slippage(liq) + (fees / 2) >= 0.03: partial_tp_enabled = False`

**Arithmetic:**

| Liq Tier | Exit Slip | Fees/2 | Exit Cost | TP Net | Correct Action |
|---|---|---|---|---|---|
| $1k–$5k | 4.0% | 0.3% | 4.3% | −1.3% | DISABLE ✓ |
| $5k–$10k | 3.0% | 0.3% | 3.3% | −0.3% | DISABLE ✓ |
| $10k–$25k | 2.0% | 0.3% | 2.3% | +0.7% | **ENABLE** (v2 wrongly disabled) |
| $25k–$100k | 1.0% | 0.3% | 1.3% | +1.7% | ENABLE ✓ |
| >$100k | 0.5% | 0.3% | 0.8% | +2.2% | ENABLE ✓ |

---

## SUMMARY — v3

```
Phase 0: Define f(x) with captureMult CAPPED AT 1.0. Label every input.
         Declare descriptive-prior hypothesis if OD-1 is open.
Phase A: Scan ALL representative paths. Verify captureMult ≤ 1.0 at every score.
         Check partial TP uses exit-only cost (sunk cost rule).
         Record ALL findings. Do NOT fix.
Phase B: Fix ALL defects. One pass. No fix built on an unvalidated prior.
Phase C: Re-scan ALL paths. Check interactions.
Phase D: Zero defects → analytically converged → proceed to Phase E.
Phase E: State active hypothesis. Paper-trade >= 30 trades.
         Realized mean(f(x)) > +1.0% confirms hypothesis.
         If paper fails: OD-1 is first suspect. Return to Phase 0.
Follow this. Do not drift. Execute the loop.
```
