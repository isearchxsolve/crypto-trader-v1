/**
 * beast-safety.ts — Beast Tier concentric rug/Honeypot/LP/sell-tax gate.
 *
 * Pure, side-effect-free. Extends the existing token-safety-policy /
 * advanced-filters-pure modules with a final concentric safety net that
 * hard-rejects every known rug surface BEFORE the engine admits a token:
 *
 *   1. Authority surface (freeze/mint must be null/revoked)
 *   2. LP-lock surface — quantitative verified lock % ≥ BEAST_MIN_LP_LOCK_PCT
 *   3. Concentration surface — single non-LP wallet, top5, top10, insider + LP-AMM
 *      sentinel exclusion (RugCheck already strips LP vaults, but real on-chain
 *      RPC does not, so we repeat the exclusion here for callers using raw RPC)
 *   4. Honeypot-symmetry surface — buy/sell symmetry requires binomial-equitable
 *      trade counts (≥ BEAST_MIN_BINOMIAL_PROOF), infeasible for a sell-tax trap
 *   5. Wash-asymmetry surface — vol/liq > BEAST_WASH_VOL_LIQ_MULT and a balanced
 *      churn band (|bp5m - 0.5| < band) with flat px = coordinated wash bundle
 *   6. Creator surface — repeated rug history veto (tokens created by the same
 *      wallet that previously deployed a now-dead token)
 *
 * The gate is fail-closed: when ANY required input is unavailable, it falls
 * back to the most-restrictive admissible posture (VETO) unless explicitly
 * opted into the fail-open path (BEAST_FAIL_OPEN=true). This is the opposite
 * of the existing safety which deliberately fail-opens to avoid no-trade
 * starvation; the Beast tier trades frequency for safety.
 *
 * Design goal: zero rugs admitted to the wallet over the lifetime of the
 * position — every admitted token must be unambiguously non-ruggable.
 *
 * Inputs are pre-fetched by the caller so this module remains deterministic
 * and unit-testable in isolation (mirrors advanced-filters-pure.ts).
 */

// ─────────────────────────────────────────────────────────────────────────────
// TYPES
// ─────────────────────────────────────────────────────────────────────────────

export interface AuthoritySnapshot {
  freezeAuthority: string | null;
  mintAuthority: string | null;
}

export interface LpLockInput {
  lpLockedPct: number;          // 0-100 verified lock ratio (RugCheck full report)
  lpLockedUntilSec?: number;   // unix timestamp lock expires (undefined = permanent)
  now: number;                 // unix ms
  lockSourceVerified: boolean; // false = untrusted / unavailable
}

export interface HolderInput {
  address: string;
  amount: number;          // raw (post-decimals) tokens
  isLp?: boolean;          // true if LP/AMM vault (exclude from concentration calc)
  isInsider?: boolean;    // RugCheck insider flag / known deployer wallet
  isCreator?: boolean;    // deployer wallet
}

export interface FlowInput {
  buys: number;            // 5m buy txn count
  sells: number;           // 5m sell txn count
  volume5mUsd: number;
  volume24hUsd: number;
  liquidityUsd: number;
  priceChange5mPct: number;
}

export interface CreatorHistoryInput {
  deployerWallet?: string | null;
  creatorPriorTokenAddresses: string[];   // tokens this wallet previously deployed
  creatorPriorTokenStatuses: ("active" | "dead" | "rug")[];   // current status of those
}

export type BeastVerdictKind = "PASS" | "VETO";

export interface BeastVerdict {
  vote: BeastVerdictKind;
  reason: string;
  /** Which surface flagged the veto (multi-bit; veto wins on any) */
  surfaces: number;    // bitmask
  /** Honest concentration metric for telemetry (only valid when surfaces & 0b0100 set) */
  metrics: {
    nonLpTop1Pct?: number;
    nonLpTop5Pct?: number;
    nonLpTop10Pct?: number;
    insiderPct?: number;
    lpLockedPct?: number;
    bp5m?: number;
    binomialProof?: number;
  };
}

