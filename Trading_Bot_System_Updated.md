# Trading Bot System — Actual Trading Logic & Mechanics (Updated)

> All D1–D9 fixes from the convergence scan applied. Changed sections are marked [FIX Dn].

## Purpose

This document defines the actual mechanics of a Solana micro-cap trading bot: scoring, execution, risk management, and operational parameters. It is the system that the Convergence Framework is meant to debug and optimize.

**Prerequisite:** Read "Trading Bot Convergence Framework — Corrected v3" before implementing this system. Every parameter here must be traced against the objective function f(x) defined there.

---

## 1. MARKET UNIVERSE & DATA INGESTION

### 1.1 Token Universe

- **Chain:** Solana (SPL tokens)
- **Market cap filter:** $50k – $5M (micro-cap range)
- **Liquidity filter:** Minimum $1,000 USD pool liquidity (Raydium, Orca, or Meteora pools) — see note on effective minimum in §3.4
- **Age filter:** Token launched >= 24 hours ago (avoid immediate rugs, allow price discovery)
- **Blacklist:** Exclude tokens with known scam patterns (mint authority still active, LP not burned, contract flagged)

### 1.2 Data Feeds

- **Price source:** Jupiter API (aggregated Solana DEX prices)
- **Liquidity source:** On-chain pool data (Raydium/Orca SDK)
- **Update frequency:** 5-second polling for active candidates; 30-second for screening
- **Historical data:** Minimum 4 hours of price history for scoring (descriptive inputs)
- **Forward signal data (if available):** Whale wallet tracking, social sentiment, exchange listing rumors — **must be validated separately before use**

---

## 2. SCORING SYSTEM

### 2.1 Base Score (0–100)

The score is a **descriptive composite** of past behavior. It has NO proven forward predictive validity unless separately validated (see OD-1 in Framework).

**Components:**

| Component | Weight | Calculation | Rationale |
|---|---|---|---|
| Price momentum (1h) | 25% | (price_now / price_1h_ago - 1) * 100, normalized 0–100 | Recent directional strength |
| Volume surge | 20% | volume_1h / volume_4h_avg, normalized 0–100 | Attention/interest spike |
| Liquidity stability | 15% | 1 - (liquidity_std_4h / liquidity_mean_4h) * 100 | Pool depth consistency |
| Holder growth | 15% | new_holders_1h / total_holders * 100, capped at 100 | Distribution widening |
| Social signal | 15% | Mentions/minute normalized vs 4h baseline (if available) | External attention |
| Contract health | 10% | Binary score (LP burned=100, mint revoked=100, verified=100) | Safety floor |

**Calculation:**

```python
base_score = sum(component * weight for component, weight in components)
base_score = clamp(base_score, 0, 100)
```

**[FIX D6] Social signal weight normalization:**

When social signal data is unavailable, weights must be renormalized so the basis remains 100%.

```python
if not social_available:
    # Redistribute 15% proportionally across remaining components
    weights = {
        'momentum':         0.294,  # 25/85
        'volume':           0.235,  # 20/85
        'liq_stability':    0.176,  # 15/85
        'holder_growth':    0.176,  # 15/85
        'contract_health':  0.118,  # 10/85
    }
```

Without this fix, tokens lacking social data score ~15% lower than identical tokens with social data, creating a systematic entry bias.

### 2.2 Score Bonuses & Penalties

**Bonuses:**
- +10 if price momentum > +50% in 1h (strong breakout)
- +5 if volume surge > 5x average (viral attention)
- +5 if liquidity > $50k (low slippage entry)

**Penalties:**
- -20 if liquidity < $5k (high cost, likely un-winnable)
- -15 if contract health < 50 → **[FIX D9] REMOVED — see §3.4 G1 gate instead**
- -10 if holder growth is negative (distribution contracting)
- ~~-10 if price is at all-time high~~ **[FIX D3] REMOVED — unvalidated predictive claim**
  - ATH flag is now logged for post-hoc correlation analysis only

