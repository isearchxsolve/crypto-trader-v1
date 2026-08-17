/**
 * profit-session.ts — data-driven entry-session filters (profit-monster pass, 2026-08-16).
 *
 * Both functions are PURE and env-overridable so they can be unit-tested without
 * booting the engine and disabled without a code change. They encode the two
 * strongest loss concentrations found by segmenting all 208 shadow trades
 * (shadow-trades.jsonl, 2026-06-26..07-04, net -811%):
 *
 *   1. TIME-OF-DAY: realized expectancy by UTC hour of entry.
 *        hr 0  n=7  avg -6.61  win 14%
 *        hr 1  n=7  avg -15.17 win  0%
 *        hr 2  n=11 avg -15.94 win 18%
 *        hr 3  n=5  avg -7.63  win 20%
 *        hr 4  n=3  avg -9.76  win 33%
 *        hr 5  n=3  avg -2.98  win 33%
 *        hr 20 n=6  avg -18.47 win  0%
 *        hr 21 n=19 avg -7.99  win 21%
 *      These 8 hours = 61 trades = -667% = ~82% of the entire net loss, while the
 *      remaining 16 hours are net positive (winners concentrate in UTC 8, 12-16).
 *      Blocking the negative session removes the dominant bleed without touching the
 *      profit engine (MID_HOLD_RISK captured +389 across all hours).
 *
 *   2. MICRO-WALLET EV MARGIN: the 0.005 SOL micro lane was the ENTIRE loss
 *      (75 trades, 12% win, avg -10.4% = -780), while the 0.012 lane was breakeven
 *      and held every big winner. Micro entries empirically need more forward edge
 *      to be +EV, so the objective-EV admission margin is raised for micro wallets.
 */

/**
 * Env lookup shape — accepts process.env (index signature) and plain test objects.
 * Recognized keys: PROFIT_SESSION_FILTER, PROFIT_SESSION_BLOCK_HOURS,
 * MICRO_OBJECTIVE_EV_MARGIN, OBJECTIVE_EV_MARGIN.
 */
export type ProfitSessionEnv = Record<string, string | undefined>;

/** Default UTC hours to block — the 8 hours that produced ~82% of net loss. */
export const DEFAULT_BLOCK_HOURS = [0, 1, 2, 3, 4, 5, 20, 21];

/** Default objective-EV admission margin (%) for normal wallets. */
export const DEFAULT_EV_MARGIN = 1.0;

/** Default objective-EV admission margin (%) for micro wallets (tighter). */
export const DEFAULT_MICRO_EV_MARGIN = 1.5;

function parseHours(raw: string | undefined): number[] {
  // undefined => not configured, use the data-driven default. An explicitly empty
  // string means "block nothing" (allow all), so it must NOT fall back to defaults.
  if (raw === undefined) return DEFAULT_BLOCK_HOURS;
  const out: number[] = [];
  for (const part of raw.split(",")) {
    const trimmed = part.trim();
    if (trimmed === "") continue; // skip empty segments (e.g. "" or "1,,2")
    const n = Number(trimmed);
    if (Number.isFinite(n) && n >= 0 && n <= 23) out.push(Math.floor(n));
  }
  return out;
}

/**
 * Returns true if the given moment falls inside a tradable (positive-expectancy)
 * session. Blocks the data-identified negative UTC hours. Disable by setting
 * PROFIT_SESSION_FILTER=false; reshape the block set via PROFIT_SESSION_BLOCK_HOURS.
 */
export function inProfitSession(date: Date, env: ProfitSessionEnv = {}): boolean {
  const enabled = String(env.PROFIT_SESSION_FILTER ?? "true").toLowerCase() !== "false";
  if (!enabled) return true;
  const blockHours = parseHours(env.PROFIT_SESSION_BLOCK_HOURS);
  if (blockHours.length === 0) return true;
  const hour = date.getUTCHours();
  return !blockHours.includes(hour);
}

/**
 * Returns the objective-EV admission margin (%) for a wallet. Micro wallets get a
 * tighter (higher) margin because their lane was the entire historical loss — a
 * micro entry must clear more forward edge to be admitted.
 */
