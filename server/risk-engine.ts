/**
 * risk-engine.ts — Portfolio risk management: per-trade max loss, portfolio heat cap, daily drawdown circuit-breaker.
 *
 * Pure, side-effect-free functions for unit testing. State is managed by the caller (routes.ts).
 */

export interface RiskConfig {
  /** Max loss per trade as fraction of position (e.g., 0.22 = 22%) */
  perTradeMaxLossPct: number;
  /** Max portfolio heat: sum of position sizes / equity (e.g., 0.8 = 80%) */
  portfolioHeatCap: number;
  /** Daily drawdown circuit-breaker: max equity drop from day's peak (e.g., 0.15 = 15%) */
  dailyDrawdownLimitPct: number;
  /** Max concurrent positions */
  maxConcurrentPositions: number;
  /** Max position size as fraction of equity (e.g., 0.1 = 10%) */
  maxPositionSizePct: number;
  /** Min equity to continue trading (absolute) */
  minEquity: number;
}

export interface PositionState {
  tokenAddress: string;
  entryPrice: number;
  currentPrice: number;
  positionSizeSol: number;
  entryTimestamp: number;
  unrealizedPnlPct: number;
}

export interface PortfolioState {
  equity: number;           // current total equity (SOL)
  dayStartEquity: number;   // equity at start of trading day
  dayPeakEquity: number;
  positions: PositionState[];
  realizedPnlToday: number;
}

export interface RiskDecision {
  allowed: boolean;
  reason: string;
  /** Adjusted position size if allowed (may be reduced) */
  adjustedSizeSol?: number;
  /** Risk metrics for telemetry */
  metrics: {
    portfolioHeat: number;
    dailyDrawdownPct: number;
    positionCount: number;
    maxPositionPct: number;
  };
}

export const DEFAULT_RISK_CONFIG: RiskConfig = {
  perTradeMaxLossPct: 0.22,       // 22% max loss per trade
  portfolioHeatCap: 0.80,         // 80% max portfolio heat
  dailyDrawdownLimitPct: 0.15,    // 15% daily drawdown limit
  maxConcurrentPositions: 8,      // max 8 concurrent positions
  maxPositionSizePct: 0.10,       // 10% max per position
  minEquity: 0.5,                 // 0.5 SOL minimum equity
};

/**
 * Evaluate if a new position can be opened given current portfolio state.
 * Returns adjusted position size (may be smaller than requested) or rejection.
 */
export function evaluateEntryRisk(
  requestedSizeSol: number,
  portfolio: PortfolioState,
  config: RiskConfig = DEFAULT_RISK_CONFIG
): RiskDecision {
  const metrics = calculateRiskMetrics(portfolio);

  // Daily drawdown circuit-breaker
  const dailyDrawdownPct = (portfolio.dayPeakEquity - portfolio.equity) / portfolio.dayPeakEquity;
  if (dailyDrawdownPct >= config.dailyDrawdownLimitPct) {
    return {
      allowed: false,
      reason: `daily_drawdown_breach(${dailyDrawdownPct.toFixed(2)}% >= ${config.dailyDrawdownLimitPct * 100}%)`,
      metrics,
    };
  }

  // Min equity check
  if (portfolio.equity < config.minEquity) {
    return {
      allowed: false,
      reason: `equity_below_min(${portfolio.equity} < ${config.minEquity})`,
      metrics,
    };
  }

  // Max concurrent positions
  if (portfolio.positions.length >= config.maxConcurrentPositions) {
    return {
      allowed: false,
      reason: `max_positions_reached(${portfolio.positions.length} >= ${config.maxConcurrentPositions})`,
      metrics,
    };
  }

  // Portfolio heat cap
  const newHeat = (portfolio.positions.reduce((sum, p) => sum + p.positionSizeSol, 0) + requestedSizeSol) / portfolio.equity;
  if (newHeat > config.portfolioHeatCap) {
    // Try to reduce size to fit
    const maxAllowedSize = portfolio.equity * config.portfolioHeatCap -
      portfolio.positions.reduce((sum, p) => sum + p.positionSizeSol, 0);
    if (maxAllowedSize <= 0) {
      return {
        allowed: false,
        reason: `portfolio_heat_cap(${newHeat.toFixed(2)} > ${config.portfolioHeatCap})`,
        metrics,
      };
    }
    return {
      allowed: true,
      reason: `size_reduced_for_heat(${requestedSizeSol.toFixed(4)} -> ${maxAllowedSize.toFixed(4)})`,
      adjustedSizeSol: maxAllowedSize,
      metrics,
    };
  }

  // Max position size
  const maxPosSize = portfolio.equity * config.maxPositionSizePct;
  if (requestedSizeSol > maxPosSize) {
    return {
      allowed: true,
      reason: `size_capped_at_max_position(${requestedSizeSol.toFixed(4)} -> ${maxPosSize.toFixed(4)})`,
      adjustedSizeSol: maxPosSize,
      metrics,
    };
  }

  return {
    allowed: true,
    reason: 'ok',
    adjustedSizeSol: requestedSizeSol,
    metrics,
  };
}

