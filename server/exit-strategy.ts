/**
 * exit-strategy.ts
 *
 * Pure, testable exit signal evaluator.
 * Implements: trailing stop, partial TP ladder, dead-cat detection,
 * hard stop loss, and age-based stop tightening.
 *
 * Design philosophy:
 *   - Sell SMALL pieces early (lock in gains) — keep moon bag for the 1000x
 *   - LEGENDARY tokens get more breathing room (stronger signal conviction)
 *   - Dead cats (new tokens that spike then crash) → exit immediately
 *   - Age-based tightening: stale positions get tighter stops to protect profits
 */

export type ExitTier = "LEGENDARY" | "HIGH" | "MEDIUM" | "SKIP";

export interface ExitSignalInput {
  entryPriceSol: number;
  currentPriceSol: number;
  peakPriceSol: number;
  ageSeconds: number;
  positionSol: number;
  tier: ExitTier;
  tpLevelReached: number; // 0 = no TP hit, 1 = 2x hit, 2 = 5x hit, 3 = 10x hit
}

export type ExitAction = "hold" | "partial" | "exit";

export interface ExitSignalDecision {
  action: ExitAction;
  reason: string;
  sellFraction: number; // 0.0 = hold all, 0.25 = sell 25%, 1.0 = full exit
}

// ─────────────────────────────────────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────────────────────────────────────

// Trailing stop pct from peak (higher = more breathing room)
// ALIGNED with exit-strategy test expectations:
//   HIGH = 25%: catches profit before full retrace
//   LEGENDARY = 35%: more breathing room for 1000x runners
//   OLD (>4h) = 15%: tighter for stale positions
const TRAILING_STOP_HIGH_PCT      = 25;  // HIGH/MEDIUM tier
const TRAILING_STOP_LEGENDARY_PCT = 35;  // LEGENDARY — 1000x runners get wider trailing
const TRAILING_STOP_OLD_PCT       = 15;  // All tiers, positions > 4 hours (tightened)

const OLD_POSITION_AGE_SECONDS = 4 * 3600; // 4 hours

// Hard stop loss below entry (protect capital on failed entries)
const HARD_STOP_LOSS_PCT = 30; // exit if price drops 30%+ below entry

// Dead cat: spike then crash for very new tokens (< 30 min)
const DEAD_CAT_MAX_AGE_SECONDS = 30 * 60;
const DEAD_CAT_DRAWDOWN_PCT    = 50; // 50%+ drop from peak = dead cat

// TP ladder: (multiplier, sell fraction)
// Design: sell 25% at each major milestone, keep 25% for the moonshot.
// Each TP locks profits while preserving a moon bag for 1000x+ runners.
const TP_LEVELS: Array<{ multiplier: number; fraction: number; label: string }> = [
  { multiplier: 2,  fraction: 0.25, label: "tp1_2x" },   // Sell 25% at 2x
  { multiplier: 5,  fraction: 0.25, label: "tp2_5x" },   // Sell 25% at 5x
  { multiplier: 10, fraction: 0.25, label: "tp3_10x" },  // Sell 25% at 10x
];

// ─────────────────────────────────────────────────────────────────────────────
// MAIN EVALUATOR
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Evaluates whether to hold, take partial profit, or exit a position.
 * Priority order:
 *   1. Hard stop loss (below entry)
 *   2. Dead cat (new token, massive drawdown from spike)
 *   3. Trailing stop (from peak)
 *   4. Partial TP ladder
 *   5. Hold (including moonshot bag after all TPs hit)
 */
export function evaluateExitSignal(input: ExitSignalInput): ExitSignalDecision {
  const {
    entryPriceSol,
    currentPriceSol,
    peakPriceSol,
    ageSeconds,
    tier,
    tpLevelReached,
  } = input;

  // Guard against zero/negative prices
  if (entryPriceSol <= 0 || currentPriceSol <= 0) {
    return { action: "hold", reason: "invalid_prices", sellFraction: 0 };
  }

  const multiplierFromEntry = currentPriceSol / entryPriceSol;
  const effectivePeak = Math.max(peakPriceSol, currentPriceSol);
  const drawdownFromPeakPct = effectivePeak > 0
    ? ((effectivePeak - currentPriceSol) / effectivePeak) * 100
    : 0;

  // ── 1. Hard Stop Loss ──────────────────────────────────────────────────────
  // If price is 30%+ below entry, cut losses immediately
  const dropFromEntryPct = ((entryPriceSol - currentPriceSol) / entryPriceSol) * 100;
  if (dropFromEntryPct >= HARD_STOP_LOSS_PCT) {
    return {
      action: "exit",
      reason: `stop_loss(${dropFromEntryPct.toFixed(1)}%_below_entry)`,
      sellFraction: 1.0,
    };
  }

  // ── 2. Dead Cat Detection ──────────────────────────────────────────────────
  // Very new token (< 30 min) that spiked and crashed 50%+ from peak
  if (ageSeconds < DEAD_CAT_MAX_AGE_SECONDS && drawdownFromPeakPct >= DEAD_CAT_DRAWDOWN_PCT) {
    return {
      action: "exit",
      reason: `dead_cat(${drawdownFromPeakPct.toFixed(1)}%_from_peak,age=${ageSeconds}s)`,
      sellFraction: 1.0,
    };
  }

  // ── 3. Trailing Stop ───────────────────────────────────────────────────────
  // Only applies once we've actually gained (peak > entry), or position >4h old
  const hasProfitedPeak = peakPriceSol > entryPriceSol * 1.05; // at least 5% above entry
  const isOldPosition   = ageSeconds >= OLD_POSITION_AGE_SECONDS;

  if (hasProfitedPeak || isOldPosition) {
    const trailingStopPct = isOldPosition
      ? TRAILING_STOP_OLD_PCT
      : (tier === "LEGENDARY" ? TRAILING_STOP_LEGENDARY_PCT : TRAILING_STOP_HIGH_PCT);

    if (drawdownFromPeakPct > trailingStopPct) {
      return {
        action: "exit",
        reason: `trailing_stop(${drawdownFromPeakPct.toFixed(1)}%>${trailingStopPct}%,tier=${tier})`,
        sellFraction: 1.0,
      };
    }
  }

  // ── 4. Partial TP Ladder ───────────────────────────────────────────────────
  for (let i = 0; i < TP_LEVELS.length; i++) {
    const tp = TP_LEVELS[i];
    if (tpLevelReached <= i && multiplierFromEntry >= tp.multiplier) {
      return {
        action: "partial",
        reason: `${tp.label}(${multiplierFromEntry.toFixed(2)}x)`,
        sellFraction: tp.fraction,
      };
    }
  }

  // ── 5. Hold (moonshot bag after all TPs, or still building) ───────────────
  if (tpLevelReached >= 3) {
    return {
      action: "hold",
      reason: `moonshot_hold(${multiplierFromEntry.toFixed(2)}x,all_tps_taken)`,
      sellFraction: 0,
    };
  }

  return {
    action: "hold",
    reason: `hold(${multiplierFromEntry.toFixed(2)}x_from_entry,peak=${(effectivePeak / entryPriceSol).toFixed(2)}x)`,
    sellFraction: 0,
  };
}
