/**
 * ml-score-gate.ts
 *
 * Pure gate function that uses the ML server's pump_probability to
 * adjust (or block) position sizing before any buy is executed.
 *
 * The ML server runs XGBoost + heuristic blending and returns a
 * pump_probability in [0, 1]. This gate translates that into:
 *   - BLOCK:  prob < 0.35 (0.30 for LEGENDARY) → do not trade
 *   - REDUCE: prob 0.35–0.54 → cut size by 50% (low conviction)
 *   - NORMAL: prob 0.55–0.70 → trade at candidate size
 *   - BOOST:  prob > 0.70 → increase size by 20%, capped at maxPositionSizeSol
 *
 * LEGENDARY tokens get a relaxed block threshold (0.30) because the
 * 5-layer goldScore provides strong conviction compensation.
 */

export type MlTier = "LEGENDARY" | "HIGH" | "MEDIUM" | "SKIP";

export interface MlScoreGateInput {
  pumpProbability: number;     // 0–1 from ML server
  goldScore: number;           // 0–100 from goldScore()
  tier: MlTier;
  candidateSizeSol: number;
  maxPositionSizeSol: number;
  isLive: boolean;
}

export interface MlScoreGateDecision {
  allowed: boolean;
  reason: string;
  adjustedSizeSol: number;
  confidenceMultiplier: number; // 0 = blocked, 0.5 = reduced, 1.0 = normal, 1.2 = boost
}

// ─────────────────────────────────────────────────────────────────────────────
// THRESHOLDS
// ─────────────────────────────────────────────────────────────────────────────

const BLOCK_THRESHOLD         = 0.35; // below → blocked
const LEGENDARY_BLOCK_THRESHOLD = 0.30; // relaxed for LEGENDARY tier
const REDUCE_THRESHOLD        = 0.55; // below → 50% reduction
const BOOST_THRESHOLD         = 0.70; // above → 20% boost
const BOOST_MULTIPLIER        = 1.2;
const REDUCE_MULTIPLIER       = 0.5;

// ─────────────────────────────────────────────────────────────────────────────
// GATE FUNCTION
// ─────────────────────────────────────────────────────────────────────────────

export function evaluateMlScoreGate(input: MlScoreGateInput): MlScoreGateDecision {
  const {
    pumpProbability: prob,
    tier,
    candidateSizeSol,
    maxPositionSizeSol,
  } = input;

  const probStr = prob.toFixed(2);
  const blockThreshold = tier === "LEGENDARY" ? LEGENDARY_BLOCK_THRESHOLD : BLOCK_THRESHOLD;

  // ── BLOCK ──────────────────────────────────────────────────────────────────
  if (prob < blockThreshold) {
    return {
      allowed: false,
      reason: `ml_block(prob=${probStr}<${blockThreshold},tier=${tier})`,
      adjustedSizeSol: 0,
      confidenceMultiplier: 0,
    };
  }

  // ── REDUCE ─────────────────────────────────────────────────────────────────
  if (prob < REDUCE_THRESHOLD) {
    const adjusted = Math.min(candidateSizeSol * REDUCE_MULTIPLIER, maxPositionSizeSol);
    return {
      allowed: true,
      reason: `ml_reduce(prob=${probStr},size_cut_50%)`,
      adjustedSizeSol: adjusted,
      confidenceMultiplier: REDUCE_MULTIPLIER,
    };
  }

  // ── BOOST ──────────────────────────────────────────────────────────────────
  if (prob > BOOST_THRESHOLD) {
    const boosted = Math.min(candidateSizeSol * BOOST_MULTIPLIER, maxPositionSizeSol);
    return {
      allowed: true,
      reason: `ml_boost(prob=${probStr},size+20%)`,
      adjustedSizeSol: boosted,
      confidenceMultiplier: BOOST_MULTIPLIER,
    };
  }

  // ── NORMAL ─────────────────────────────────────────────────────────────────
  const adjusted = Math.min(candidateSizeSol, maxPositionSizeSol);
  return {
    allowed: true,
    reason: `ml_normal(prob=${probStr})`,
    adjustedSizeSol: adjusted,
    confidenceMultiplier: 1.0,
  };
}
