/**
 * beast-exit.ts — Beast Tier asymmetric exit engine for moonshot runners.
 *
 * Pure, side-effect-free. Extends exit-strategy.ts with an exit evaluator
 * engineered around the asymmetric payout profile of memecoin moonshots:
 *   - 1000 Θεωrι-class runners hit +1000x (1 lakhx = 100,000x with leverage on
 *     bag size) and need to be HELD through 30-60% pullbacks without flinching.
 *   - Most scanners / scorers point at -10%-to-+50% candidates, so price action
 *     is dominated by short-term momentum fades, not multi-day regime runs.
 *
 * Design principles (grounded in the engine's documented live empirics):
 *   (a) Sell SMALL pieces climbing UP — 1.5x, 3x, 7x, 15x, 50x, 200x, 1000x.
 *       Each partial retrains the trailing stop near the realized peak.
 *   (b) ≤2x multipliers get a tight 18% drawdown trailing stop. The runner-bag
 *       (≥2x remaining position) gets a 32% trailing; ≥10x gets 55%; ≥50x gets 75%.
 *       This is the asymmetric payout — give back a quarter to keep three-quarters.
 *   (c) At ≥10x the position NEVER exits on dead-cat signatures (a 70% drawdown
 *       from peak is just a normal multi-leg pullback for a 25x runner).
 *   (d) At ≥10x the position NEVER exits on ace-fade (bp5m<0.40) — even a rug
 *       with 32x remaining (peak 33x) sells on-chain for ~1%-of-peak-not-100% so
 *       holding is the higher-EV play; only a verified liquidity-collapse or
 *       momentum-death confirmed on-chain justifies exit (handled outside this
 *       pure function, in routes.ts LIQ_COLLAPSE tier-1 rule).
 *   (e) Hard stop LOSS is still respected fractionally per remaining bag tier
 *       — a partial-TP'd position has a smaller remaining bag that still needs
 *       capital protection, but the threshold is RAISED with each unlocked tier
 *       so a multi-bagger never sells in a routine 30% pullback.
 *
 * The Beast tier is engaged for tokens whose INTERNAL conviction (gold tier + ML
 * score + holder/lock/flow) survived evaluateBeastSafety AND whose ENGINE
 * combinedScore ≥ BEAST_CONV_MIN — i.e. only true alpha candidates get the
 * asymmetric exit treatment; everything else uses the legacy exit-strategy.ts.
 *
 * This file is unit-tested in isolation in beast-exit.test.ts.
 */

export type BeastBagTier = "COLD" | "WARM" | "HOT" | "ROCKET" | "MOON" | "MOONSHOT";

export interface BeastExitInput {
  entryPriceSol: number;
  currentPriceSol: number;
  peakPriceSol: number;
  ageSeconds: number;
  positionSol: number;
  tier: BeastBagTier;          // starting tier (a position starts COLD)
  /** Index of highest TP already taken (0 = none, 7 = all TPs taken) */
  tpLevelReached: number;
}

