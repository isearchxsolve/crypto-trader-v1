/**
 * portfolio-risk.ts — Portfolio-level risk manager (INTERFACE STUB ONLY)
 *
 * Architectural role (see ARCHITECTURE.md §5 Risk Engine):
 *   Complements risk-engine.ts (per-trade + heat + drawdown) with portfolio-
 *   level controls: VaR, correlation/narrative limits, sector exposure caps,
 *   concurrent-position ceiling, and liquidity reserve enforcement.
 *
 *   Satisfies R-RISK at the portfolio dimension and supports R-RESILIENCE by
 *   keeping a SOL reserve for emergency exits.
 *
 *   STATUS: STUB — implementation deferred to IMPLEMENTATION phase.
 *   Do NOT add business logic here during ARCHITECTURE phase.
 */

import type { ConvictionTier } from "./position-sizing";

export type Sector = "meme" | "ai" | "defi" | "other";

/** A single open position as seen by the portfolio risk manager. */
export interface PortfolioPosition {
  mint: string;
  sector: Sector;
  narrative: string;       // free-text tag for correlation grouping
  positionSizeSol: number;
  entryPriceSol: number;
  currentPriceSol: number;
  tier: ConvictionTier;
}

/** Full portfolio snapshot fed into the risk manager. */
export interface PortfolioSnapshot {
  totalEquitySol: number;
  reserveSol: number;            // SOL held back for emergency exits
  positions: PortfolioPosition[];
}

/** Configuration for portfolio-level risk controls. */
export interface PortfolioRiskConfig {
  maxPortfolioVarPct: number;        // 95% 1-day VaR as fraction of equity
  maxConcurrentPositions: number;
  maxPerNarrative: number;            // max positions sharing one narrative
  sectorCaps: Record<Sector, number>; // fraction of equity per sector
  liquidityReservePct: number;       // fraction of equity kept as SOL reserve
}

/** Structured verdict from the portfolio risk manager. */
export interface PortfolioRiskDecision {
  allow: boolean;
  reason: string;
  metrics: {
    portfolioVarPct: number;
    concurrentPositions: number;
    sectorExposure: Record<Sector, number>;
    narrativeConcentration: Record<string, number>;
    reserveSol: number;
  };
  bindingConstraint:
    | "var"
    | "concurrency"
    | "narrative"
    | "sector"
    | "reserve"
    | "none";
}

/**
 * Evaluate whether a new position may be opened given portfolio state.
 *
 * Pure. Deterministic. No I/O. Unit-testable.
 * IMPLEMENTATION DEFERRED — throws stub during ARCHITECTURE phase.
 */
export function evaluatePortfolioRisk(
  _newPosition: { mint: string; sector: Sector; narrative: string; sizeSol: number },
  _portfolio: PortfolioSnapshot,
  _config: PortfolioRiskConfig
): PortfolioRiskDecision {
  throw new Error("portfolio-risk.evaluatePortfolioRisk: not implemented (stub)");
}
