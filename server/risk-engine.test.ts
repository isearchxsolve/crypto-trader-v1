/**
 * risk-engine.test.ts — Unit tests for the portfolio risk engine.
 *
 * Tests the REAL exported API of risk-engine.ts:
 *   - evaluateEntryRisk: drawdown breaker, min equity, max positions,
 *     heat cap (with size reduction), max position size cap
 *   - evaluatePositionRisk: per-trade max loss force-close
 *   - calculateRiskMetrics: heat / drawdown / concentration math
 *   - updatePortfolioAfterTrade: entry + exit state transitions
 *   - updatePositionPrices: price tick → unrealized PnL + equity recompute
 */
import { describe, it, expect } from 'vitest';
import {
  DEFAULT_RISK_CONFIG,
  evaluateEntryRisk,
  evaluatePositionRisk,
  calculateRiskMetrics,
  updatePortfolioAfterTrade,
  updatePositionPrices,
  PortfolioState,
  PositionState,
} from './risk-engine';

function makePortfolio(overrides: Partial<PortfolioState> = {}): PortfolioState {
  return {
    equity: 10,
    dayStartEquity: 10,
    dayPeakEquity: 10,
    positions: [],
    realizedPnlToday: 0,
    ...overrides,
  };
}

function makePosition(overrides: Partial<PositionState> = {}): PositionState {
  return {
    tokenAddress: 'TOKEN_X',
    entryPrice: 1,
    currentPrice: 1,
    positionSizeSol: 1,
    entryTimestamp: Date.now(),
    unrealizedPnlPct: 0,
    ...overrides,
  };
}

describe('evaluateEntryRisk', () => {
  it('admits a small position unchanged', () => {
    const decision = evaluateEntryRisk(0.5, makePortfolio());
    expect(decision.allowed).toBe(true);
    expect(decision.reason).toBe('ok');
    expect(decision.adjustedSizeSol).toBe(0.5);
  });

  it('blocks entry when daily drawdown breaches the limit', () => {
    // Peak 10 → equity 8 = 20% drawdown, above the 15% default limit
    const portfolio = makePortfolio({ equity: 8, dayPeakEquity: 10 });
    const decision = evaluateEntryRisk(0.5, portfolio);
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain('daily_drawdown_breach');
  });

  it('blocks entry below min equity', () => {
    const portfolio = makePortfolio({ equity: 0.3, dayStartEquity: 0.3, dayPeakEquity: 0.3 });
    const decision = evaluateEntryRisk(0.1, portfolio);
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain('equity_below_min');
  });

  it('blocks entry at max concurrent positions', () => {
    const positions = Array.from({ length: 8 }, (_, i) =>
      makePosition({ tokenAddress: `T${i}` })
    );
    const decision = evaluateEntryRisk(0.1, makePortfolio({ positions }));
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain('max_positions_reached');
  });

  it('reduces size to fit the portfolio heat cap', () => {
    // equity 10, heat cap 80% → max total exposure 8 SOL; existing 7.5 → only 0.5 fits
    const positions = [makePosition({ positionSizeSol: 7.5 })];
    const decision = evaluateEntryRisk(2, makePortfolio({ positions }));
    expect(decision.allowed).toBe(true);
    expect(decision.reason).toContain('size_reduced_for_heat');
    expect(decision.adjustedSizeSol).toBeCloseTo(0.5, 5);
  });

  it('rejects outright when heat cap is already exhausted', () => {
    const positions = [makePosition({ positionSizeSol: 8 })];
    const decision = evaluateEntryRisk(1, makePortfolio({ positions }));
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain('portfolio_heat_cap');
  });

  it('caps a single position at maxPositionSizePct of equity', () => {
    // equity 10, max position 10% → 1 SOL cap; heat cap (8 SOL) not binding
    const decision = evaluateEntryRisk(3, makePortfolio());
    expect(decision.allowed).toBe(true);
    expect(decision.reason).toContain('size_capped_at_max_position');
    expect(decision.adjustedSizeSol).toBeCloseTo(1, 5);
  });

  it('accepts a custom config', () => {
    const strict = { ...DEFAULT_RISK_CONFIG, maxConcurrentPositions: 1 };
    const positions = [makePosition()];
    const decision = evaluateEntryRisk(0.1, makePortfolio({ positions }), strict);
    expect(decision.allowed).toBe(false);
  });
});