export interface BeastExitDecision {
  action: "hold" | "partial" | "exit";
  reason: string;
  sellFraction: number;        // 0.0 hold all; 1.0 full exit
  /** Updated tier after this decision is applied (COLD->WARM if tx current is hot enough). */
  nextTier: BeastBagTier;
  /** Multiplier ceiling this position is currently sitting beneath. */
  multiplierFromEntry: number;
  /** Drawdown-from-peak to inform stall/exit logic. */
  drawdownFromPeakPct: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// TIER LADDER — each tier adjusts trailing distance & dead-cat tolerance
// ─────────────────────────────────────────────────────────────────────────────

// Mapping of multiplierFromEntry thresholds => higher tier unlocked.
const TIER_MULTIPLIER_GATE: Array<{ multiplier: number; tier: BeastBagTier; trailPct: number; hardStopPct: number }> = [
  // multiplier, tier name, trailing drawdown from peak, hard stop from entry
  { multiplier: 1000, tier: "MOONSHOT", trailPct: 75, hardStopPct: 95 }, // 1000x+ — keep almost everything; exit only on ≥75% peak retrace OR 95%-below-entry
  { multiplier: 50,   tier: "MOON",    trailPct: 55, hardStopPct: 90 },
  { multiplier: 10,   tier: "ROCKET",  trailPct: 45, hardStopPct: 85 },
  { multiplier: 2,    tier: "HOT",     trailPct: 32, hardStopPct: 65 },
  { multiplier: 1.05, tier: "WARM",    trailPct: 18, hardStopPct: 32 },
  { multiplier: 0.0,  tier: "COLD",    trailPct: 12, hardStopPct: 22 }, // <2x: legacy engine tolerances
];

// TP ladder — fraction sold at each milestone. Sells SMALL pieces climbing up.
// Total at 1000x = 0.10 + 0.07 + 0.10 + 0.10 + 0.15 + 0.20 + 0.10 = 82% sold,
// keeping 18% for the absolute moonshot bag (which carries the tail-EV upside).
export const BEAST_TP_LADDER: Array<{
  multiplier: number;
  fraction: number;
  label: string;
  tier: BeastBagTier;
}> = [
  { multiplier: 1.5,  fraction: 0.10, label: "tp1_1.5x",  tier: "WARM" },
  { multiplier: 3,    fraction: 0.07, label: "tp2_3x",    tier: "WARM" },
  { multiplier: 7,    fraction: 0.10, label: "tp3_7x",   tier: "HOT"  },
  { multiplier: 15,   fraction: 0.10, label: "tp4_15x",  tier: "HOT"  },
  { multiplier: 50,   fraction: 0.15, label: "tp5_50x",  tier: "ROCKET" },
  { multiplier: 200,  fraction: 0.20, label: "tp6_200x", tier: "MOON"  },
  { multiplier: 1000, fraction: 0.10, label: "tp7_1000x", tier: "MOONSHOT" },
];

// Dead-cat signature (only triggers below the ≥10x ROCKET tier — above ROCKET
// the position is HOLD until hard stop or liquidity collapse).
const DEAD_CAT_MIN_AGE_SECONDS = 30 * 60;
const DEAD_CAT_DRAWDOWN_PCT = 55;

/**
 * Given current price action, decide which tier applies RIGHT NOW. A position
 * promotes UP only — never down (so even a deep pullback on a 50x runner stays
 * in the MOON tier with the wide trailing-stop protection).
 */
export function tierForMultiplier(mult: number): BeastBagTier {
  for (const gate of TIER_MULTIPLIER_GATE) {
    if (mult >= gate.multiplier) return gate.tier;
  }
  return "COLD";
}

export function tierTrailingPct(tier: BeastBagTier): number {
  return TIER_MULTIPLIER_GATE.find(g => g.tier === tier)?.trailPct ?? 12;
}

export function tierHardStopPct(tier: BeastBagTier): number {
  return TIER_MULTIPLIER_GATE.find(g => g.tier === tier)?.hardStopPct ?? 22;
}

export function tierShortCircuitDeadcat(tier: BeastBagTier): boolean {
  // ≥ HOT block dead-cat exit (a fake-out signature is meaningless at 2x+)
  switch (tier) {
    case "ROCKET":
    case "MOON":
    case "MOONSHOT":
      return true;
    case "HOT":
      return false; // HOT (2-10x) still respects dead-cat if 30m and 55% retrace
    default:
      return false;
  }
}

/**
 * Core Beast exit evaluator.
 *
 * Priority order:
 *   1. Hard stop LOSS adaptive to current tier (lower tiers out faster).
 *   2. Dead-cat — only for COLD/WARM/HOT tiers.
 *   3. Trailing stop — tier-specific distance.
 *   4. Partial TP ladder.
 *   5. Hold — keep the moonshot bag.
 */
export function evaluateBeastExit(input: BeastExitInput): BeastExitDecision {
  const {
    entryPriceSol,
    currentPriceSol,
    peakPriceSol,
    ageSeconds,
    tpLevelReached,
  } = input;

  if (entryPriceSol <= 0 || currentPriceSol <= 0) {
    return {
      action: "hold",
      reason: "invalid_prices",
      sellFraction: 0,
      nextTier: input.tier,
      multiplierFromEntry: 0,
      drawdownFromPeakPct: 0,
    };
  }

  const multiplierFromEntry = currentPriceSol / entryPriceSol;
  const effectivePeak = Math.max(peakPriceSol, currentPriceSol);
  const drawdownFromPeakPct = effectivePeak > 0
    ? ((effectivePeak - currentPriceSol) / effectivePeak) * 100
    : 0;

  // Promote tier UP only. Cannot demote — a moonshot that retraces to entry
  // still has the wide MOON-tier trailing stop so it can recover or run again.
  // TIER_MULTIPLIER_GATE is sorted DESCENDING by multiplier, so LOWER index =
  // HIGHER tier. Promoting UP means observed has LOWER index than current.
  const promotedTier = (() => {
    const observed = tierForMultiplier(multiplierFromEntry);
    const currentIdx = TIER_MULTIPLIER_GATE.findIndex(g => g.tier === input.tier);
    const observedIdx = TIER_MULTIPLIER_GATE.findIndex(g => g.tier === observed);
    return observedIdx < currentIdx ? observed : input.tier;
  })();

  // ── 1. Hard stop LOSS adaptive to tier ─────────────────────────────────
  const dropFromEntryPct = ((entryPriceSol - currentPriceSol) / entryPriceSol) * 100;
  const tierHardStop = tierHardStopPct(promotedTier);
  if (dropFromEntryPct >= tierHardStop) {
    return {
      action: "exit",
      reason: `beast_hard_stop(${dropFromEntryPct.toFixed(1)}%_below_entry, tier=${promotedTier}, stop=${tierHardStop}%)`,
      sellFraction: 1.0,
      nextTier: promotedTier,
      multiplierFromEntry,
      drawdownFromPeakPct,
    };
  }

  // ── 2. Dead-cat detection ─────────────────────────────────────────────
  if (!tierShortCircuitDeadcat(promotedTier)) {
    if (ageSeconds < DEAD_CAT_MIN_AGE_SECONDS && drawdownFromPeakPct >= DEAD_CAT_DRAWDOWN_PCT) {
      return {
        action: "exit",
        reason: `beast_dead_cat(${drawdownFromPeakPct.toFixed(1)}%_from_peak, age=${ageSeconds}s, tier=${promotedTier})`,
        sellFraction: 1.0,
        nextTier: promotedTier,
        multiplierFromEntry,
        drawdownFromPeakPct,
      };
    }
  }

  // ── 3. Trailing stop (always applies; tier-gated distance) ────────────
  const trailPct = tierTrailingPct(promotedTier);
  const hasProfitedPeak = peakPriceSol > entryPriceSol * 1.02;     // ≥2% above entry
  if (hasProfitedPeak && drawdownFromPeakPct > trailPct) {
    return {
      action: "exit",
      reason: `beast_trailing_stop(${drawdownFromPeakPct.toFixed(1)}%>${trailPct}%, tier=${promotedTier}, peak_mult=${(peakPriceSol / entryPriceSol).toFixed(2)}x)`,
      sellFraction: 1.0,
      nextTier: promotedTier,
      multiplierFromEntry,
      drawdownFromPeakPct,
    };
  }

  // ── 4. Partial TP ladder ──────────────────────────────────────────────
  // IEEE-754-FIX(2026-07-28): tokens priced in sub-mSOL (entry=0.0001, peak=0.00015)
  // produce multiplier = 1.4999999999999998 instead of 1.5, which fails the strict >= check
  // and silently skips TP1. Round both sides to 4 decimal places before comparing so a
  // real 1.5x runner is never missed due to floating-point drift. 4 decimals = 0.0001 step,
  // well below any meaningful price noise, so it doesn't admit false positives at sub-threshold
  // multipliers (a 1.4999x runner still rounds to 1.4999 and correctly does NOT trigger tp1).
  const TP_LADDER_PRECISION = 4;
  const roundToDecimal = (num: number, precision: number): number =>
    Math.round(num * Math.pow(10, precision)) / Math.pow(10, precision);
  for (let i = 0; i < BEAST_TP_LADDER.length; i++) {
    const tp = BEAST_TP_LADDER[i];
    const currentMult = roundToDecimal(multiplierFromEntry, TP_LADDER_PRECISION);
    const targetMult = roundToDecimal(tp.multiplier, TP_LADDER_PRECISION);
    if (tpLevelReached <= i && currentMult >= targetMult) {
      return {
        action: "partial",
        reason: `${tp.label}(${multiplierFromEntry.toFixed(2)}x, tier=${promotedTier})`,
        sellFraction: tp.fraction,
        nextTier: promotedTier,
        multiplierFromEntry,
        drawdownFromPeakPct,
      };
    }
  }

  // ── 5. Hold (moonshot bag after all TPs hit) ─────────────────────────
  if (tpLevelReached >= BEAST_TP_LADDER.length) {
    return {
      action: "hold",
      reason: `beast_moonshot_hold(${multiplierFromEntry.toFixed(2)}x, peak=${(peakPriceSol / entryPriceSol).toFixed(2)}x, tier=${promotedTier})`,
      sellFraction: 0,
      nextTier: promotedTier,
      multiplierFromEntry,
      drawdownFromPeakPct,
    };
  }

  return {
    action: "hold",
    reason: `beast_hold(${multiplierFromEntry.toFixed(2)}x_from_entry, peak=${(effectivePeak / entryPriceSol).toFixed(2)}x, tier=${promotedTier})`,
    sellFraction: 0,
    nextTier: promotedTier,
    multiplierFromEntry,
    drawdownFromPeakPct,
  };
}