**[FIX D3 rationale]:** The ATH penalty embedded a mean-reversion assumption without empirical validation. In Solana micro-cap pump dynamics, new ATH during a momentum event often signals continuation, not reversal. At liq $10k–$25k, this penalty was the difference between ENTER and SKIP for borderline-score tokens.

**Final score:**

```python
final_score = clamp(base_score + bonuses - penalties, 0, 100)
```

---

## 3. ENTRY DECISION SYSTEM

### 3.1 Objective Function

```python
f(x) = captureMult(score) * estimated_peak_pct(liq) - round_trip_cost(liq)

# [FIX D1] Corrected formula — was: 0.7 + 1.3 * clamp((score - 70) / 20, 0, 1.2)
# DEFECT: old formula reached captureMult = 2.26 at score=100, which is
# physically impossible (cannot capture > 100% of a price move).
# At score=90, liq=$8k: old f(x) = 2.0*5% - 6.6% = +3.4% (WRONG ENTER)
#                        new f(x) = 1.0*5% - 6.6% = -1.6% (CORRECT SKIP)
captureMult(score) = 0.7 + 0.3 * clamp((score - 70) / 20, 0, 1.0)
# Range: [0.70, 1.00]
# score ≤ 70  → 0.70
# score = 90  → 1.00
# score = 100 → 1.00 (hard cap)

round_trip_cost(liq) = entry_slippage(liq) + exit_slippage(liq) + fees
```

### 3.2 Cost Model

| Liquidity Tier | Entry Slip | Exit Slip | Fees | Total Cost |
|---|---|---|---|---|
| $1k – $5k | 4.0% | 4.0% | 0.6% | 8.6% |
| $5k – $10k | 3.0% | 3.0% | 0.6% | 6.6% |
| $10k – $25k | 2.0% | 2.0% | 0.6% | 4.6% |
| $25k – $100k | 1.0% | 1.0% | 0.6% | 2.6% |
| > $100k | 0.5% | 0.5% | 0.6% | 1.6% |

**Note:** These are empirical estimates. Update from real fill data after every 10 trades. If realized cost exceeds model by >20%, flag for model recalibration.

### 3.3 Estimated Peak (Descriptive Prior)

```python
def estimateRealisticPeakPct(liq):
    """Returns a descriptive estimate of typical peak move for this liquidity tier.
    NOT a forecast. Used only in f(x) for feasibility screening."""
    if liq < 5000:  return 3.0   # Low liq = limited upside, fast dump
    if liq < 10000: return 5.0   # Small cap, moderate pump
    if liq < 25000: return 8.0   # Mid-micro, room to run
    if liq < 50000: return 12.0  # Larger pool, more participants
    return 15.0                  # High liq micro, rare but possible
```

**Important:** This is a historical prior based on observed distributions. It is NOT a prediction of what THIS token will do. It is used to answer: "Can this tier even theoretically produce enough move to beat costs?"

### [FIX D2] Effective Liquidity Minimum

Under the corrected captureMult (≤ 1.0), the $5k–$10k liq tier is UN-WINNABLE:

```
max f(x) at $5k–$10k: 1.0 * 5% - 6.6% = -1.6%  ← always negative
```

G5 will always reject these tokens. However, they are not explicitly flagged, which creates misleading near-miss logs.

```python
EFFECTIVE_MIN_LIQ = 10_000  # USD — below this, f(x) is always negative under v3

# Log un-winnable tiers instead of silently rejecting at G5:
if liq < EFFECTIVE_MIN_LIQ:
    log(f"[UN-WINNABLE] Token {token}: liq=${liq:.0f} below effective minimum. "
        f"Max f(x) = {max_fx:.2f}%. Skipping.")
    return SKIP
```

### 3.4 Entry Gates (Sequential)

A candidate must pass ALL gates to proceed to f(x) calculation:

| Gate | Condition | Purpose |
|---|---|---|
| **G1. Universe** | Token in universe, not blacklisted, age >= 24h | Basic eligibility |
| **G1b. Contract Safety [FIX D9]** | contract_health >= 50 (else blacklist 24h) | Hard safety block |
| **G2. Quality Liquidity** | Liquidity >= $1,000 | Avoid zero-liquidity traps |
| **G3. Score Floor** | Score >= 35 | Minimum signal strength |
| **G4. Sniper Override** | (Score >= 85 AND Liquidity >= $25k) OR (Score < 85) | Route to sniper path |
| **G5. Objective EV** | f(x) > +1.0% | The final decision: expected profit after costs |