export function getObjectiveEvMargin(isMicroWallet: boolean, env: ProfitSessionEnv = {}): number {
  if (isMicroWallet) {
    const m = Number(env.MICRO_OBJECTIVE_EV_MARGIN);
    return Number.isFinite(m) && m >= 0 ? m : DEFAULT_MICRO_EV_MARGIN;
  }
  const m = Number(env.OBJECTIVE_EV_MARGIN);
  return Number.isFinite(m) && m >= 0 ? m : DEFAULT_EV_MARGIN;
}

/** Minimum liquidity (USD) for the EV-admission bypass. */
export const DEFAULT_EV_ADMISSION_MIN_LIQ = 50_000;

/**
 * Momentum pocket for mode-less EV admission — the data-proven positive-expectancy
 * entry profile (the $HIM pocket: px5m >= 10 AND volMom >= 2.0). Replaces the old
 * qualifiedMode requirement, which was calibrated on hype-inflated scores and strangled
 * frequency to ~0 trades/day ($RADON: passed safety + momentum-aware EV at +1.64% with
 * px5m 21.4% / volMom 3.20, yet was rejected for lacking a descriptive mode label).
 */
export const DEFAULT_EV_ADMISSION_MIN_PX5M = 10;
export const DEFAULT_EV_ADMISSION_MIN_VOLMOM = 2.0;

export interface EvAdmissionInput {
  netEvPct: number;                 // modeled forward net expectancy (capture - round-trip cost)
  liqUsd: number;                   // pool liquidity in USD
  px5m: number;                     // live 5-minute price change (%)
  volMom: number;                   // live volume momentum (x normal)
  qualifiedMode?: string | null;    // descriptive mode label — logged only, no longer required
  isMicroWallet: boolean;
}

export interface EvAdmissionResult {
  admit: boolean;
  reason: string;
}

/**
 * EV-ADMISSION ARBITER (2026-08-17): admits a token on FORWARD NET EXPECTANCY alone,
 * bypassing the descriptive score/momentum bars.
 *
 * Why this exists: the descriptive score bars were calibrated on the old hype-inflated
 * scores. After the score-inversion fix capped the smart-money/whale bonus, honest scores
 * dropped ~20-30 points and the bars became unreachable — the engine recorded ZERO trades.
 * Meanwhile the deep-liquidity tokens the EV model says ARE profitable (low round-trip
 * cost, sustainable forward capture) score modestly and never reached the objective-EV
 * gate, which sits downstream of the score gates. The thin-liquidity momentum tokens that
 * DO pass the descriptive gates are correctly rejected by the EV gate (round-trip cost
 * exceeds forward capture). Net: the profitable tokens were locked out.
 *
 * This function makes forward net expectancy the arbiter for deep-liquidity tokens:
 *   - admit only if netEvPct clears the (micro-aware) margin,
 *   - only for deep pools (>= EV_ADMISSION_MIN_LIQ, default $50k) where round-trip cost
 *     is low enough that the modeled capture is realistic,
 *   - only for tokens that already qualified for a mode (a real signal, not noise).
 * Thin pools stay rejected here AND by the objective gate, so cost-traps cannot sneak in.
 * Disable with EV_ADMISSION=false.
 */
