/**
 * composite-scorer.ts — Beast Tier composite fusion scorer.
 *
 * Blends gold-score + ML-score + Beast discovery score into a single admission
 * score with tier and mode qualification. Pure, side-effect-free, unit-testable.
 *
 * Fusion weights (DEFAULT_WEIGHTS):
 *   gold 0.35 | ml 0.30 | beast 0.25 | confirmation 0.10
 *
 * Confirmation sub-score (raw sum, max 50 before the 0.10 weight):
 *   bp5m   (buy-pressure ratio, clamped 0..1) ×20  → max 20
 *   pc5m   (5m price change %, clamped 0..5)  ×4   → max 20
 *   volMom (volume momentum, clamped 0..2)    ×5   → max 10
 *
 * Tier ladder (scoreTier): LEGENDARY ≥75, HIGH ≥50, MEDIUM ≥35, else SKIP.
 * The fused tier is capped by the discovery (gold) tier so weak discovery can
 * never be promoted by ML/beast agreement alone. A beast VETO forces tier VETO.
 *
 * Mode qualification (modeQualify) cascades SNIPER → EDGE → EXPLOSIVE and runs
 * against the discovery (gold) tier so a LEGENDARY discovery with a fused score
 * just under the next tier boundary still earns its sniper slot:
 *   SNIPER:    LEGENDARY, score ≥70, bp5m ≥0.6, pc5m ≥2, volMom ≥1.5
 *   EDGE:      LEGENDARY|HIGH, score ≥60, bp5m ≥0.6, pc5m ≥2, volMom ≥1.5
 *   EXPLOSIVE: non-SKIP, score ≥45, bp5m ≥0.8, pc5m ≥8, volMom ≥4
 */

export type GoldTier = 'LEGENDARY' | 'HIGH' | 'MEDIUM' | 'SKIP';
export type ScoreTier = GoldTier | 'VETO';
export type BeastVerdict = 'PASS' | 'VETO';
export type TradeMode = 'SNIPER' | 'EDGE' | 'EXPLOSIVE';

export interface CompositeInput {
  goldScore: number;
  goldTier: GoldTier;
  mlScore: number;
  beastScore: number;
  beastVerdict: BeastVerdict;
  /** Buy-pressure ratio over 5m (0..1) */
  bp5m?: number;
  /** 5m price change in percent */
  pc5m?: number;
  /** Volume momentum multiple */
  volMom?: number;
  holderCount?: number;
  liquidityUsd?: number;
  marketCap?: number;
  ageHours?: number;
}

export interface CompositeResult {
  combinedScore: number;
  breakdown: {
    gold: number;
    ml: number;
    beast: number;
    confirmation: number;
  };
  tier: ScoreTier;
  mode: TradeMode | null;
}

export const DEFAULT_WEIGHTS = {
  gold: 0.35,
  ml: 0.30,
  beast: 0.25,
  confirmation: 0.10,
} as const;

const TIER_ORDER: Record<GoldTier, number> = {
  SKIP: 0,
  MEDIUM: 1,
  HIGH: 2,
  LEGENDARY: 3,
};

const ORDER_TIER: GoldTier[] = ['SKIP', 'MEDIUM', 'HIGH', 'LEGENDARY'];

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Map a score to the tier ladder: LEGENDARY ≥75, HIGH ≥50, MEDIUM ≥35, else SKIP. */
export function scoreTier(score: number): GoldTier {
  if (score >= 75) return 'LEGENDARY';
  if (score >= 50) return 'HIGH';
  if (score >= 35) return 'MEDIUM';
  return 'SKIP';
}

/** Raw confirmation sub-score (max 50) from 5m buy-pressure / price-change / volume-momentum. */
export function confirmationScore(bp5m = 0, pc5m = 0, volMom = 0): number {
  const bpPart = clamp(bp5m, 0, 1) * 20;
  const pcPart = clamp(pc5m, 0, 5) * 4;
  const volPart = clamp(volMom, 0, 2) * 5;
  return bpPart + pcPart + volPart;
}

/**
 * Qualify a trade mode from discovery tier + fused score + 5m confirmations.
 * Cascades SNIPER → EDGE → EXPLOSIVE; returns null when nothing qualifies.
 */
export function modeQualify(
  tier: GoldTier,
  combinedScore: number,
  bp5m = 0,
  pc5m = 0,
  volMom = 0
): TradeMode | null {
  const steadyConfirm = bp5m >= 0.6 && pc5m >= 2 && volMom >= 1.5;

  if (tier === 'LEGENDARY' && combinedScore >= 70 && steadyConfirm) {
    return 'SNIPER';
  }
  if ((tier === 'LEGENDARY' || tier === 'HIGH') && combinedScore >= 60 && steadyConfirm) {
    return 'EDGE';
  }
  if (tier !== 'SKIP' && combinedScore >= 45 && bp5m >= 0.8 && pc5m >= 8 && volMom >= 4) {
    return 'EXPLOSIVE';
  }
  return null;
}

/**
 * Fuse gold + ML + Beast + confirmation signals into a single admission score.
 * A beast VETO forces tier VETO and mode null regardless of the fused score.
 */
export function compositeScore(input: CompositeInput): CompositeResult {
  const gold = clamp(input.goldScore, 0, 100) * DEFAULT_WEIGHTS.gold;
  const ml = clamp(input.mlScore, 0, 100) * DEFAULT_WEIGHTS.ml;
  const beast = clamp(input.beastScore, 0, 100) * DEFAULT_WEIGHTS.beast;
  const confirmation = confirmationScore(input.bp5m, input.pc5m, input.volMom) * DEFAULT_WEIGHTS.confirmation;

  const combinedScore = clamp(gold + ml + beast + confirmation, 0, 100);

  if (input.beastVerdict === 'VETO') {
    return {
      combinedScore,
      breakdown: { gold, ml, beast, confirmation },
      tier: 'VETO',
      mode: null,
    };
  }

  // Fused tier is capped by the discovery (gold) tier.
  const fusedRank = Math.min(TIER_ORDER[scoreTier(combinedScore)], TIER_ORDER[input.goldTier]);
  const tier = ORDER_TIER[fusedRank];

  // Mode qualification runs on the discovery tier (see header rationale).
  const mode = modeQualify(input.goldTier, combinedScore, input.bp5m, input.pc5m, input.volMom);

  return {
    combinedScore,
    breakdown: { gold, ml, beast, confirmation },
    tier,
    mode,
  };
}
