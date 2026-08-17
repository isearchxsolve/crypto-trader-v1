/**
 * position-sizing.ts — Kelly-optimal position sizing (INTERFACE STUB ONLY)
 *
 * Architectural role (see ARCHITECTURE.md §4 Entry Layer + §5 Risk Engine):
 *   Converts a CompositeScore + portfolio state into a liquidity-constrained,
 *   fractional-Kelly position size. Pure function — no I/O, no side effects.
 *
 *   Satisfies R-ENTRY (micro-wallet sizing) and supports R-RISK by clamping
 *   size to per-trade max-loss and pool-liquidity ceilings.
 *
 *   STATUS: STUB — implementation deferred to IMPLEMENTATION phase (TBD todo).
 *   Do NOT add business logic here during ARCHITECTURE phase.
 */

export type ConvictionTier = "LEGENDARY" | "HIGH" | "MEDIUM" | "SKIP";

/** Inputs required to compute a Kelly-fractional size. */
export interface PositionSizingInput {
  /** Win probability from the composite scorer / ML ensemble (0..1). */
  winProbability: number;
  /** Average win / average loss ratio from backtest (b in Kelly formula). */
  payoffRatio: number;
  /** Fractional Kelly multiplier (e.g. 0.5 = half-Kelly). */
  kellyFraction: number;
  /** Current total portfolio equity in SOL. */
  portfolioEquitySol: number;
  /** Conviction tier from composite scorer — sets max-position cap. */
  tier: ConvictionTier;
  /** Available pool liquidity in SOL (size is clamped to a fraction of this). */
  poolLiquiditySol: number;
  /** Max per-trade loss as fraction of equity (from RiskConfig). */
  maxPerTradeLossPct: number;
}

/** Result of position sizing — what the entry layer should actually fire. */
export interface PositionSize {
  /** Final size in SOL to deploy. */
  sizeSol: number;
  /** Raw Kelly fraction before clamps (0..1). */
  rawKellyFraction: number;
  /** Which clamp bound was binding, if any. */
  bindingConstraint:
    | "kelly"
    | "tier_cap"
    | "liquidity"
    | "max_loss"
    | "zero";
  /** Human-readable reason for audit log. */
  reason: string;
}

/** Per-tier max position as fraction of equity. */
export interface TierCaps {
  LEGENDARY: number;
  HIGH: number;
  MEDIUM: number;
}

/**
 * Compute a liquidity-constrained fractional-Kelly position size.
 *
 * Pure. Deterministic. No I/O. Unit-testable.
 * IMPLEMENTATION DEFERRED — returns zero-size stub during ARCHITECTURE phase.
 */
export function computePositionSize(
  _input: PositionSizingInput,
  _tierCaps: TierCaps
): PositionSize {
  throw new Error("position-sizing.computePositionSize: not implemented (stub)");
}