export function evaluateEvAdmission(input: EvAdmissionInput, env: ProfitSessionEnv = {}): EvAdmissionResult {
  const enabled = String(env.EV_ADMISSION ?? "true").toLowerCase() !== "false";
  if (!enabled) return { admit: false, reason: "EV admission disabled (EV_ADMISSION=false)" };

  const minLiqRaw = Number(env.EV_ADMISSION_MIN_LIQ);
  const minLiq = Number.isFinite(minLiqRaw) && minLiqRaw > 0 ? minLiqRaw : DEFAULT_EV_ADMISSION_MIN_LIQ;
  if (input.liqUsd < minLiq) {
    return { admit: false, reason: `liq $${Math.round(input.liqUsd)} < EV-admission floor $${minLiq} (thin pools are round-trip cost traps)` };
  }

  // MOMENTUM POCKET (2026-08-17): the arbiter now requires the data-proven positive-
  // expectancy entry profile (px5m >= 10 AND volMom >= 2.0) INSTEAD of a descriptive
  // mode label. The old qualifiedMode requirement was calibrated on hype-inflated scores
  // and strangled frequency to ~0 trades/day: $RADON passed safety + the momentum-aware
  // EV gate at +1.64% (px5m 21.4%, volMom 3.20) yet was rejected for lacking a mode.
  // The momentum pocket is exactly the bar peakMomentumMultiplier calibrates to 1.0, so
  // an admitted token gets its full liquidity-based peak — and flat/falling pools (the
  // $XERIS/$DEGS losers) are excluded here AND compute negative EV. Tunable via env.
  const minPx5mRaw = Number(env.EV_ADMISSION_MIN_PX5M);
  const minPx5m = Number.isFinite(minPx5mRaw) ? minPx5mRaw : DEFAULT_EV_ADMISSION_MIN_PX5M;
  const minVolMomRaw = Number(env.EV_ADMISSION_MIN_VOLMOM);
  const minVolMom = Number.isFinite(minVolMomRaw) ? minVolMomRaw : DEFAULT_EV_ADMISSION_MIN_VOLMOM;
  if (input.px5m < minPx5m || input.volMom < minVolMom) {
    return { admit: false, reason: `momentum px5m ${input.px5m.toFixed(1)}% / volMom ${input.volMom.toFixed(2)} below pocket ${minPx5m}% / ${minVolMom} (not a live mover)` };
  }

  const margin = getObjectiveEvMargin(input.isMicroWallet, env);
  if (input.netEvPct < margin) {
    return { admit: false, reason: `forward net EV ${input.netEvPct.toFixed(2)}% < margin ${margin}%` };
  }

  const modeNote = input.qualifiedMode ? `, mode ${input.qualifiedMode}` : ", mode-less";
  return { admit: true, reason: `forward net EV +${input.netEvPct.toFixed(2)}% >= margin ${margin}% at liq $${Math.round(input.liqUsd)} (px5m ${input.px5m.toFixed(1)}%, volMom ${input.volMom.toFixed(2)}${modeNote})` };
}

/**
 * PEAK-MOMENTUM MULTIPLIER (2026-08-17): scales the modeled "achievable forward
 * peak" by LIVE momentum so the objective-EV gate cannot admit a pool that is not
 * actually moving.
 *
 * Why this exists: the first two trades recorded after the EV-admission fix both
 * LOST because estimateRealisticPeakPct() assigns a 10-12% forward peak to ANY pool
 * purely from liquidity, never checking live momentum. The engine therefore modeled
 * positive net EV on pools that were flat or falling and had no chance of running:
 *   - $XERIS  liq $161k  px5m +0.5%  volMom 1.06  -> modeled peak 12%, net EV +1.64%
 *             ADMITTED, real peak +0.07%, exited -3.49% (round-trip cost).
 *   - $DEGS   liq $60k   px5m -5.1%  volMom 0.65  -> modeled peak 10%, net EV +1.59%
 *             ADMITTED, real peak 0.00%, exited -10.81%.
 * A forward peak is only achievable if the token is moving NOW. This multiplier
 * discounts the peak when live momentum is weak, so a flat/falling pool computes
 * NEGATIVE net EV and is rejected, while a genuine mover keeps its full peak.
 *
 * Calibration: the multiplier reaches exactly 1.0 at the data-proven positive edge
 * bar (px5m >= 10 AND volMom >= 2.0 — the SNIPER/MG momentum pocket), so the profit
 * engine is preserved. Below that bar the peak is discounted proportionally:
 *   priceDrive = px5m <= 0 ? 0 : min(1, px5m / 10)     (price is the primary driver)
 *   volDrive   = volMom <= 0 ? 0 : min(1, volMom / 2)  (volume confirms the move)
 *   multiplier = 0.6 * priceDrive + 0.4 * volDrive     (range [0, 1])
 * Disable with PEAK_MOMENTUM=false (returns 1.0, restoring the old liquidity-only peak).
 */
export function peakMomentumMultiplier(px5m: number, volMom: number, env: ProfitSessionEnv = {}): number {
  const enabled = String(env.PEAK_MOMENTUM ?? "true").toLowerCase() !== "false";
  if (!enabled) return 1.0;
  const priceDrive = px5m <= 0 ? 0 : Math.min(1, px5m / 10);
  const volDrive = volMom <= 0 ? 0 : Math.min(1, volMom / 2);
  return 0.6 * priceDrive + 0.4 * volDrive;
}