**[FIX D9] Contract health hard gate:**

Previously, contract health < 50 only applied a -15 score penalty. At high liquidity, this was insufficient to block entry:

```
Old: contract_health=45, liq=$100k → score penalty -15 → score=75 → f(x)=+10% → ENTERS ❌
New: contract_health < 50 → G1b FAIL → blacklist 24h → SKIP ✓
```

**Entry path logic:**

```python
if not G1 or not G1b or not G2 or not G3:
    return SKIP

# [FIX D1] Compute f(x) ONCE. Snapshot conviction here for position sizing.
fx_value    = f(x)  # uses corrected captureMult
conviction  = fx_value / 0.10  # normalized: 1.0% margin = 1.0x, 5.0% = 5.0x

if G4:  # Sniper path — [FIX D8] now has real implementation
    execute_sniper_entry(token, liq, conviction)
else:
    if fx_value > 1.0:
        return ENTER(size=position_size(liq, conviction))  # conviction passed in
    else:
        return SKIP
```

**Critical rule:** Score alone NEVER triggers entry. Only f(x) > 1.0% triggers entry. Score is an input to f(x), not the decision.

### 3.5 Position Sizing

**[FIX D5] Conviction computed once at gate, passed explicitly — no internal f(x) re-evaluation:**

```python
def position_size(liq, conviction):
    # conviction = f(x) / 0.10, computed at G5 gate evaluation (not re-evaluated here)
    # Reason: re-evaluating f(x) inside position_size() risks using stale/changed
    # market data that differs from the gate decision, creating inconsistent sizing.

    max_position  = 0.05 * total_portfolio  # 5% max per trade
    liquidity_cap = 0.10 * liq              # never > 10% of pool

    base_size      = 0.01 * total_portfolio  # 1% base size
    conviction_size = base_size * clamp(conviction, 0.5, 5.0)

    return min(max_position, liquidity_cap, conviction_size)
```

### [FIX D8] Sniper Path Implementation

```python
def execute_sniper_entry(token, liq, conviction):
    """High-score, high-liq tokens (score>=85, liq>=$25k) get priority execution.
    [FIX D8] Previously this was dead code — 'if G4: pass'. Now implemented."""
    set_polling_interval(token, seconds=1)   # Override: 1s vs normal 5s
    set_priority_fee('max')                  # Max Solana priority fee
    execute_immediately()                    # Skip batch delay
    size = position_size(liq, conviction)
    jupiter_swap(token, size, slippage_tolerance=max(entry_slippage_model(liq) + 0.005, 0.01))
```

---

## 4. EXIT SYSTEM

### 4.1 Stop Loss (−5%)

- **Hard stop:** Sell 100% of position if price falls −5% from **actual fill price (post-slippage)**
- **Trigger type:** On-chain or off-chain monitoring with 5-second polling
- **Execution:** Market sell via Jupiter

**[FIX D7] entry_price defined explicitly as post-slippage fill price:**

```python
# entry_price MUST be the actual fill price received from Jupiter,
# NOT the pre-slippage market price at time of order.
# Using market price creates stop/trailing arm miscalculation:
#   At $5k liq (4% slip): fill = market * 1.04
#   Stop at market * 0.95 = loss from fill of -8.65% (not -5%)
#   Trailing arm at market * 1.08 = gain from fill of +3.85% (not +8%)
entry_price = actual_fill_price  # from Jupiter swap receipt
stop_price  = entry_price * (1 - 0.05)
```

**Actual realized loss on stop trigger** = 5% stop + exit_slippage(liq) + exit_fees

### 4.2 Trailing Stop Arm (+8%)

- **Arm trigger:** When price reaches +8% from **entry_price (fill price)**
- **Trailing stop level:** 5% below the highest price reached since arm