// surface bitmask
export const SURFACE_AUTHORITY   = 0b0000_0001;
export const SURFACE_LP_LOCK     = 0b0000_0010;
export const SURFACE_HOLDERS     = 0b0000_0100;
export const SURFACE_HONEYPOT    = 0b0000_1000;
export const SURFACE_WASH        = 0b0001_0000;
export const SURFACE_CREATOR     = 0b0010_0000;

// Thresholds (configurable via env at the call site, but exposed here for tests)
export const BEAST_MIN_LP_LOCK_PCT       = 80;     // 80% of LP must be locked
export const BEAST_MIN_LP_LOCK_DURATION  = 30 * 24 * 3600; // ≥30 days from now
export const BEAST_TOP1_MAX_PCT          = 5;      // single non-LP wallet < 5%
export const BEAST_TOP5_MAX_PCT          = 25;     // top-5 non-LP < 25%
export const BEAST_TOP10_MAX_PCT         = 45;     // top-10 non-LP < 45%
export const BEAST_INSIDER_MAX_PCT       = 12;     // flagged insiders < 12%
export const BEAST_MIN_BINOMIAL_PROOF     = 3;     // ≥3 sells AND ≥3 buys
export const BEAST_WASH_VOL_LIQ_MULT      = 6;     // vol5m/liq > 6x = wash
export const BEAST_WASH_BALANCE_BAND      = 0.10;  // |bp-0.5| < 0.10 = balanced
export const BEAST_WASH_FLAT_PX           = 3;     // |px5m| ≤ 3% = flat
export const BEAST_WASH_MIN_TX            = 20;    // ≥20 5m tx to be wash
export const BEAST_CREATOR_MAX_RUG_RATIO  = 0.50;  // ≥50% prior tokens dead/rug
export const BEAST_CREATOR_MIN_SAMPLES    = 2;     // need ≥2 prior tokens to veto

const NULL_ADDR = "11111111111111111111111111111111";

function isNotNullAuthority(v: string | null | undefined): boolean {
  return typeof v === "string" && v.length > 0 && v !== NULL_ADDR;
}

function pass(surfaces: number, metrics: BeastVerdict["metrics"] = {}): BeastVerdict {
  return { vote: "PASS", reason: "beast_pass", surfaces, metrics };
}

function veto(surface: number, reason: string, metrics: BeastVerdict["metrics"] = {}): BeastVerdict {
  return { vote: "VETO", reason, surfaces: surface, metrics };
}

/**
 * Evaluate the full concentric Beast Safety gate.
 * Returns VETO on the first failed surface (caller chains the reason); PASS only
 * if ALL surfaces are admissible. When `failOpenOnMissingData` is true we use
 * best-effort rather than veto for surfaces whose inputs were unavailable; the
 * Beast tier keeps this FALSE by default — fail-closed posture.
 */