/**
 * Evaluate if an existing position should be force-closed due to per-trade max loss.
 */
export function evaluatePositionRisk(
  position: PositionState,
  config: RiskConfig = DEFAULT_RISK_CONFIG
): { shouldClose: boolean; reason: string } {
  // Per-trade max loss (unrealized)
  if (position.unrealizedPnlPct <= -config.perTradeMaxLossPct * 100) {
    return {
      shouldClose: true,
      reason: `per_trade_max_loss(${position.unrealizedPnlPct.toFixed(1)}% <= -${config.perTradeMaxLossPct * 100}%)`,
    };
  }
  return { shouldClose: false, reason: 'ok' };
}

/**
 * Calculate current portfolio risk metrics.
 */
export function calculateRiskMetrics(portfolio: PortfolioState): RiskDecision['metrics'] {
  const totalPositionValue = portfolio.positions.reduce(
    (sum, p) => sum + p.positionSizeSol, 0
  );
  const portfolioHeat = portfolio.equity > 0 ? totalPositionValue / portfolio.equity : 0;
  const dailyDrawdownPct = portfolio.dayPeakEquity > 0
    ? (portfolio.dayPeakEquity - portfolio.equity) / portfolio.dayPeakEquity
    : 0;
  const maxPositionPct = portfolio.equity > 0
    ? Math.max(...portfolio.positions.map(p => p.positionSizeSol / portfolio.equity), 0)
    : 0;
  return {
    portfolioHeat,
    dailyDrawdownPct,
    positionCount: portfolio.positions.length,
    maxPositionPct,
  };
}

/**
 * Update portfolio state after a trade execution (entry or exit).
 */
export function updatePortfolioAfterTrade(
  portfolio: PortfolioState,
  tokenAddress: string,
  sizeSol: number,
  price: number,
  isEntry: boolean,
  realizedPnl?: number
): PortfolioState {
  const newPortfolio = { ...portfolio };
  if (isEntry) {
    newPortfolio.positions = [
      ...portfolio.positions,
      {
        tokenAddress,
        entryPrice: price,
        currentPrice: price,
        positionSizeSol: sizeSol,
        entryTimestamp: Date.now(),
        unrealizedPnlPct: 0,
      },
    ];
  } else {
    const idx = portfolio.positions.findIndex(p => p.tokenAddress === tokenAddress);
    if (idx >= 0) {
      newPortfolio.positions = portfolio.positions.filter(p => p.tokenAddress !== tokenAddress);
      if (realizedPnl !== undefined) {
        newPortfolio.realizedPnlToday += realizedPnl;
      }
    }
  }

  // Update equity (simplified: equity = dayStartEquity + realizedPnlToday + unrealizedPnl)
  const unrealizedPnl = newPortfolio.positions.reduce(
    (sum, p) => sum + p.positionSizeSol * (p.currentPrice / p.entryPrice - 1), 0
  );
  newPortfolio.equity = newPortfolio.dayStartEquity + newPortfolio.realizedPnlToday + unrealizedPnl;
  newPortfolio.dayPeakEquity = Math.max(newPortfolio.dayPeakEquity, newPortfolio.equity);
  return newPortfolio;
}

/**
 * Update position current prices (call on each price tick).
 */
export function updatePositionPrices(
  portfolio: PortfolioState,
  prices: Map<string, number>
): PortfolioState {
  const newPortfolio = { ...portfolio };
  newPortfolio.positions = portfolio.positions.map(p => {
    const currentPrice = prices.get(p.tokenAddress);
    if (currentPrice === undefined) return p;
    const unrealizedPnlPct = ((currentPrice - p.entryPrice) / p.entryPrice) * 100;
    return { ...p, currentPrice, unrealizedPnlPct };
  });

  // Recalculate equity
  const unrealizedPnl = newPortfolio.positions.reduce(
    (sum, p) => sum + p.positionSizeSol * (p.currentPrice / p.entryPrice - 1), 0
  );
  newPortfolio.equity = newPortfolio.dayStartEquity + newPortfolio.realizedPnlToday + unrealizedPnl;
  newPortfolio.dayPeakEquity = Math.max(newPortfolio.dayPeakEquity, newPortfolio.equity);
  return newPortfolio;
}