**Example:**
- Fill: $1.00 (post-slippage)
- Arm at: $1.08 (+8% from fill)
- Price rises to $1.20 → trailing stop moves to $1.14 (5% below $1.20)
- Price falls to $1.14 → sell triggered

### 4.3 Partial Take-Profit (+3%)

- **Trigger:** When price reaches +3% from entry_price (fill price)
- **Action:** Sell 50% of position

**[FIX D4] Corrected TP eligibility — uses exit-only cost (sunk cost rule):**

```python
# OLD (wrong): if 0.03 <= round_trip_cost(liq): partial_tp_enabled = False
# DEFECT: round_trip_cost includes entry slippage, which is already paid (sunk cost).
# At $10k-$25k liq: old check disabled TP (4.6% > 3%) but exit-only cost is 2.3%,
# yielding net +0.7% at TP — a missed profit opportunity.

# NEW (correct): compare only remaining costs to be paid
def exit_only_cost(liq):
    return exit_slippage(liq) + (fees / 2)  # fees split: half at entry, half at exit

if exit_only_cost(liq) >= 0.03:
    partial_tp_enabled = False
```

**Partial TP eligibility by tier:**

| Tier | Exit Cost | TP Net | Enabled? |
|---|---|---|---|
| $1k–$5k | 4.3% | −1.3% | Disabled |
| $5k–$10k | 3.3% | −0.3% | Disabled |
| $10k–$25k | 2.3% | **+0.7%** | **Enabled** (was wrongly disabled in v1) |
| $25k–$100k | 1.3% | +1.7% | Enabled |
| >$100k | 0.8% | +2.2% | Enabled |

### 4.4 Cooldown After Exit

- After any exit (stop, TP, or trailing stop): Token enters a 30-minute cooldown
- During cooldown: Token is ineligible for re-entry, even if score spikes
- **Exception:** Cooldown can be overridden if a new forward-predictive signal (validated separately) triggers with high confidence

### 4.5 Exit Priority

When multiple exit conditions are triggered simultaneously:
1. **Stop loss** (highest priority — capital preservation)
2. **Partial take-profit** (if price hits +3% but not yet at trailing arm)
3. **Trailing stop** (if armed and breached)

If stop loss and partial TP trigger at the same time (e.g., price gap), stop loss wins.

---

## 5. RISK MANAGEMENT

### 5.1 Portfolio-Level Limits

- **Max drawdown:** Halt all trading if portfolio drawdown from daily high exceeds −10%
- **Daily loss limit:** Stop trading for the day if realized losses exceed −5% of total portfolio
- **Max open positions:** 10 simultaneous positions
- **Max exposure per token:** 5% of total portfolio (enforced by position sizing)

### 5.2 Liquidity Risk

- **Minimum pool liquidity:** $1,000 (G2). Effective entry minimum is $10,000 (see §3.3 FIX D2)
- **Liquidity drop guard:** If pool liquidity drops by >50% while holding, trigger immediate exit
- **No new entries during high volatility:** If Solana network TPS < 500 or block times > 2 seconds, pause new entries

### 5.3 Smart Contract Risk

**[FIX D9] Contract safety is now a hard gate (G1b), not a score penalty:**

- **contract_health < 50 → auto-blacklist 24h, SKIP** (no score penalty; entry blocked entirely)
- **Mandatory checks before entry:**
  - Mint authority revoked (or supply fixed)
  - LP tokens burned (or locked)
  - Contract not flagged by community scanners (RugCheck, SolanaFM)

---

## 6. OPERATIONAL PARAMETERS

### 6.1 Monitoring & Alerting

- **Price polling:** 5-second intervals for active positions; 30-second for screening; 1-second for sniper path tokens [FIX D8]
- **Alert channels:** Telegram bot or Discord webhook for:
  - Entry executed (include fill price, computed f(x), conviction score)
  - Exit triggered (stop, TP, trailing) — include realized f(x) vs expected
  - Risk limit breached
  - Un-winnable tier hit (liq < EFFECTIVE_MIN_LIQ)
  - ATH flag logged (for correlation analysis — not a block) [FIX D3]
