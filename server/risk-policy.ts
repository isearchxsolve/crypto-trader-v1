export interface CircuitBreakerDecisionInput {
  isBtcCrash: boolean;
  dailyPnlSol: number;
  unrealizedPnlSol: number;
  dailyStartBalance: number;
  dailyLossLimitPct: number;
  microDailyLossLimitPct: number;
  effectiveBalance: number;
  peakBalance: number;
  maxDrawdownPct: number;
  now: number;
  lastMiniCooldownEnd: number;
  lastLossCooldownEnd: number;
  circuitBreakerActive: boolean;
}

export interface CircuitBreakerDecision {
  canTrade: boolean;
  reason: string;
  nextPeakBalance: number;
  dailyLossPct: number;
  effectiveDailyLossLimitPct: number;
  drawdownPct: number;
  shouldActivateCircuitBreaker: boolean;
  shouldClearCircuitBreaker: boolean;
  shouldTriggerFlightToSafety: boolean;
  shouldReturnFromSafety: boolean;
}

export interface PreBuyRiskPolicyInput {
  totalPortfolioSol: number;
  totalExposureSol: number;
  candidateSizeSol: number;
  maxPositionSizeSol: number;
  entrySlippagePct: number;
  entryFeePct: number;
  minViableTradeSol: number;
  isLiveBuy: boolean;
  walletBalanceSol: number | null;
  reservedCapitalSol: number;
  liveSlippagePct: number;
  minFeeBufferSol: number;
  /** Max total entry cost (slippage + fees) as % of trade size. Default 15%. */
  maxEntryCostPct?: number;
}

export interface PreBuyRiskPolicyDecision {
  allowed: boolean;
  reason: string;
  maxTotalExposureSol: number;
  entryTotalCostSol: number;
  safeBalanceSol: number | null;
  maxPossibleSpendSol: number | null;
}

export function evaluateCircuitBreakerDecision(
  input: CircuitBreakerDecisionInput,
): CircuitBreakerDecision {
  const netDailyPnl = input.dailyPnlSol + input.unrealizedPnlSol;
  const totalLoss = netDailyPnl < 0 ? Math.abs(netDailyPnl) : 0;
  const dailyLossPct =
    input.dailyStartBalance > 0 ? (totalLoss / input.dailyStartBalance) * 100 : 0;
  const effectiveDailyLossLimitPct =
    input.dailyStartBalance < 0.1
      ? input.microDailyLossLimitPct
      : input.dailyLossLimitPct;

  if (input.isBtcCrash) {
    return {
      canTrade: false,
      reason: "GLOBAL_MARKET_CRASH (BTC is down > 5%)",
      nextPeakBalance: input.peakBalance,
      dailyLossPct,
      effectiveDailyLossLimitPct,
      drawdownPct: input.peakBalance > 0
        ? ((input.peakBalance - input.effectiveBalance) / input.peakBalance) * 100
        : 0,
      shouldActivateCircuitBreaker: true,
      shouldClearCircuitBreaker: false,
      shouldTriggerFlightToSafety: true,
      shouldReturnFromSafety: false,
    };
  }

  if (dailyLossPct >= effectiveDailyLossLimitPct) {
    return {
      canTrade: false,
      reason: `DAILY_LOSS_LIMIT (${dailyLossPct.toFixed(1)}% >= ${effectiveDailyLossLimitPct}%)`,
      nextPeakBalance: input.peakBalance,
      dailyLossPct,
      effectiveDailyLossLimitPct,
      drawdownPct: input.peakBalance > 0
        ? ((input.peakBalance - input.effectiveBalance) / input.peakBalance) * 100
        : 0,
      shouldActivateCircuitBreaker: true,
      shouldClearCircuitBreaker: false,
      shouldTriggerFlightToSafety: true,
      shouldReturnFromSafety: false,
    };
  }

  const nextPeakBalance =
    input.effectiveBalance > input.peakBalance ? input.effectiveBalance : input.peakBalance;
  const drawdownPct =
    nextPeakBalance > 0
      ? ((nextPeakBalance - input.effectiveBalance) / nextPeakBalance) * 100
      : 0;

  if (drawdownPct >= input.maxDrawdownPct) {
    return {
      canTrade: false,
      reason: `MAX_DRAWDOWN (${drawdownPct.toFixed(1)}% >= ${input.maxDrawdownPct}%)`,
      nextPeakBalance,
      dailyLossPct,
      effectiveDailyLossLimitPct,
      drawdownPct,
      shouldActivateCircuitBreaker: true,
      shouldClearCircuitBreaker: false,
      shouldTriggerFlightToSafety: true,
      shouldReturnFromSafety: false,
    };
  }

  if (input.now < input.lastMiniCooldownEnd) {
    const remaining = Math.ceil((input.lastMiniCooldownEnd - input.now) / 1000);
    return {
      canTrade: false,
      reason: `MINI_LOSS_COOLDOWN (${remaining}s remaining — 2 consecutive losses)`,
      nextPeakBalance,
      dailyLossPct,
      effectiveDailyLossLimitPct,
      drawdownPct,
      shouldActivateCircuitBreaker: false,
      shouldClearCircuitBreaker: input.circuitBreakerActive,
      shouldTriggerFlightToSafety: false,
      shouldReturnFromSafety: input.circuitBreakerActive,
    };
  }

  if (input.now < input.lastLossCooldownEnd) {
    const remaining = Math.ceil((input.lastLossCooldownEnd - input.now) / 1000);
    return {
      canTrade: false,
      reason: `LOSS_COOLDOWN (${remaining}s remaining)`,
      nextPeakBalance,
      dailyLossPct,
      effectiveDailyLossLimitPct,
      drawdownPct,
      shouldActivateCircuitBreaker: false,
      shouldClearCircuitBreaker: input.circuitBreakerActive,
      shouldTriggerFlightToSafety: false,
      shouldReturnFromSafety: input.circuitBreakerActive,
    };
  }

  return {
    canTrade: true,
    reason: "OK",
    nextPeakBalance,
    dailyLossPct,
    effectiveDailyLossLimitPct,
    drawdownPct,
    shouldActivateCircuitBreaker: false,
    shouldClearCircuitBreaker: true,
    shouldTriggerFlightToSafety: false,
    shouldReturnFromSafety: true,
  };
}

