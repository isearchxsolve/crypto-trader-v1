import { describe, expect, it } from "vitest";

import {
  evaluateCircuitBreakerDecision,
  evaluatePreBuyRiskPolicy,
  evaluateMomentumCircuitBreaker,
  type RecentTrade,
} from "./risk-policy";

describe("risk-policy", () => {
  describe("Circuit Breaker - Global Market Crash", () => {
    it("blocks trading during a global market crash", () => {
      const result = evaluateCircuitBreakerDecision({
        isBtcCrash: true,
        dailyPnlSol: 0,
        unrealizedPnlSol: 0,
        dailyStartBalance: 1,
        dailyLossLimitPct: 15,
        microDailyLossLimitPct: 30,
        effectiveBalance: 1,
        peakBalance: 1,
        maxDrawdownPct: 45,
        now: 1_000,
        lastMiniCooldownEnd: 0,
        lastLossCooldownEnd: 0,
        circuitBreakerActive: false,
      });

      expect(result).toMatchObject({
        canTrade: false,
        reason: "GLOBAL_MARKET_CRASH (BTC is down > 5%)",
        shouldActivateCircuitBreaker: true,
        shouldTriggerFlightToSafety: true,
      });
    });

    it("triggers flight to safety on BTC crash even with profitable positions", () => {
      const result = evaluateCircuitBreakerDecision({
        isBtcCrash: true,
        dailyPnlSol: 0.5,
        unrealizedPnlSol: 0.3,
        dailyStartBalance: 1,
        dailyLossLimitPct: 15,
        microDailyLossLimitPct: 30,
        effectiveBalance: 1.8,
        peakBalance: 1.8,
        maxDrawdownPct: 45,
        now: 1_000,
        lastMiniCooldownEnd: 0,
        lastLossCooldownEnd: 0,
        circuitBreakerActive: false,
      });

      expect(result.canTrade).toBe(false);
      expect(result.shouldTriggerFlightToSafety).toBe(true);
    });
  });

  describe("Circuit Breaker - Daily Loss Limits", () => {
    it("uses the micro daily loss limit when the start balance is below 0.10 SOL", () => {
      const result = evaluateCircuitBreakerDecision({
        isBtcCrash: false,
        dailyPnlSol: 0,
        unrealizedPnlSol: -0.02,
        dailyStartBalance: 0.05,
        dailyLossLimitPct: 15,
        microDailyLossLimitPct: 30,
        effectiveBalance: 0.05,
        peakBalance: 0.05,
        maxDrawdownPct: 45,
        now: 1_000,
        lastMiniCooldownEnd: 0,
        lastLossCooldownEnd: 0,
        circuitBreakerActive: false,
      });

      expect(result.canTrade).toBe(false);
      expect(result.reason).toBe("DAILY_LOSS_LIMIT (40.0% >= 30%)");
      expect(result.effectiveDailyLossLimitPct).toBe(30);
      expect(result.dailyLossPct).toBeCloseTo(40);
    });

    it("uses standard daily loss limit when balance is above 0.10 SOL", () => {
      const result = evaluateCircuitBreakerDecision({
        isBtcCrash: false,
        dailyPnlSol: -0.2,
        unrealizedPnlSol: 0,
        dailyStartBalance: 1,
        dailyLossLimitPct: 15,
        microDailyLossLimitPct: 30,
        effectiveBalance: 0.8,
        peakBalance: 1,
        maxDrawdownPct: 45,
        now: 1_000,
        lastMiniCooldownEnd: 0,
        lastLossCooldownEnd: 0,
        circuitBreakerActive: false,
      });

      expect(result.canTrade).toBe(false);
      expect(result.reason).toBe("DAILY_LOSS_LIMIT (20.0% >= 15%)");
      expect(result.effectiveDailyLossLimitPct).toBe(15);
    });

    it("allows trading when daily loss is below limit", () => {
      const result = evaluateCircuitBreakerDecision({
        isBtcCrash: false,
        dailyPnlSol: -0.1,
        unrealizedPnlSol: 0,
        dailyStartBalance: 1,
        dailyLossLimitPct: 15,
        microDailyLossLimitPct: 30,
        effectiveBalance: 0.9,
        peakBalance: 1,
        maxDrawdownPct: 45,
        now: 1_000,
        lastMiniCooldownEnd: 0,
        lastLossCooldownEnd: 0,
        circuitBreakerActive: false,
      });

      expect(result.canTrade).toBe(true);
      expect(result.reason).toBe("OK");
    });

    it("calculates daily loss correctly with both realized and unrealized PnL", () => {
      const result = evaluateCircuitBreakerDecision({
        isBtcCrash: false,
        dailyPnlSol: -0.15,
        unrealizedPnlSol: -0.05,
        dailyStartBalance: 1,
        dailyLossLimitPct: 15,
        microDailyLossLimitPct: 30,
        effectiveBalance: 0.8,
        peakBalance: 1,
        maxDrawdownPct: 45,
        now: 1_000,
        lastMiniCooldownEnd: 0,
        lastLossCooldownEnd: 0,
        circuitBreakerActive: false,
      });

      expect(result.canTrade).toBe(false);
      expect(result.dailyLossPct).toBeCloseTo(20);
    });
  });

  describe("Circuit Breaker - Max Drawdown", () => {
    it("blocks trading when drawdown reaches the configured max", () => {
      const result = evaluateCircuitBreakerDecision({
        isBtcCrash: false,
        dailyPnlSol: 0,
        unrealizedPnlSol: 0,
        dailyStartBalance: 1,
        dailyLossLimitPct: 15,
        microDailyLossLimitPct: 30,
        effectiveBalance: 0.5,
        peakBalance: 1,
        maxDrawdownPct: 45,
        now: 1_000,
        lastMiniCooldownEnd: 0,
        lastLossCooldownEnd: 0,
        circuitBreakerActive: false,
      });

      expect(result).toMatchObject({
        canTrade: false,
        reason: "MAX_DRAWDOWN (50.0% >= 45%)",
        shouldActivateCircuitBreaker: true,
        shouldTriggerFlightToSafety: true,
      });
    });

    it("updates peak balance when current balance exceeds it", () => {
      const result = evaluateCircuitBreakerDecision({
        isBtcCrash: false,
        dailyPnlSol: 0,
        unrealizedPnlSol: 0,
        dailyStartBalance: 1,
        dailyLossLimitPct: 15,
        microDailyLossLimitPct: 30,
        effectiveBalance: 1.5,
        peakBalance: 1,
        maxDrawdownPct: 45,
        now: 1_000,
        lastMiniCooldownEnd: 0,
        lastLossCooldownEnd: 0,
        circuitBreakerActive: false,
      });

      expect(result.nextPeakBalance).toBe(1.5);
      expect(result.canTrade).toBe(true);
    });

    it("allows trading when drawdown is below limit", () => {
      const result = evaluateCircuitBreakerDecision({
        isBtcCrash: false,
        dailyPnlSol: 0,
        unrealizedPnlSol: 0,
        dailyStartBalance: 1,
        dailyLossLimitPct: 15,
        microDailyLossLimitPct: 30,
        effectiveBalance: 0.9,
        peakBalance: 1,
        maxDrawdownPct: 45,
        now: 1_000,
        lastMiniCooldownEnd: 0,
        lastLossCooldownEnd: 0,
        circuitBreakerActive: false,
      });

      expect(result.canTrade).toBe(true);
      expect(result.drawdownPct).toBeCloseTo(10);
    });
  });

  describe("Circuit Breaker - Cooldowns", () => {
    it("keeps the cooldown active but clears an already-triggered breaker when conditions recover", () => {
      const result = evaluateCircuitBreakerDecision({
        isBtcCrash: false,
        dailyPnlSol: 0,
        unrealizedPnlSol: 0,
        dailyStartBalance: 1,
        dailyLossLimitPct: 15,
        microDailyLossLimitPct: 30,
        effectiveBalance: 1,
        peakBalance: 1,
        maxDrawdownPct: 45,
        now: 1_000,
        lastMiniCooldownEnd: 5_000,
        lastLossCooldownEnd: 0,
        circuitBreakerActive: true,
      });

      expect(result).toMatchObject({
        canTrade: false,
        reason: "MINI_LOSS_COOLDOWN (4s remaining — 2 consecutive losses)",
        shouldClearCircuitBreaker: true,
        shouldReturnFromSafety: true,
        shouldActivateCircuitBreaker: false,
      });
    });

    it("blocks trading during loss cooldown period", () => {
      const result = evaluateCircuitBreakerDecision({
        isBtcCrash: false,
        dailyPnlSol: 0,
        unrealizedPnlSol: 0,
        dailyStartBalance: 1,
        dailyLossLimitPct: 15,
        microDailyLossLimitPct: 30,
        effectiveBalance: 1,
        peakBalance: 1,
        maxDrawdownPct: 45,
        now: 1_000,
        lastMiniCooldownEnd: 0,
        lastLossCooldownEnd: 10_000,
        circuitBreakerActive: true,
      });

      expect(result.canTrade).toBe(false);
      expect(result.reason).toContain("LOSS_COOLDOWN");
      expect(result.shouldClearCircuitBreaker).toBe(true);
    });

    it("allows trading after cooldown period expires", () => {
      const result = evaluateCircuitBreakerDecision({
        isBtcCrash: false,
        dailyPnlSol: 0,
        unrealizedPnlSol: 0,
        dailyStartBalance: 1,
        dailyLossLimitPct: 15,
        microDailyLossLimitPct: 30,
        effectiveBalance: 1,
        peakBalance: 1,
        maxDrawdownPct: 45,
        now: 20_000,
        lastMiniCooldownEnd: 0,
        lastLossCooldownEnd: 10_000,
        circuitBreakerActive: true,
      });

      expect(result.canTrade).toBe(true);
      expect(result.shouldClearCircuitBreaker).toBe(true);
      expect(result.shouldReturnFromSafety).toBe(true);
    });
  });

  describe("Pre-Buy Risk Policy - Exposure Limits", () => {
    it("blocks over-allocation before a new buy is admitted", () => {
      const result = evaluatePreBuyRiskPolicy({
        totalPortfolioSol: 1,
        totalExposureSol: 0.9,
        candidateSizeSol: 0.1,
        maxPositionSizeSol: 0.015,
        entrySlippagePct: 2,
        entryFeePct: 1,
        minViableTradeSol: 0.001,
        isLiveBuy: false,
        walletBalanceSol: null,
        reservedCapitalSol: 0,
        liveSlippagePct: 2,
        minFeeBufferSol: 0.004,
      });

      expect(result.allowed).toBe(false);
      expect(result.reason).toBe("MAX_TOTAL_EXPOSURE_REACHED");
      expect(result.maxTotalExposureSol).toBeCloseTo(0.95);
    });

    it("calculates max total exposure as max of 10x position size and 95% portfolio", () => {
      const result = evaluatePreBuyRiskPolicy({
        totalPortfolioSol: 10,
        totalExposureSol: 8,
        candidateSizeSol: 0.1,
        maxPositionSizeSol: 0.015,
        entrySlippagePct: 2,
        entryFeePct: 1,
        minViableTradeSol: 0.001,
        isLiveBuy: false,
        walletBalanceSol: null,
        reservedCapitalSol: 0,
        liveSlippagePct: 2,
        minFeeBufferSol: 0.004,
      });

      expect(result.maxTotalExposureSol).toBeCloseTo(9.5);
    });

    it("allows trade when total exposure is within limits", () => {
      const result = evaluatePreBuyRiskPolicy({
        totalPortfolioSol: 1,
        totalExposureSol: 0.5,
        candidateSizeSol: 0.1,
        maxPositionSizeSol: 0.015,
        entrySlippagePct: 2,
        entryFeePct: 1,
        minViableTradeSol: 0.001,
        isLiveBuy: false,
        walletBalanceSol: null,
        reservedCapitalSol: 0,
        liveSlippagePct: 2,
        minFeeBufferSol: 0.004,
      });

      expect(result.allowed).toBe(true);
    });
  });

  describe("Pre-Buy Risk Policy - Trade Size Validation", () => {
    it("blocks trades that are too small after fees", () => {
      const result = evaluatePreBuyRiskPolicy({
        totalPortfolioSol: 1,
        totalExposureSol: 0,
        candidateSizeSol: 0.0005,
        maxPositionSizeSol: 0.015,
        entrySlippagePct: 2,
        entryFeePct: 1,
        minViableTradeSol: 0.001,
        isLiveBuy: false,
        walletBalanceSol: null,
        reservedCapitalSol: 0,
        liveSlippagePct: 2,
        minFeeBufferSol: 0.004,
      });

      expect(result.allowed).toBe(false);
      expect(result.reason).toBe("TRADE_TOO_SMALL_AFTER_FEES");
    });

    it("calculates entry total cost with slippage and fees", () => {
      const result = evaluatePreBuyRiskPolicy({
        totalPortfolioSol: 1,
        totalExposureSol: 0,
        candidateSizeSol: 0.01,
        maxPositionSizeSol: 0.015,
        entrySlippagePct: 2,
        entryFeePct: 1,
        minViableTradeSol: 0.001,
        isLiveBuy: false,
        walletBalanceSol: null,
        reservedCapitalSol: 0,
        liveSlippagePct: 2,
        minFeeBufferSol: 0.004,
      });

      expect(result.entryTotalCostSol).toBeCloseTo(0.0103);
    });
  });

  describe("Pre-Buy Risk Policy - Live Buy Safety", () => {
    it("blocks live buys that would use unsafe balance after reserve and max slippage", () => {
      const result = evaluatePreBuyRiskPolicy({
        totalPortfolioSol: 1,
        totalExposureSol: 0.1,
        candidateSizeSol: 0.04,
        maxPositionSizeSol: 0.015,
        entrySlippagePct: 1,
        entryFeePct: 1,
        minViableTradeSol: 0.001,
        isLiveBuy: true,
        walletBalanceSol: 0.05,
        reservedCapitalSol: 0.01,
        liveSlippagePct: 10,
        minFeeBufferSol: 0.004,
      });

      expect(result.allowed).toBe(false);
      expect(result.reason).toBe("UNSAFE_BALANCE_FOR_MAX_SPEND");
      expect(result.safeBalanceSol).toBeCloseTo(0.04);
      expect(result.maxPossibleSpendSol).toBeCloseTo(0.048);
    });

    it("allows live buys with sufficient safe balance", () => {
      const result = evaluatePreBuyRiskPolicy({
        totalPortfolioSol: 1,
        totalExposureSol: 0.1,
        candidateSizeSol: 0.01,
        maxPositionSizeSol: 0.015,
        entrySlippagePct: 1,
        entryFeePct: 1,
        minViableTradeSol: 0.001,
        isLiveBuy: true,
        walletBalanceSol: 0.1,
        reservedCapitalSol: 0.01,
        liveSlippagePct: 10,
        minFeeBufferSol: 0.004,
      });

      expect(result.allowed).toBe(true);
      expect(result.safeBalanceSol).toBeCloseTo(0.09);
    });

    it("calculates max possible spend with live slippage and fee buffer", () => {
      const result = evaluatePreBuyRiskPolicy({
        totalPortfolioSol: 1,
        totalExposureSol: 0,
        candidateSizeSol: 0.01,
        maxPositionSizeSol: 0.015,
        entrySlippagePct: 1,
        entryFeePct: 1,
        minViableTradeSol: 0.001,
        isLiveBuy: true,
        walletBalanceSol: 0.1,
        reservedCapitalSol: 0.01,
        liveSlippagePct: 5,
        minFeeBufferSol: 0.004,
      });

      expect(result.maxPossibleSpendSol).toBeCloseTo(0.0149);
    });
  });

  describe("Pre-Buy Risk Policy - Paper Trading", () => {
    it("allows paper trades without balance checks", () => {
      const result = evaluatePreBuyRiskPolicy({
        totalPortfolioSol: 1,
        totalExposureSol: 0.5,
        candidateSizeSol: 0.1,
        maxPositionSizeSol: 0.015,
        entrySlippagePct: 2,
        entryFeePct: 1,
        minViableTradeSol: 0.001,
        isLiveBuy: false,
        walletBalanceSol: null,
        reservedCapitalSol: 0,
        liveSlippagePct: 2,
        minFeeBufferSol: 0.004,
      });

      expect(result.allowed).toBe(true);
      expect(result.safeBalanceSol).toBeNull();
      expect(result.maxPossibleSpendSol).toBeNull();
    });
  });

  describe("Pre-Buy Risk Policy - Entry Cost Guard", () => {
    it("blocks trade when entry slippage + fee exceed default 15% max", () => {
      const result = evaluatePreBuyRiskPolicy({
        totalPortfolioSol: 1,
        totalExposureSol: 0,
        candidateSizeSol: 0.01,
        maxPositionSizeSol: 0.015,
        entrySlippagePct: 12,
        entryFeePct: 4,
        minViableTradeSol: 0.001,
        isLiveBuy: false,
        walletBalanceSol: null,
        reservedCapitalSol: 0,
        liveSlippagePct: 12,
        minFeeBufferSol: 0.004,
      });

      expect(result.allowed).toBe(false);
      expect(result.reason).toBe("ENTRY_COST_TOO_HIGH(16.0%>15%)");
    });

    it("allows trade when entry cost is within default 15% max", () => {
      const result = evaluatePreBuyRiskPolicy({
        totalPortfolioSol: 1,
        totalExposureSol: 0,
        candidateSizeSol: 0.01,
        maxPositionSizeSol: 0.015,
        entrySlippagePct: 10,
        entryFeePct: 4,
        minViableTradeSol: 0.001,
        isLiveBuy: false,
        walletBalanceSol: null,
        reservedCapitalSol: 0,
        liveSlippagePct: 10,
        minFeeBufferSol: 0.004,
      });

      // 10 + 4 = 14% <= 15% — passes default
      expect(result.allowed).toBe(true);
    });

    it("respects custom maxEntryCostPct override", () => {
      const result = evaluatePreBuyRiskPolicy({
        totalPortfolioSol: 1,
        totalExposureSol: 0,
        candidateSizeSol: 0.01,
        maxPositionSizeSol: 0.015,
        entrySlippagePct: 8,
        entryFeePct: 3,
        minViableTradeSol: 0.001,
        isLiveBuy: false,
        walletBalanceSol: null,
        reservedCapitalSol: 0,
        liveSlippagePct: 8,
        minFeeBufferSol: 0.004,
        maxEntryCostPct: 10,
      });

      // 8 + 3 = 11% > 10% — blocked by custom threshold
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe("ENTRY_COST_TOO_HIGH(11.0%>10%)");
    });

    it("passes when entry cost exactly equals maxEntryCostPct", () => {
      const result = evaluatePreBuyRiskPolicy({
        totalPortfolioSol: 1,
        totalExposureSol: 0,
        candidateSizeSol: 0.01,
        maxPositionSizeSol: 0.015,
        entrySlippagePct: 9,
        entryFeePct: 6,
        minViableTradeSol: 0.001,
        isLiveBuy: false,
        walletBalanceSol: null,
        reservedCapitalSol: 0,
        liveSlippagePct: 9,
        minFeeBufferSol: 0.004,
        maxEntryCostPct: 15,
      });

      // 9 + 6 = 15% exactly — equal to max, passes
      expect(result.allowed).toBe(true);
    });
  });

  describe("Momentum Circuit Breaker", () => {
    const now = 1_700_000_000_000;
    const TEN_MINUTES = 10 * 60 * 1000;
    const FIVE_MINUTES = 5 * 60 * 1000;
    const THIRTY_MINUTES = 30 * 60 * 1000;

    function makeTrade(pnlSol: number, msAgo: number): RecentTrade {
      return { timestamp: now - msAgo, pnlSol };
    }

    const defaultInput = {
      now,
      lossCooldownWindowMs: TEN_MINUTES,
      streak3PauseMs: FIVE_MINUTES,
      streak5PauseMs: THIRTY_MINUTES,
    };

    it("allows trading with no recent trades", () => {
      const result = evaluateMomentumCircuitBreaker({ ...defaultInput, recentTrades: [] });
      expect(result.canTrade).toBe(true);
      expect(result.streakLength).toBe(0);
    });

    it("allows trading after 2 consecutive losses (below threshold)", () => {
      const trades: RecentTrade[] = [
        makeTrade(-0.01, 1 * 60 * 1000),
        makeTrade(-0.01, 3 * 60 * 1000),
      ];
      const result = evaluateMomentumCircuitBreaker({ ...defaultInput, recentTrades: trades });
      expect(result.canTrade).toBe(true);
      expect(result.streakLength).toBe(2);
    });

    it("blocks trading after 3 consecutive losses (5-min pause)", () => {
      const trades: RecentTrade[] = [
        makeTrade(-0.01, 30 * 1000),   // 30s ago
        makeTrade(-0.01, 2 * 60 * 1000),
        makeTrade(-0.01, 4 * 60 * 1000),
      ];
      const result = evaluateMomentumCircuitBreaker({ ...defaultInput, recentTrades: trades });
      expect(result.canTrade).toBe(false);
      expect(result.reason).toContain("MOMENTUM_CIRCUIT_BREAKER_3STREAK");
      expect(result.streakLength).toBe(3);
    });

    it("blocks trading after 5 consecutive losses (30-min pause)", () => {
      const trades: RecentTrade[] = [
        makeTrade(-0.01, 30 * 1000),
        makeTrade(-0.01, 2 * 60 * 1000),
        makeTrade(-0.01, 4 * 60 * 1000),
        makeTrade(-0.01, 5 * 60 * 1000),
        makeTrade(-0.01, 7 * 60 * 1000),
      ];
      const result = evaluateMomentumCircuitBreaker({ ...defaultInput, recentTrades: trades });
      expect(result.canTrade).toBe(false);
      expect(result.reason).toContain("MOMENTUM_CIRCUIT_BREAKER_5STREAK");
      expect(result.streakLength).toBe(5);
    });

    it("resets streak on a single win (no block after win + 2 losses)", () => {
      const trades: RecentTrade[] = [
        makeTrade(-0.01, 1 * 60 * 1000),  // loss
        makeTrade(-0.01, 2 * 60 * 1000),  // loss
        makeTrade(+0.05, 3 * 60 * 1000),  // WIN — resets streak
        makeTrade(-0.01, 5 * 60 * 1000),  // loss
        makeTrade(-0.01, 7 * 60 * 1000),  // loss
      ];
      const result = evaluateMomentumCircuitBreaker({ ...defaultInput, recentTrades: trades });
      expect(result.canTrade).toBe(true);
      expect(result.streakLength).toBe(2); // only the 2 losses AFTER the win count
    });

    it("ignores losses older than the rolling window", () => {
      const trades: RecentTrade[] = [
        makeTrade(-0.01, 11 * 60 * 1000), // 11 min ago — OUTSIDE window
        makeTrade(-0.01, 12 * 60 * 1000), // 12 min ago — OUTSIDE window
        makeTrade(-0.01, 13 * 60 * 1000), // 13 min ago — OUTSIDE window
        makeTrade(-0.01, 14 * 60 * 1000), // 14 min ago — OUTSIDE window
        makeTrade(-0.01, 15 * 60 * 1000), // 15 min ago — OUTSIDE window
      ];
      // 5 losses but all >10 min ago — should NOT trigger
      const result = evaluateMomentumCircuitBreaker({ ...defaultInput, recentTrades: trades });
      expect(result.canTrade).toBe(true);
      expect(result.streakLength).toBe(0);
    });

    it("includes resumeAt timestamp that is in the future when blocked", () => {
      const trades: RecentTrade[] = [
        makeTrade(-0.01, 30 * 1000),
        makeTrade(-0.01, 2 * 60 * 1000),
        makeTrade(-0.01, 4 * 60 * 1000),
      ];
      const result = evaluateMomentumCircuitBreaker({ ...defaultInput, recentTrades: trades });
      expect(result.resumeAt).toBeGreaterThan(now);
    });

    it("allows trading after the pause period expires", () => {
      // Losses happened 6 min ago — 5-min pause has expired
      const sixMinAgo = 6 * 60 * 1000;
      const trades: RecentTrade[] = [
        makeTrade(-0.01, sixMinAgo),
        makeTrade(-0.01, sixMinAgo + 60_000),
        makeTrade(-0.01, sixMinAgo + 120_000),
      ];
      const result = evaluateMomentumCircuitBreaker({ ...defaultInput, recentTrades: trades });
      expect(result.canTrade).toBe(true);
    });
  });
});