- **Log retention:** All trade logs, score snapshots, f(x) calculations, conviction values, and ATH flags retained for 90 days

### 6.2 Error Handling & Recovery

- **RPC failure:** Retry with exponential backoff (1s, 2s, 4s, 8s). After 4 failures, switch to backup RPC.
- **Jupiter swap failure:** Log error, retry once after 10 seconds. If still failing, mark as "stuck" and alert.
- **Stale data guard:** If price data timestamp is >60 seconds old, flag as stale and pause new entries.
- **Crash recovery:** On restart, reload all open positions from on-chain state. Do not re-enter already-entered positions.

### 6.3 Rebalancing & Parameter Updates

- **Cost model recalibration:** After every 10 trades, compare realized costs to modeled. If error >20%, update slippage table.
- **Score weight review:** Monthly — compare score components against realized win rates. Remove components with no correlation.
- **ATH correlation analysis [FIX D3]:** Monthly — compare realized f(x) for ATH-flagged vs non-ATH entries. If ATH entries show materially worse f(x) across >= 30 trades, re-introduce the penalty with empirical justification.
- **Peak estimate review:** Quarterly — compare estimateRealisticPeakPct against actual realized peak moves per tier.
- **Forward signal validation:** New predictive signals require >= 30 out-of-sample trades before use in entry decisions.

---

## 7. EXECUTION INTEGRATION (Solana)

### 7.1 Order Routing

- **Primary:** Jupiter Aggregator v6
- **Slippage tolerance:** `max(entry_slippage_model(liq) + 0.5%, 1.0%)`. Never exceed 2%.
- **Priority fee:** Dynamic (0.00005–0.005 SOL). Max fee on sniper path [FIX D8]. If fee > 0.01 SOL, pause and alert.

### 7.2 Wallet & Key Management

- **Trading wallet:** Dedicated hot wallet with only active trading funds
- **Cold wallet:** Majority of funds held cold; periodic transfers as needed
- **Key storage:** Environment variable or secure key management service (AWS Secrets Manager, HashiCorp Vault). Never commit keys to code.

### 7.3 Transaction Confirmation

- **Minimum confirmations:** 1 (monitor 5 seconds post-confirmation)
- **Timeout:** If not confirmed within 30 seconds, treat as failed. Do not double-spend.
- **Fill price capture:** Record actual Jupiter fill price as entry_price for all stop/TP calculations [FIX D7]

---

## 8. TESTING & VALIDATION

### 8.1 Unit Tests (Required)

- **captureMult bounds [FIX D1]:** Verify captureMult(0) = 0.70, captureMult(70) = 0.70, captureMult(90) = 1.00, captureMult(100) = 1.00. Assert captureMult(x) <= 1.0 for all x in [0, 100].
- **f(x) by tier:** Confirm $5k–$10k always negative, $10k+ can be positive with score > 70.
- **Partial TP eligibility [FIX D4]:** Verify enabled at $10k–$25k, disabled at $5k–$10k.
- **Score normalization [FIX D6]:** Verify tokens with/without social data score equivalently on other dimensions.
- **Contract health gate [FIX D9]:** Verify contract_health < 50 blocks entry even at liq = $1M.
- **Conviction consistency [FIX D5]:** Verify conviction computed once at gate; position_size uses passed value, not re-evaluated f(x).
- **Fill price reference [FIX D7]:** Verify stop_price and trailing arm use actual_fill_price, not market price.
- **Sniper path execution [FIX D8]:** Verify G4 tokens trigger 1s polling, max priority fee, immediate swap.

### 8.2 Backtest (Before Paper Trading)

- **Historical data:** Minimum 30 days of Solana micro-cap data
- **Simulation:** Replay all candidate tokens through scoring, gates, entry, exit
- **Output:** P&L, win rate, average return, max drawdown, cost accuracy, ATH-flag correlation
- **Acceptance:** Positive mean return per trade before live costs

### 8.3 Paper Trading (Before Live)