export function evaluatePreBuyRiskPolicy(
  input: PreBuyRiskPolicyInput,
): PreBuyRiskPolicyDecision {
  const maxTotalExposureSol = Math.max(
    input.maxPositionSizeSol * 10,
    input.totalPortfolioSol * 0.95,
  );
  const entryTotalCostSol =
    input.candidateSizeSol * (1 + (input.entrySlippagePct + input.entryFeePct) / 100);

  if (input.totalExposureSol + input.candidateSizeSol > maxTotalExposureSol) {
    return {
      allowed: false,
      reason: "MAX_TOTAL_EXPOSURE_REACHED",
      maxTotalExposureSol,
      entryTotalCostSol,
      safeBalanceSol: null,
      maxPossibleSpendSol: null,
    };
  }

  if (entryTotalCostSol < input.minViableTradeSol) {
    return {
      allowed: false,
      reason: "TRADE_TOO_SMALL_AFTER_FEES",
      maxTotalExposureSol,
      entryTotalCostSol,
      safeBalanceSol: null,
      maxPossibleSpendSol: null,
    };
  }

  const totalEntryCostPct = input.entrySlippagePct + input.entryFeePct;
  const maxEntryCostPct = input.maxEntryCostPct ?? 15;
  if (totalEntryCostPct > maxEntryCostPct) {
    return {
      allowed: false,
      reason: `ENTRY_COST_TOO_HIGH(${totalEntryCostPct.toFixed(1)}%>${maxEntryCostPct}%)`,
      maxTotalExposureSol,
      entryTotalCostSol,
      safeBalanceSol: null,
      maxPossibleSpendSol: null,
    };
  }

  if (input.isLiveBuy) {
    const safeBalanceSol = Math.max(
      0,
      (input.walletBalanceSol ?? 0) - input.reservedCapitalSol,
    );
    const maxPossibleSpendSol =
      input.candidateSizeSol * (1 + input.liveSlippagePct / 100) + input.minFeeBufferSol;

    if (safeBalanceSol < maxPossibleSpendSol) {
      return {
        allowed: false,
        reason: "UNSAFE_BALANCE_FOR_MAX_SPEND",
        maxTotalExposureSol,
        entryTotalCostSol,
        safeBalanceSol,
        maxPossibleSpendSol,
      };
    }

    return {
      allowed: true,
      reason: "OK",
      maxTotalExposureSol,
      entryTotalCostSol,
      safeBalanceSol,
      maxPossibleSpendSol,
    };
  }

  return {
    allowed: true,
    reason: "OK",
    maxTotalExposureSol,
    entryTotalCostSol,
    safeBalanceSol: null,
    maxPossibleSpendSol: null,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// MOMENTUM CIRCUIT BREAKER
// Detects consecutive loss streaks and pauses trading to prevent death spirals.
// Operates independently of the BTC crash guard (catches sector-specific dumps).
// ─────────────────────────────────────────────────────────────────────────────

export interface RecentTrade {
  timestamp: number; // Unix ms
  pnlSol: number;    // negative = loss
}

export interface MomentumCircuitBreakerInput {
  recentTrades: RecentTrade[];
  now: number;
  lossCooldownWindowMs: number;  // rolling window for consecutive loss counting (default 10 min)
  streak3PauseMs: number;        // pause duration after 3-loss streak (default 5 min)
  streak5PauseMs: number;        // pause duration after 5-loss streak (default 30 min)
}

export interface MomentumCircuitBreakerDecision {
  canTrade: boolean;
  reason: string;
  streakLength: number;
  resumeAt: number; // timestamp when trading can resume (0 = can trade now)
}

/**
 * Counts consecutive losses from the MOST RECENT trade backwards within the rolling window.
 * A single win resets the streak — this is intentional (we only block on recent streaks).
 */
function countConsecutiveLossStreak(
  trades: RecentTrade[],
  now: number,
  windowMs: number,
): number {
  const windowStart = now - windowMs;
  // Only consider trades within the rolling window, newest first
  const recent = [...trades]
    .filter(t => t.timestamp >= windowStart)
    .sort((a, b) => b.timestamp - a.timestamp);

  let streak = 0;
  for (const trade of recent) {
    if (trade.pnlSol < 0) {
      streak++;
    } else {
      break; // win resets the streak
    }
  }
  return streak;
}

export function evaluateMomentumCircuitBreaker(
  input: MomentumCircuitBreakerInput,
): MomentumCircuitBreakerDecision {
  const { recentTrades, now, lossCooldownWindowMs, streak3PauseMs, streak5PauseMs } = input;

  if (!recentTrades.length) {
    return { canTrade: true, reason: "OK_no_trades", streakLength: 0, resumeAt: 0 };
  }

  const streakLength = countConsecutiveLossStreak(recentTrades, now, lossCooldownWindowMs);

  if (streakLength >= 5) {
    const lastLoss = Math.max(...recentTrades.filter(t => t.pnlSol < 0).map(t => t.timestamp));
    const resumeAt = lastLoss + streak5PauseMs;
    if (now < resumeAt) {
      const remainingSecs = Math.ceil((resumeAt - now) / 1000);
      return {
        canTrade: false,
        reason: `MOMENTUM_CIRCUIT_BREAKER_5STREAK(${remainingSecs}s_remaining,${streakLength}_losses)`,
        streakLength,
        resumeAt,
      };
    }
  }

  if (streakLength >= 3) {
    const lastLoss = Math.max(...recentTrades.filter(t => t.pnlSol < 0).map(t => t.timestamp));
    const resumeAt = lastLoss + streak3PauseMs;
    if (now < resumeAt) {
      const remainingSecs = Math.ceil((resumeAt - now) / 1000);
      return {
        canTrade: false,
        reason: `MOMENTUM_CIRCUIT_BREAKER_3STREAK(${remainingSecs}s_remaining,${streakLength}_losses)`,
        streakLength,
        resumeAt,
      };
    }
  }

  return { canTrade: true, reason: "OK", streakLength, resumeAt: 0 };
}
