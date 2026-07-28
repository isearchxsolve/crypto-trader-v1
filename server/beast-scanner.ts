/**
 * beast-scanner.ts — Beast Tier discovery pre-valuator.
 *
 * Pure, side-effect-free. Supersedes the permissive scoring in
 * fast_scanner.cjs's scoreCandidate() for tokens destined for the
 * Beast tier of the engine. The legacy scanner writes ALL discovery
 * candidates to candidates.csv; routes.ts re-evaluates them with this
 * module along-side the legacy scoreToken() so the engine only admits
 * the moonshot-quality subset THROUGH the Beast pipeline.
 *
 * Inputs: the same metrics DexScreener + RugCheck + RPC give us at
 * discovery time, normalized to plain numbers.
 *
 * Output: a Beast Discovery Score (0-100) AND a Beast Discovery Verdict
 * (PASS/VETO) — PASSES make it into the Beast pipeline with their Beast
 * score; VETOES are silently dropped from the Beast tier (they may still
 * be admitted via the legacy pipeline if their engineSettings score holds).
 *
 * Surfaces scored (each contributes to Beasteast; many already in engine):
 *   S1 — Graduation liquidity            ($15k+ rich scoring)
 *   S2 — Genuine two-way flow             (≥3 buys & ≥3 sells, balanced)
 *   S3 — Organic price development        (|px5m| < 80% — no parabolics)
 *   S4 — Holder dispersion                (top-1 non-LP < 5%, top-5 < 20%)
 *   S5 — Verified LP lock                 (≥80% locked)
 *   S6 — Recent-onchain developer trust   (creator has ≥1 prior active token)
 *   S7 — Whale accumulation witness        (whaleNetBuyers > 0)
 *   S8 — Smart-money cluster              (≥3 smart wallets net-acquired)
 *   S9 — Anti-wash bundle                 (no balanced churn on flat px)
 *   S10 — Raise-the-floor vol/liq          (0.3 ≤ vol5m/liq ≤ 6 — sweet spot)
 *
 * The total score rewards BREADTH of signals — a token must satisfy
 * AT LEAST 6 surfaces AND have total ≥ 50 to be a Beast PASS.
 */

// ─────────────────────────────────────────────────────────────────────────────
// TYPES
// ─────────────────────────────────────────────────────────────────────────────

export interface BeastDiscoveryInput {
  liquidityUsd: number;
  ageSeconds: number;
  buys5m: number;
  sells5m: number;
  volume5mUsd: number;
  volume24hUsd: number;
  priceChange5mPct: number;
  priceChange1hPct: number;
  smartWalletsNetBuyers: number;
  whaleNetBuyers: number;
  nonLpTop1Pct?: number;
  nonLpTop5Pct?: number;
  lpLockedPct?: number;
  creatorPriorActiveCount: number;
}