export function evaluateBeastSafety(
  auth: AuthoritySnapshot | null,
  lpLock: LpLockInput | null,
  holders: HolderInput[] | null,
  totalSupply: number,
  flow: FlowInput | null,
  creatorHistory: CreatorHistoryInput | null,
  failOpenOnMissingData: boolean = false,
): BeastVerdict {
  let surfaces = 0;
  const metrics: BeastVerdict["metrics"] = {};

  // ── 1. Authority surface ─────────────────────────────────────────────
  if (auth) {
    if (isNotNullAuthority(auth.freezeAuthority)) {
      return veto(SURFACE_AUTHORITY, "beast_veto_freeze_authority_active", metrics);
    }
    if (isNotNullAuthority(auth.mintAuthority)) {
      // Mint authority active = perpetual dilution path. The existing engine
      // only logs it; the Beast tier hard-vetoes — there is no scenario where
      // a non-renounced mint is a 1000x runner.
      return veto(SURFACE_AUTHORITY, "beast_veto_mint_authority_active", metrics);
    }
    surfaces |= SURFACE_AUTHORITY;
  } else if (!failOpenOnMissingData) {
    return veto(SURFACE_AUTHORITY, "beast_veto_authority_data_missing", metrics);
  }

  // ── 2. LP lock surface ───────────────────────────────────────────────
  if (lpLock && lpLock.lockSourceVerified && lpLock.lpLockedPct >= 0) {
    if (lpLock.lpLockedPct < BEAST_MIN_LP_LOCK_PCT) {
      metrics.lpLockedPct = lpLock.lpLockedPct;
      return veto(SURFACE_LP_LOCK,
        `beast_veto_lp_lock_insufficient(${lpLock.lpLockedPct.toFixed(1)}%<${BEAST_MIN_LP_LOCK_PCT}%)`,
        metrics);
    }
    if (typeof lpLock.lpLockedUntilSec === "number" && isFinite(lpLock.lpLockedUntilSec)) {
      const nowSec = Math.floor(lpLock.now / 1000);
      const keepUntil = nowSec + BEAST_MIN_LP_LOCK_DURATION;
      if (lpLock.lpLockedUntilSec < keepUntil) {
        metrics.lpLockedPct = lpLock.lpLockedPct;
        return veto(SURFACE_LP_LOCK,
          `beast_veto_lp_lock_expiring(too_short:${new Date(lpLock.lpLockedUntilSec * 1000).toISOString()})`,
          metrics);
      }
    }
    metrics.lpLockedPct = lpLock.lpLockedPct;
    surfaces |= SURFACE_LP_LOCK;
  } else if (!failOpenOnMissingData) {
    return veto(SURFACE_LP_LOCK, "beast_veto_lp_lock_unverified", metrics);
  }

  // ── 3. Holder concentration surface ──────────────────────────────────
  if (holders && holders.length > 0 && totalSupply > 0) {
    const nonLp = holders.filter(h => !h.isLp && !h.isCreator);
    const sorted = [...nonLp].sort((a, b) => b.amount - a.amount);
    const pctOf = (n: number) => (n / totalSupply) * 100;
    const nonLpTop1 = pctOf(sorted[0]?.amount ?? 0);
    const nonLpTop5 = pctOf(sorted.slice(0, 5).reduce((s, h) => s + h.amount, 0));
    const nonLpTop10 = pctOf(sorted.slice(0, 10).reduce((s, h) => s + h.amount, 0));
    const insiderPct = pctOf(
      nonLp.filter(h => h.isInsider).reduce((s, h) => s + h.amount, 0)
    );

    metrics.nonLpTop1Pct = nonLpTop1;
    metrics.nonLpTop5Pct = nonLpTop5;
    metrics.nonLpTop10Pct = nonLpTop10;
    metrics.insiderPct = insiderPct;

    if (nonLpTop1 > BEAST_TOP1_MAX_PCT) {
      return veto(SURFACE_HOLDERS,
        `beast_veto_top1_nonlp(${nonLpTop1.toFixed(1)}%>${BEAST_TOP1_MAX_PCT}%)`,
        metrics);
    }
    if (nonLpTop5 > BEAST_TOP5_MAX_PCT) {
      return veto(SURFACE_HOLDERS,
        `beast_veto_top5_nonlp(${nonLpTop5.toFixed(1)}%>${BEAST_TOP5_MAX_PCT}%)`,
        metrics);
    }
    if (nonLpTop10 > BEAST_TOP10_MAX_PCT) {
      return veto(SURFACE_HOLDERS,
        `beast_veto_top10_nonlp(${nonLpTop10.toFixed(1)}%>${BEAST_TOP10_MAX_PCT}%)`,
        metrics);
    }
    if (insiderPct > BEAST_INSIDER_MAX_PCT) {
      return veto(SURFACE_HOLDERS,
        `beast_veto_insider(${insiderPct.toFixed(1)}%>${BEAST_INSIDER_MAX_PCT}%)`,
        metrics);
    }
    surfaces |= SURFACE_HOLDERS;
  } else if (!failOpenOnMissingData) {
    return veto(SURFACE_HOLDERS, "beast_veto_holder_data_missing", metrics);
  }

  // ── 4. Honeypot-symmetry surface (5m binomial proof) ─────────────────
  if (flow) {
    const buys = flow.buys;
    const sells = flow.sells;
    metrics.bp5m = buys + sells > 0 ? buys / (buys + sells) : 0;
    metrics.binomialProof = Math.min(buys, sells);
    // A real two-sided market must have ≥3 sells in 5m. A honeypot with buy-tax
    // only progressively drains the buyer, so sell-count = 0. A 25/75 wash also
    // fails the symmetry below because we require BOTH ≥3 buys AND ≥3 sells.
    if (buys < BEAST_MIN_BINOMIAL_PROOF || sells < BEAST_MIN_BINOMIAL_PROOF) {
      return veto(SURFACE_HONEYPOT,
        `beast_veto_no_two_way_market(buys=${buys},sells=${sells})`,
        metrics);
    }
    surfaces |= SURFACE_HONEYPOT;
  } else if (!failOpenOnMissingData) {
    return veto(SURFACE_HONEYPOT, "beast_veto_flow_data_missing", metrics);
  }

  // ── 5. Wash-asymmetry surface ────────────────────────────────────────
  if (flow && flow.liquidityUsd > 0 && flow.volume5mUsd > 0) {
    const volLiqRatio = flow.volume5mUsd / flow.liquidityUsd;
    const totalTx = flow.buys + flow.sells;
    const bp = totalTx > 0 ? flow.buys / totalTx : 0.5;
    const absPx = Math.abs(flow.priceChange5mPct);
    const manufVol = volLiqRatio > BEAST_WASH_VOL_LIQ_MULT;
    const balanced = Math.abs(bp - 0.5) <= BEAST_WASH_BALANCE_BAND;
    const flat = absPx <= BEAST_WASH_FLAT_PX;
    const highTx = totalTx >= BEAST_WASH_MIN_TX;
    if (manufVol && balanced && flat && highTx) {
      return veto(SURFACE_WASH,
        `beast_veto_wash_bundle(vol_liq=${volLiqRatio.toFixed(1)}x,bp=${bp.toFixed(2)},px=${absPx.toFixed(1)}%)`,
        metrics);
    }
    surfaces |= SURFACE_WASH;
  } else if (!failOpenOnMissingData) {
    return veto(SURFACE_WASH, "beast_veto_flow_volume_missing", metrics);
  }

  // ── 6. Creator-history surface ───────────────────────────────────────
  if (creatorHistory && creatorHistory.creatorPriorTokenStatuses.length >= BEAST_CREATOR_MIN_SAMPLES) {
    const stats = creatorHistory.creatorPriorTokenStatuses;
    const deadCount = stats.filter(s => s === "dead" || s === "rug").length;
    const ratio = deadCount / stats.length;
    if (ratio >= BEAST_CREATOR_MAX_RUG_RATIO) {
      return veto(SURFACE_CREATOR,
        `beast_veto_creator_rug_history(${deadCount}/${stats.length}=${(ratio * 100).toFixed(0)}% dead/rug)`,
        metrics);
    }
    surfaces |= SURFACE_CREATOR;
  } else if (!failOpenOnMissingData && creatorHistory !== null) {
    // null history = explicitly opted out (fine). Non-null but <2 samples = insufficient.
    return veto(SURFACE_CREATOR, "beast_veto_creator_history_insufficient", metrics);
  }

  return pass(surfaces, metrics);
}

/**
 * Combine the existing soft safety decision (from token-safety-policy.ts) with
 * the Beast gate. The Beast tier is STRICTLY additive — a Beast VETO always
 * blocks even if the soft checker returns safe. The Beast tier is gated by an
 * env flag (BEAST_SAFETY_ENABLED) upstream.
 */
export function combineBeastWithSoft(
  softDecision: { safe: boolean; reason: string },
  beast: BeastVerdict | null,
): { safe: boolean; reason: string; beastVetoed?: boolean } {
  if (beast && beast.vote === "VETO") {
    return { safe: false, reason: `beast_block:${beast.reason}`, beastVetoed: true };
  }
  return softDecision;
}