describe('evaluatePositionRisk', () => {
  it('force-closes at the per-trade max loss', () => {
    const position = makePosition({ unrealizedPnlPct: -25 });
    const result = evaluatePositionRisk(position);
    expect(result.shouldClose).toBe(true);
    expect(result.reason).toContain('per_trade_max_loss');
  });

  it('holds a position within the loss budget', () => {
    const position = makePosition({ unrealizedPnlPct: -10 });
    const result = evaluatePositionRisk(position);
    expect(result.shouldClose).toBe(false);
    expect(result.reason).toBe('ok');
  });

  it('holds a winning position', () => {
    const position = makePosition({ unrealizedPnlPct: 150 });
    expect(evaluatePositionRisk(position).shouldClose).toBe(false);
  });
});

describe('calculateRiskMetrics', () => {
  it('computes heat, drawdown, count and concentration', () => {
    const positions = [
      makePosition({ tokenAddress: 'A', positionSizeSol: 2 }),
      makePosition({ tokenAddress: 'B', positionSizeSol: 1 }),
    ];
    const portfolio = makePortfolio({ equity: 10, dayPeakEquity: 12.5, positions });
    const metrics = calculateRiskMetrics(portfolio);
    expect(metrics.portfolioHeat).toBeCloseTo(0.3, 5);
    expect(metrics.dailyDrawdownPct).toBeCloseTo(0.2, 5);
    expect(metrics.positionCount).toBe(2);
    expect(metrics.maxPositionPct).toBeCloseTo(0.2, 5);
  });

  it('handles an empty portfolio without division errors', () => {
    const metrics = calculateRiskMetrics(makePortfolio({ equity: 0, dayPeakEquity: 0 }));
    expect(metrics.portfolioHeat).toBe(0);
    expect(metrics.dailyDrawdownPct).toBe(0);
    expect(metrics.positionCount).toBe(0);
    expect(metrics.maxPositionPct).toBe(0);
  });
});

describe('updatePortfolioAfterTrade', () => {
  it('adds a position on entry', () => {
    const next = updatePortfolioAfterTrade(makePortfolio(), 'TOKEN_NEW', 1, 0.5, true);
    expect(next.positions).toHaveLength(1);
    expect(next.positions[0].tokenAddress).toBe('TOKEN_NEW');
    expect(next.positions[0].entryPrice).toBe(0.5);
  });

  it('removes a position on exit and books realized PnL', () => {
    const portfolio = makePortfolio({ positions: [makePosition({ tokenAddress: 'TOKEN_X' })] });
    const next = updatePortfolioAfterTrade(portfolio, 'TOKEN_X', 1, 1.2, false, 0.8);
    expect(next.positions).toHaveLength(0);
    expect(next.realizedPnlToday).toBeCloseTo(0.8, 5);
    // equity = dayStart(10) + realized(0.8) + unrealized(0)
    expect(next.equity).toBeCloseTo(10.8, 5);
  });

  it('ignores an exit for an unknown token', () => {
    const portfolio = makePortfolio({ positions: [makePosition()] });
    const next = updatePortfolioAfterTrade(portfolio, 'UNKNOWN', 1, 1, false, 5);
    expect(next.positions).toHaveLength(1);
    expect(next.realizedPnlToday).toBe(0);
  });

  it('raises dayPeakEquity when equity grows', () => {
    const portfolio = makePortfolio({ positions: [makePosition({ tokenAddress: 'T' })] });
    const next = updatePortfolioAfterTrade(portfolio, 'T', 1, 1, false, 3);
    expect(next.dayPeakEquity).toBeCloseTo(13, 5);
  });
});

describe('updatePositionPrices', () => {
  it('updates prices and unrealized PnL for known tokens only', () => {
    const portfolio = makePortfolio({
      positions: [
        makePosition({ tokenAddress: 'A', entryPrice: 1, currentPrice: 1, positionSizeSol: 2 }),
        makePosition({ tokenAddress: 'B', entryPrice: 2, currentPrice: 2, positionSizeSol: 1 }),
      ],
    });
    const next = updatePositionPrices(portfolio, new Map([['A', 1.5]]));
    const a = next.positions.find(p => p.tokenAddress === 'A')!;
    const b = next.positions.find(p => p.tokenAddress === 'B')!;
    expect(a.currentPrice).toBe(1.5);
    expect(a.unrealizedPnlPct).toBeCloseTo(50, 5);
    expect(b.currentPrice).toBe(2); // untouched
    // equity = 10 + unrealized(2 * 0.5 + 0) = 11
    expect(next.equity).toBeCloseTo(11, 5);
  });

  it('tracks the day peak when prices rally', () => {
    const portfolio = makePortfolio({
      positions: [makePosition({ tokenAddress: 'A', entryPrice: 1, positionSizeSol: 1 })],
    });
    const next = updatePositionPrices(portfolio, new Map([['A', 3]]));
    expect(next.equity).toBeCloseTo(12, 5);
    expect(next.dayPeakEquity).toBeCloseTo(12, 5);
  });
});