export interface BeastDiscoveryResult {
  verdict: "PASS" | "VETO";
  reason: string;
  score: number;            // 0-100
  tier: "LEGENDARY" | "HIGH" | "MEDIUM" | "SKIP";
  surfacesPassed: number;
  surfacesChecked: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// PER-SURFACE SCORING — each surface returns points 0..maxForSurface
// ─────────────────────────────────────────────────────────────────────────────

function scoreLiquidity(liq: number): number {
  if (liq >= 50_000) return 12;
  if (liq >= 25_000) return 9;
  if (liq >= 15_000) return 6;
  if (liq >= 8_000) return 3;
  if (liq >= 3_000) return 1;
  return 0;             // beast tier demands ≥3k liq for ANY signal
}

function scoreTwoWayFlow(buys: number, sells: number): number {
  const total = buys + sells;
  if (total === 0) return 0;
  if (buys < 3 || sells < 3) return 0;                       // beast demands a real market
  const balance = Math.min(buys, sells) / Math.max(buys, sells);
  if (balance < 0.20) return 2;                              // too lopsided
  if (balance < 0.45) return 5;
  if (balance < 0.75) return 9;                              // near-balanced
  return 12;                                                  // balanced
}

function scorePriceDevelopment(px5m: number): number {
  const abs = Math.abs(px5m);
  // 0-3: dead / flat.   3-15: organic momentum.   15-25: strong.
  // 25-50: extended.    50-80: parabolic — danger.    >80: reject.
  if (abs > 80) return 0;
  if (abs > 50) return 2;
  if (abs > 25) return 6;
  if (abs > 15) return 9;
  if (abs > 3) return 12;
  return 4;
}

function scoreHolderDispersion(nonLpTop1?: number, nonLpTop5?: number): number {
  if (typeof nonLpTop1 !== "number" || typeof nonLpTop5 !== "number") return 6; // unknown — modest credit
  if (nonLpTop1 > 5 || nonLpTop5 > 25) return 0;            // concentration dominate
  if (nonLpTop1 > 3 || nonLpTop5 > 18) return 4;
  return 10;
}

function scoreLpLock(lpLockedPct?: number): number {
  if (typeof lpLockedPct !== "number") return 4;            // unknown — small credit
  if (lpLockedPct >= 95) return 12;
  if (lpLockedPct >= 80) return 10;
  if (lpLockedPct >= 50) return 6;
  if (lpLockedPct >= 20) return 2;
  return 0;                                                  // no lock = no Beast credit
}

function scoreCreatorTrust(priorActive: number): number {
  if (priorActive >= 3) return 12;
  if (priorActive === 2) return 9;
  if (priorActive === 1) return 6;
  return 2;                                                  // first token — small credit only
}

function scoreWhaleActivity(whaleNetBuyers: number, smartNet: number): number {
  const whaleBonus = whaleNetBuyers > 0 ? Math.min(8, whaleNetBuyers * 2) : 0;
  const smartBonus = smartNet > 0 ? Math.min(8, smartNet * 2) : 0;
  return whaleBonus + smartBonus;                          // up to 16
}

function scoreWashGuard(volume5mUsd: number, liquidityUsd: number, px5m: number, totalTx: number): { credit: number; vetoed: boolean } {
  if (liquidityUsd <= 0) return { credit: 0, vetoed: false };
  const ratio = volume5mUsd / liquidityUsd;
  if (ratio > 6 && Math.abs(px5m) <= 3 && totalTx >= 20) {
    // balanced-wash bundle signature
    return { credit: 0, vetoed: true };
  }
  // Sweet spot vol/liq: 0.3 ≤ ratio ≤ 6 = healthy turnover
  if (ratio < 0.3) return { credit: 3, vetoed: false };     // under-actively traded
  if (ratio <= 6) return { credit: 10, vetoed: false };
  return { credit: 5, vetoed: false };
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN EVALUATOR
// ─────────────────────────────────────────────────────────────────────────────

export function evaluateBeastDiscovery(input: BeastDiscoveryInput): BeastDiscoveryResult {
  // Hard floor — Beast tier requires $3k+ liquidity to be admissible at all.
  // Below this, no set of other signals can overcome the modeled round-trip cost.
  if (input.liquidityUsd < 3_000) {
    return {
      verdict: "VETO",
      reason: `beast_discovery_veto_liquidity_below_floor($${input.liquidityUsd.toFixed(0)}<$3000)`,
      score: 0,
      tier: "SKIP",
      surfacesPassed: 0,
      surfacesChecked: 0,
    };
  }
  // Zero-sell honeypot hard veto. A true two-sided market needs ≥3 sells;
  // the beast-safety gate re-checks but the scanner should refuse to score.
  if (input.buys5m < 3 || input.sells5m < 3) {
    return {
      verdict: "VETO",
      reason: `beast_discovery_veto_one_way_market(buys=${input.buys5m},sells=${input.sells5m})`,
      score: 0,
      tier: "SKIP",
      surfacesPassed: 0,
      surfacesChecked: 0,
    };
  }
  const surfaces: Array<{ name: string; ok: boolean; passed: number }> = [];

  // S1
  const s1 = scoreLiquidity(input.liquidityUsd);
  surfaces.push({ name: "liquidity",    ok: s1 > 0, passed: s1 });

  // S2 (total5m for wash guard)
  const totalTx = input.buys5m + input.sells5m;
  const s2 = scoreTwoWayFlow(input.buys5m, input.sells5m);
  surfaces.push({ name: "two_way_flow", ok: s2 > 0, passed: s2 });

  // S3
  const s3 = scorePriceDevelopment(input.priceChange5mPct);
  surfaces.push({ name: "price_dev",    ok: s3 > 0, passed: s3 });

  // S4
  const s4 = scoreHolderDispersion(input.nonLpTop1Pct, input.nonLpTop5Pct);
  surfaces.push({ name: "dispersion",    ok: s4 > 0, passed: s4 });

  // S5
  const s5 = scoreLpLock(input.lpLockedPct);
  surfaces.push({ name: "lp_lock",       ok: s5 > 0, passed: s5 });

  // S6
  const s6 = scoreCreatorTrust(input.creatorPriorActiveCount);
  surfaces.push({ name: "creator_trust", ok: s6 > 0, passed: s6 });

  // S7 + S8
  const s7 = scoreWhaleActivity(input.whaleNetBuyers, input.smartWalletsNetBuyers);
  surfaces.push({ name: "whale_smart",   ok: s7 > 0, passed: s7 });

  // S9 (anti-wash)
  const s9 = scoreWashGuard(input.volume5mUsd, input.liquidityUsd, input.priceChange5mPct, totalTx);
  surfaces.push({ name: "anti_wash",     ok: s9.credit > 0, passed: s9.credit });
  if (s9.vetoed) {
    return {
      verdict: "VETO",
      reason: "beast_discovery_veto_wash_bundle",
      score: 0,
      tier: "SKIP",
      surfacesPassed: 0,
      surfacesChecked: surfaces.length,
    };
  }

  // S10 — raise-the-floor vol/liq (extra sweet-spot credit beyond S9)
  let s10 = 0;
  if (input.liquidityUsd > 0) {
    const ratio = input.volume5mUsd / input.liquidityUsd;
    if (ratio >= 0.3 && ratio <= 6) s10 = 4;
  }
  surfaces.push({ name: "vol_liq_sweet", ok: s10 > 0, passed: s10 });

  const surfacesPassed = surfaces.filter(s => s.ok).length;
  const surfacesChecked = surfaces.length;
  const score = Math.min(100, surfaces.reduce((s, x) => s + x.passed, 0));

  // Hard concentration veto. Beyond the graded scoring, a concentrated supply
  // is a structural rug waiting on the right price — the Beast tier hard-refuses
  // even candidates that would otherwise score ≥50. Thresholds aligned with
  // beast-safety: top1≥10% or top5≥30% or lp-locked<25% => structural rug risk.
  if ((typeof input.nonLpTop1Pct === "number" && input.nonLpTop1Pct >= 10) ||
      (typeof input.nonLpTop5Pct === "number" && input.nonLpTop5Pct >= 30) ||
      (typeof input.lpLockedPct   === "number" && input.lpLockedPct   <  25)) {
    return {
      verdict: "VETO",
      reason: `beast_discovery_veto_structural_concentration(top1=${input.nonLpTop1Pct ?? "n/a"},top5=${input.nonLpTop5Pct ?? "n/a"},lpLocked=${input.lpLockedPct ?? "n/a"})`,
      score: 0,
      tier: "SKIP",
      surfacesPassed,
      surfacesChecked,
    };
  }

  // 1h trend cooldown — if 5m is hot but 1h is deeply red, the move already ended
  if (input.priceChange1hPct < -10 && input.priceChange5mPct > 10) {
    return {
      verdict: "VETO",
      reason: "beast_discovery_veto_dead_cat_bounce(5m up vs 1h down)",
      score: 0,
      tier: "SKIP",
      surfacesPassed,
      surfacesChecked,
    };
  }

  // Parabolic-blowoff guard — a ≥80% 5m move is already-extended entry. The Beast
  // tier hunts genuine moonshots early enough to ride, not late-comers chasing
  // blowoff tops. Veto anything extreme: |px5m| > 80% (down = obvious dump, up = chase).
  if (Math.abs(input.priceChange5mPct) > 80) {
    return {
      verdict: "VETO",
      reason: `beast_discovery_veto_parabolic(px5m=${input.priceChange5mPct.toFixed(0)}%|>80%)`,
      score,
      tier: "SKIP",
      surfacesPassed,
      surfacesChecked,
    };
  }

  // Beast demands ≥6 of 9 surfaces checked AND score ≥ 50 to PASS to Beast tier.
  // Only tokens passing BEAST won't be tested by legacy pipeline gates except
  // the legs after Beast passes; legacy continues for safety posture.
  if (surfacesPassed < 6 || score < 50) {
    return {
      verdict: "VETO",
      reason: `beast_discovery_veto_insufficient(surfaces=${surfacesPassed}/${surfacesChecked}, score=${score}<50)`,
      score,
      tier: "SKIP",
      surfacesPassed,
      surfacesChecked,
    };
  }

  // Tier classification on Beast score:
  //   ≥85: LEGENDARY — moonshot candidate, asymmetric exit engine engaged
  //   ≥70: HIGH       — strong Beast entry, classic trailing engine
  //   ≥50: MEDIUM     — admissible but standard exit engine
  let tier: BeastDiscoveryResult["tier"] = "MEDIUM";
  if (score >= 85) tier = "LEGENDARY";
  else if (score >= 70) tier = "HIGH";

  // LEGENDARY requires strong whale+smart overlay (s7 ≥ 8) to ensure the
  // asymmetric exit engine is the right call — dragons without whales are
  // statistical false positives on a moonshot market.
  if (tier === "LEGENDARY" && s7 < 8) {
    tier = score >= 80 ? "HIGH" : "MEDIUM";
  }

  return {
    verdict: "PASS",
    reason: `beast_discovery_pass(surfaces=${surfacesPassed}/${surfacesChecked}, tier=${tier})`,
    score,
    tier,
    surfacesPassed,
    surfacesChecked,
  };
}