**State the descriptive-prior hypothesis before starting [FIX-2 from Framework]:**
> *"estimatedPeakPct(liq) is assumed stable enough to screen feasibility. Score composite is provisionally correlated with outcomes. Both claims are FALSIFIED if paper mean(f(x)) < +1.0%."*

- **Duration:** Minimum 30 trades or 14 days, whichever is longer
- **Metrics to track:** Realized f(x) vs expected, win rate, cost model accuracy, score-outcome correlation, ATH-flag vs outcome
- **Decision:** Proceed to live ONLY if: realized mean(f(x)) > +1.0%, cost error < 20%, max drawdown < 10%, no critical bugs

### 8.4 Live Trading — Gradual Ramp

- **Phase 1:** 10% of target position size for first 10 trades
- **Phase 2:** 50% for next 20 trades
- **Phase 3:** 100% after 30 successful trades with positive realized f(x)
- **Kill switch:** If live performance deviates from paper by >30% (worse), revert to paper and debug

---

## 9. KNOWN ISSUES & WATCH LIST

| ID | Issue | Status | Mitigation |
|---|---|---|---|
| OD-1 | No validated forward-predictive input | **Open** | Score is descriptive only. Paper results will test descriptive-prior hypothesis. |
| OD-2 | Low-liquidity un-winnable entries | Fixed | f(x) gate + liquidity floors + EFFECTIVE_MIN_LIQ logging [FIX D2] |
| OD-3 | Partial-TP at +3% may be inside cost spread | Fixed | Eligibility now uses exit-only cost [FIX D4] |
| OD-4 | Score not EV-validated | Watch | Score must inform f(x), never be the decision. Monthly correlation review. |
| OD-5 | Conviction double-counting | Fixed | captureMult only; conviction passed from gate to position_size [FIX D5] |
| OD-6 | captureMult > 1.0 | Fixed | Formula corrected [FIX D1] |
| OD-7 | OD-1 silent bypass | Fixed | Hypothesis declaration required before Phase E [Framework FIX-2] |
| OD-8 | ATH penalty unvalidated | Fixed | Removed; ATH logged for post-hoc analysis [FIX D3] |
| OD-9 | Social weight gap | Fixed | Weight renormalization when social unavailable [FIX D6] |
| OD-10 | Contract health insufficient gate | Fixed | Moved to hard G1b gate [FIX D9] |
| OD-11 | entry_price ambiguous | Fixed | Defined as actual fill price from Jupiter [FIX D7] |
| OD-12 | Sniper path dead code | Fixed | Implemented: 1s polling, max priority fee, immediate execution [FIX D8] |
| OD-13 | Solana network congestion | Ongoing | Pause entries if TPS < 500 or block time > 2s |
| OD-14 | Rug pull / contract exploit | Ongoing | G1b hard gate + blacklist + LP burn check + liquidity drop guard |

---

## 10. SUMMARY

```
1.  Ingest:    Filter universe (Solana, $50k–$5M MC, $1k+ liq, 24h+ age)
2.  Safety:    G1b hard gate — contract_health < 50 → blacklist, SKIP
3.  Score:     Compute descriptive score (0–100); renormalize weights if social unavailable
4.  Gate:      Pass G1–G4 (universe, contract, liquidity, score floor, sniper route)
5.  Decide:    f(x) = captureMult(score) * estimatedPeak(liq) - round_trip_cost(liq)
               captureMult capped at 1.0. Compute f(x) ONCE. Snapshot conviction.
6.  Enter:     If f(x) > 1.0%, enter with position_size(liq, conviction)
               Sniper path: 1s polling + max priority fee + immediate swap
7.  Monitor:   5s polling. Track price vs stop_price, trailing arm, partial TP
               All thresholds referenced to actual fill price.
8.  Exit:      stop (−5%), partial TP (+3%, 50%, exit-only cost check), trailing (+8%, 5% trail)
9.  Cooldown:  30-minute post-exit cooldown
10. Risk:      Halt if drawdown >10%, daily loss >5%, or liq drops >50%
11. Validate:  Paper trade 30+ trades under stated hypothesis, then live ramp 10%→50%→100%
```

This document is the system. The Convergence Framework v3 is the debugger. Both must be maintained together.
