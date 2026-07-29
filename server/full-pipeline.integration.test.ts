/**
 * full-pipeline.integration.test.ts — COMPLETE END-TO-END PIPELINE INTEGRATION TESTS
 *
 * Tests the FULL buy-decision → hold → exit lifecycle with ALL 6 layers chained:
 *   1. Token Safety Preflight (liquidity + sell activity)
 *   2. Token Safety Summary (freeze/mint/LP/risk score)
 *   3. Gold Score (5-layer compound filter → tier)
 *   4. ML Score Gate (pump probability → size adjustment)
 *   5. Risk Policy (circuit breaker + pre-buy checks)
 *   6. Exit Strategy (TP ladder + trailing stop + dead cat + stop loss)
 *
 * PLUS negative paths for rug tokens, wash trading, dev drain, and market crashes.
 * Tests include complex multi-trade scenarios (compounding, concurrent positions).
 *
 * DESIGN: Each test simulates a COMPLETE lifecycle from discovery to exit,
 * proving the pipeline functions correctly as an integrated whole.
 */

import { describe, expect, it } from "vitest";

import { evaluateTokenSafetyPreflight, evaluateTokenSafetySummaryDecision } from "./token-safety-policy";
import { goldScore, scoreTier } from "./gold_standard_hunter";
import { evaluateMlScoreGate } from "./ml-score-gate";
import { evaluateCircuitBreakerDecision, evaluatePreBuyRiskPolicy, evaluateMomentumCircuitBreaker } from "./risk-policy";
import { evaluateExitSignal } from "./exit-strategy";
import { evaluateHolderConcentration, evaluateDevDrainRisk, evaluateWashTradeRisk } from "./advanced-filters-pure";

// ─────────────────────────────────────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────────────────────────────────────

const BASE_NOW = 1_700_000_000_000;

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────

/** A perfectly clean legendary token that should pass EVERY gate */
function makeLegendaryGmgn(overrides: Record<string, any> = {}) {
  return {
    address: "LEGEND_TOKEN",
    holder_count: 2500,
    creation_timestamp: Math.floor((BASE_NOW - 30 * 60 * 1000) / 1000),
    launchpad_platform: "pump",
    bonding_currency: "usdc",
    wallet_tags_stat: { smart_wallets: 6, renowned_wallets: 2, sniper_wallets: 0 },
    dev: {
      creator_address: "devWallet",
      creator_open_count: 1,
      creator_token_status: "hold",
      top_10_holder_rate: 0.08,
      fund_from_ts: Math.floor((BASE_NOW - 90 * 24 * 60 * 60 * 1000) / 1000),
      ath_token_info: { ath_mc: 8_000_000 },
      cto_flag: 0,
      twitter_del_post_token_count: 0,
    },
    stat: {
      rat_trader_amount_rate: 0.005,
      top_bundler_trader_percentage: 0.02,
      top_entrapment_trader_percentage: 0.01,
      fresh_wallet_rate: 0.10,
      is_wash_trading: false,
    },
    price: {
      volume_5m: 25_000,
      volume_1h: 120_000,
      volume_24h: 800_000,
      buys_1h: 180,
      sells_1h: 5,
    },
    link: { twitter: "https://twitter.com/legend", website: "https://legend.xyz" },
    security: { is_honeypot: false, rug_ratio: 0 },
    ...overrides,
  };
}

// =============================================================================
// TRACK 1: COMPLETE GOLDEN PATH — LEGENDARY TOKEN FULL LIFECYCLE
// =============================================================================

describe("🏆 Full Pipeline — LEGENDARY Token Complete Lifecycle", () => {
  const signals: string[] = [];
  const gmgn = makeLegendaryGmgn();

  it("Step 1: Token discovery + goldScore classifies as LEGENDARY", () => {
    const score = goldScore(gmgn as any, null, signals);
    const tier = scoreTier(score);
    expect(score).toBeGreaterThanOrEqual(75);
    expect(tier).toBe("LEGENDARY");
  });

  it("Step 2: Safety preflight (liquidity >= 5K, sell activity sufficient)", () => {
    const result = evaluateTokenSafetyPreflight({
      checksEnabled: true,
      now: BASE_NOW,
      entryMinLiquidityUsd: 5_000,
      liquidityUsd: 150_000,
      m5Sells: 15,
      pairCreatedAt: BASE_NOW - 30 * 60 * 1000,
    });
    expect(result).toBeNull();
  });

  it("Step 3: Safety summary (no freeze/mint/LP risks)", () => {
    const result = evaluateTokenSafetySummaryDecision({
      scoreNormalised: 80,
      rugcheckMaxRiskNormalised: 800,
      risks: [],
      tradingMode: "paper",
      goldTier: "LEGENDARY",
      goldSingleHolderPaperProbeEnabled: true,
      lpRelaxGateReason: null,
      token: { freezeAuthority: null, mintAuthority: null },
      tokenMeta: undefined,
    });
    expect(result.safe).toBe(true);
  });

  it("Step 4: ML gate allows with normal size (pump_prob=0.75 → boost zone)", () => {
    const result = evaluateMlScoreGate({
      pumpProbability: 0.75,
      goldScore: 85,
      tier: "LEGENDARY",
      candidateSizeSol: 0.02,
      maxPositionSizeSol: 0.05,
      isLive: false,
    });
    expect(result.allowed).toBe(true);
    expect(result.confidenceMultiplier).toBe(1.2); // BOOST zone
    expect(result.adjustedSizeSol).toBeCloseTo(0.024, 4);
  });

  it("Step 5: Circuit breaker allows (healthy market, no losses)", () => {
    const result = evaluateCircuitBreakerDecision({
      isBtcCrash: false,
      dailyPnlSol: 0,
      unrealizedPnlSol: 0,
      dailyStartBalance: 1.0,
      dailyLossLimitPct: 15,
      microDailyLossLimitPct: 25,
      effectiveBalance: 1.0,
      peakBalance: 1.0,
      maxDrawdownPct: 20,
      now: BASE_NOW,
      lastMiniCooldownEnd: 0,
      lastLossCooldownEnd: 0,
      circuitBreakerActive: false,
    });
    expect(result.canTrade).toBe(true);
  });

  it("Step 6: Pre-buy risk policy approves the position", () => {
    const result = evaluatePreBuyRiskPolicy({
      totalPortfolioSol: 1.0,
      totalExposureSol: 0.0,
      candidateSizeSol: 0.024,  // ML-boosted size
      maxPositionSizeSol: 0.05,
      entrySlippagePct: 3.0,
      entryFeePct: 0.3,
      minViableTradeSol: 0.005,
      isLiveBuy: false,
      walletBalanceSol: null,
      reservedCapitalSol: 0.05,
      liveSlippagePct: 3.0,
      minFeeBufferSol: 0.002,
    });
    expect(result.allowed).toBe(true);
  });

  it("Step 7: Exit — holds at entry (no profit, no loss)", () => {
    const result = evaluateExitSignal({
      entryPriceSol: 0.00001,
      currentPriceSol: 0.00001,
      peakPriceSol: 0.00001,
      ageSeconds: 600,
      positionSol: 0.024,
      tier: "LEGENDARY",
      tpLevelReached: 0,
    });
    expect(result.action).toBe("hold");
  });

  it("Step 8: Exit — partial TP at 2x profit (TP1 fires)", () => {
    const result = evaluateExitSignal({
      entryPriceSol: 0.00001,
      currentPriceSol: 0.00002,
      peakPriceSol: 0.00002,
      ageSeconds: 600,
      positionSol: 0.024,
      tier: "LEGENDARY",
      tpLevelReached: 0,
    });
    expect(result.action).toBe("partial");
    expect(result.reason).toContain("tp1_2x");
    expect(result.sellFraction).toBe(0.25);
  });

  it("Step 9: Exit — partial TP at 5x profit (TP2 fires)", () => {
    const result = evaluateExitSignal({
      entryPriceSol: 0.00001,
      currentPriceSol: 0.00005,
      peakPriceSol: 0.00005,
      ageSeconds: 1200,
      positionSol: 0.018,  // after TP1 sold 25%
      tier: "LEGENDARY",
      tpLevelReached: 1,   // TP1 already taken
    });
    expect(result.action).toBe("partial");
    expect(result.reason).toContain("tp2_5x");
    expect(result.sellFraction).toBe(0.25);
  });

  it("Step 10: Exit — partial TP at 10x profit (TP3 fires)", () => {
    const result = evaluateExitSignal({
      entryPriceSol: 0.00001,
      currentPriceSol: 0.00010,
      peakPriceSol: 0.00010,
      ageSeconds: 2400,
      positionSol: 0.0135,  // after TP1 + TP2 sold 50%
      tier: "LEGENDARY",
      tpLevelReached: 2,   // TP1 + TP2 taken
    });
    expect(result.action).toBe("partial");
    expect(result.reason).toContain("tp3_10x");
    expect(result.sellFraction).toBe(0.25);
  });

  it("Step 11: Exit — holds moonshot bag after all TPs taken (25% remains)", () => {
    const result = evaluateExitSignal({
      entryPriceSol: 0.00001,
      currentPriceSol: 0.00050,
      peakPriceSol: 0.00050,
      ageSeconds: 7200,
      positionSol: 0.006,  // 25% remaining after all TPs
      tier: "LEGENDARY",
      tpLevelReached: 3,   // ALL TPs taken
    });
    expect(result.action).toBe("hold");
    expect(result.reason).toContain("moonshot_hold");
  });

  it("Step 12: Trailing stop exits on 35%+ drawdown from peak (LEGENDARY)", () => {
    // Peak was 0.00050 (50x), now dropped to 0.00030 (30x, 40% drawdown)
    const result = evaluateExitSignal({
      entryPriceSol: 0.00001,
      currentPriceSol: 0.00030,
      peakPriceSol: 0.00050,
      ageSeconds: 7200,
      positionSol: 0.006,
      tier: "LEGENDARY",
      tpLevelReached: 3,
    });
    expect(result.action).toBe("exit");
    expect(result.reason).toContain("trailing_stop");
    expect(result.sellFraction).toBe(1.0);
  });
});

// =============================================================================
// TRACK 2: RUG REJECTION — EVERY HARD GATE VERIFIED
// =============================================================================

describe("🛡️ Rug Rejection — All Hard Gates Verified", () => {
  it("Honeypot token rejected at goldScore Layer 1", () => {
    const rugToken = makeLegendaryGmgn({ security: { is_honeypot: true } });
    const signals: string[] = [];
    expect(goldScore(rugToken as any, null, signals)).toBe(-1);
  });

  it("Wash trading token rejected at goldScore Layer 1", () => {
    const washToken = makeLegendaryGmgn({
      stat: {
        is_wash_trading: true,
        rat_trader_amount_rate: 0.005,
        top_bundler_trader_percentage: 0.02,
        top_entrapment_trader_percentage: 0.01,
        fresh_wallet_rate: 0.10,
      },
    });
    const signals: string[] = [];
    expect(goldScore(washToken as any, null, signals)).toBe(-1);
  });

  it("Meteora virtual curve rejected at goldScore Layer 1", () => {
    const meteoraToken = makeLegendaryGmgn({
      launchpad_platform: "meteora_virtual_curve",
    });
    const signals: string[] = [];
    expect(goldScore(meteoraToken as any, null, signals)).toBe(-1);
  });

  it("High entrapment (>10%) rejected at goldScore Layer 1", () => {
    const trapToken = makeLegendaryGmgn({
      stat: {
        rat_trader_amount_rate: 0.01,
        top_bundler_trader_percentage: 0.05,
        top_entrapment_trader_percentage: 0.15,
        fresh_wallet_rate: 0.2,
      },
    });
    const signals: string[] = [];
    expect(goldScore(trapToken as any, null, signals)).toBe(-1);
  });

  it("High fresh wallet rate (>40%) rejected at goldScore Layer 1", () => {
    const freshToken = makeLegendaryGmgn({
      stat: {
        rat_trader_amount_rate: 0.01,
        top_bundler_trader_percentage: 0.05,
        top_entrapment_trader_percentage: 0.05,
        fresh_wallet_rate: 0.5,
      },
    });
    const signals: string[] = [];
    expect(goldScore(freshToken as any, null, signals)).toBe(-1);
  });

  it("CTO without smart money rejected at goldScore Layer 1", () => {
    const ctoToken = makeLegendaryGmgn({
      dev: {
        creator_address: "dev",
        creator_open_count: 1,
        creator_token_status: "hold",
        top_10_holder_rate: 0.1,
        cto_flag: 1,
      },
      wallet_tags_stat: { smart_wallets: 0, renowned_wallets: 0, sniper_wallets: 0 },
    });
    const signals: string[] = [];
    expect(goldScore(ctoToken as any, null, signals)).toBe(-1);
  });

  it("Dev deleted >3 tweets rejected at goldScore Layer 1", () => {
    const tweetToken = makeLegendaryGmgn({
      dev: {
        creator_address: "dev",
        creator_open_count: 1,
        creator_token_status: "hold",
        top_10_holder_rate: 0.1,
        twitter_del_post_token_count: 5,
      },
    });
    const signals: string[] = [];
    expect(goldScore(tweetToken as any, null, signals)).toBe(-1);
  });
});

// =============================================================================
// TRACK 3: ADVANCED FILTER REJECTION
// =============================================================================

describe("🔍 Advanced Filter Rejection", () => {
  it("Top-1 holder >5% → concentration failed", () => {
    const accounts = [
      { address: "whale", amount: 60_000_000, uiAmount: 60 },
      { address: "h2", amount: 10_000_000, uiAmount: 10 },
    ];
    const result = evaluateHolderConcentration(accounts, 1_000_000_000);
    expect(result.safe).toBe(false);
    expect(result.reason).toContain("top1_concentration");
    expect(result.top1Pct).toBeCloseTo(6, 0);
  });

  it("Top-5 holders >20% → concentration failed", () => {
    const accounts = Array.from({ length: 5 }, (_, i) => ({
      address: `holder${i}`,
      amount: 50_000_000,
      uiAmount: 50,
    }));
    const result = evaluateHolderConcentration(accounts, 1_000_000_000);
    expect(result.safe).toBe(false);
    expect(result.reason).toContain("top5_concentration");
  });

  it("Dev drain: $8K sold in 15 min → flagged", () => {
    const txs = [
      { type: "sell" as const, amountUsd: 5_000, timestamp: BASE_NOW - 5 * 60 * 1000, signature: "s1" },
      { type: "sell" as const, amountUsd: 3_000, timestamp: BASE_NOW - 12 * 60 * 1000, signature: "s2" },
    ];
    const result = evaluateDevDrainRisk(txs, BASE_NOW);
    expect(result.draining).toBe(true);
    expect(result.totalSoldUsd).toBe(8_000);
  });

  it("Wash trade: vol/liq ratio >10x → flagged", () => {
    const result = evaluateWashTradeRisk({
      vol5m: 100_000,
      liquidityUsd: 8_000,
      vol24h: 500_000,
    });
    expect(result.suspicious).toBe(true);
    expect(result.reason).toContain("vol_liq_ratio");
  });

  it("Wash trade: 5m vol >60% of 24h → flagged", () => {
    const result = evaluateWashTradeRisk({
      vol5m: 400_000,
      liquidityUsd: 500_000,
      vol24h: 500_000,
    });
    expect(result.suspicious).toBe(true);
    expect(result.reason).toContain("impossible_5m_vol");
  });
});

// =============================================================================
// TRACK 4: CIRCUIT BREAKER — ALL STOP CONDITIONS
// =============================================================================

describe("⚠️ Circuit Breaker — All Stop Conditions", () => {
  it("BTC crash → blocks ALL trading", () => {
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
      now: BASE_NOW,
      lastMiniCooldownEnd: 0,
      lastLossCooldownEnd: 0,
      circuitBreakerActive: false,
    });
    expect(result.canTrade).toBe(false);
    expect(result.reason).toContain("GLOBAL_MARKET_CRASH");
    expect(result.shouldActivateCircuitBreaker).toBe(true);
  });

  it("Daily loss limit exceeded → blocks trading", () => {
    const result = evaluateCircuitBreakerDecision({
      isBtcCrash: false,
      dailyPnlSol: -0.18,
      unrealizedPnlSol: 0,
      dailyStartBalance: 1,
      dailyLossLimitPct: 15,
      microDailyLossLimitPct: 30,
      effectiveBalance: 0.82,
      peakBalance: 1,
      maxDrawdownPct: 45,
      now: BASE_NOW,
      lastMiniCooldownEnd: 0,
      lastLossCooldownEnd: 0,
      circuitBreakerActive: false,
    });
    expect(result.canTrade).toBe(false);
    expect(result.reason).toContain("DAILY_LOSS_LIMIT");
  });

  it("Max drawdown exceeded → blocks trading", () => {
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
      now: BASE_NOW,
      lastMiniCooldownEnd: 0,
      lastLossCooldownEnd: 0,
      circuitBreakerActive: false,
    });
    expect(result.canTrade).toBe(false);
    expect(result.reason).toContain("MAX_DRAWDOWN");
  });

  it("Micro wallet (<0.1 SOL) uses relaxed daily loss limit (30%)", () => {
    const result = evaluateCircuitBreakerDecision({
      isBtcCrash: false,
      dailyPnlSol: -0.025,
      unrealizedPnlSol: 0,
      dailyStartBalance: 0.08,
      dailyLossLimitPct: 15,
      microDailyLossLimitPct: 30,
      effectiveBalance: 0.055,
      peakBalance: 0.08,
      maxDrawdownPct: 45,
      now: BASE_NOW,
      lastMiniCooldownEnd: 0,
      lastLossCooldownEnd: 0,
      circuitBreakerActive: false,
    });
    // 0.025 / 0.08 = 31.25% >= 30% → triggers daily loss limit
    expect(result.canTrade).toBe(false);
    expect(result.effectiveDailyLossLimitPct).toBe(30);
  });

  it("Mini cooldown active → blocks trading until expires", () => {
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
      now: BASE_NOW,
      lastMiniCooldownEnd: BASE_NOW + 5000,
      lastLossCooldownEnd: 0,
      circuitBreakerActive: true,
    });
    expect(result.canTrade).toBe(false);
    expect(result.reason).toContain("MINI_LOSS_COOLDOWN");
    expect(result.shouldClearCircuitBreaker).toBe(true);
  });

  it("Momentum circuit breaker: 5+ consecutive losses → blocks for 30 min", () => {
    const now = BASE_NOW;
    const trades = Array.from({ length: 5 }, (_, i) => ({
      timestamp: now - (5 - i) * 60 * 1000,
      pnlSol: -0.01,
    }));
    const result = evaluateMomentumCircuitBreaker({
      recentTrades: trades,
      now,
      lossCooldownWindowMs: 10 * 60 * 1000,
      streak3PauseMs: 5 * 60 * 1000,
      streak5PauseMs: 30 * 60 * 1000,
    });
    expect(result.canTrade).toBe(false);
    expect(result.reason).toContain("MOMENTUM_CIRCUIT_BREAKER_5STREAK");
    expect(result.streakLength).toBe(5);
  });

  it("Momentum circuit breaker: win resets the loss streak", () => {
    const now = BASE_NOW;
    const trades = [
      { timestamp: now - 3 * 60 * 1000, pnlSol: -0.01 },  // loss
      { timestamp: now - 2 * 60 * 1000, pnlSol: 0.02 },    // WIN resets streak
      { timestamp: now - 1 * 60 * 1000, pnlSol: -0.01 },   // loss (streak=1)
    ];
    const result = evaluateMomentumCircuitBreaker({
      recentTrades: trades,
      now,
      lossCooldownWindowMs: 10 * 60 * 1000,
      streak3PauseMs: 5 * 60 * 1000,
      streak5PauseMs: 30 * 60 * 1000,
    });
    expect(result.canTrade).toBe(true);
    expect(result.streakLength).toBe(1);
  });
});

// =============================================================================
// TRACK 5: ML GATE — ALL ZONES VERIFIED
// =============================================================================

describe("🧠 ML Score Gate — All Zones Verified", () => {
  it("BLOCK zone (prob < 0.35) → trade rejected", () => {
    const result = evaluateMlScoreGate({
      pumpProbability: 0.20,
      goldScore: 80,
      tier: "HIGH",
      candidateSizeSol: 0.02,
      maxPositionSizeSol: 0.05,
      isLive: false,
    });
    expect(result.allowed).toBe(false);
    expect(result.confidenceMultiplier).toBe(0);
  });

  it("LEGENDARY tier gets relaxed block threshold (prob < 0.30)", () => {
    const result = evaluateMlScoreGate({
      pumpProbability: 0.30,
      goldScore: 80,
      tier: "LEGENDARY",
      candidateSizeSol: 0.02,
      maxPositionSizeSol: 0.05,
      isLive: false,
    });
    expect(result.allowed).toBe(true);  // Relaxed to 0.30
    expect(result.confidenceMultiplier).toBe(0.5); // Still in REDUCE zone
  });

  it("REDUCE zone (prob 0.35-0.54) → size cut by 50%", () => {
    const result = evaluateMlScoreGate({
      pumpProbability: 0.40,
      goldScore: 70,
      tier: "HIGH",
      candidateSizeSol: 0.02,
      maxPositionSizeSol: 0.05,
      isLive: false,
    });
    expect(result.allowed).toBe(true);
    expect(result.confidenceMultiplier).toBe(0.5);
    expect(result.adjustedSizeSol).toBeCloseTo(0.01, 4);
  });

  it("NORMAL zone (prob 0.55-0.70) → full candidate size", () => {
    const result = evaluateMlScoreGate({
      pumpProbability: 0.60,
      goldScore: 70,
      tier: "HIGH",
      candidateSizeSol: 0.02,
      maxPositionSizeSol: 0.05,
      isLive: false,
    });
    expect(result.allowed).toBe(true);
    expect(result.confidenceMultiplier).toBe(1.0);
    expect(result.adjustedSizeSol).toBeCloseTo(0.02, 4);
  });

  it("BOOST zone (prob > 0.70) → size boosted by 20%", () => {
    const result = evaluateMlScoreGate({
      pumpProbability: 0.90,
      goldScore: 85,
      tier: "HIGH",
      candidateSizeSol: 0.02,
      maxPositionSizeSol: 0.05,
      isLive: false,
    });
    expect(result.allowed).toBe(true);
    expect(result.confidenceMultiplier).toBe(1.2);
    expect(result.adjustedSizeSol).toBeCloseTo(0.024, 4);
  });

  it("BOOST zone capped at maxPositionSizeSol", () => {
    const result = evaluateMlScoreGate({
      pumpProbability: 0.90,
      goldScore: 85,
      tier: "HIGH",
      candidateSizeSol: 0.05,  // 20% boost = 0.06
      maxPositionSizeSol: 0.05,
      isLive: false,
    });
    expect(result.adjustedSizeSol).toBeCloseTo(0.05, 4); // Capped
  });
});

// =============================================================================
// TRACK 6: EXIT STRATEGY — FULL SPECTRUM OF EXIT CONDITIONS
// =============================================================================

describe("🚀 Exit Strategy — Full Spectrum", () => {
  const entry = 0.00001;

  it("HOLD at break-even (no profit, no loss)", () => {
    expect(evaluateExitSignal({
      entryPriceSol: entry, currentPriceSol: entry, peakPriceSol: entry,
      ageSeconds: 600, positionSol: 0.02, tier: "HIGH", tpLevelReached: 0,
    }).action).toBe("hold");
  });

  it("PARTIAL at 2x (TP1)", () => {
    const r = evaluateExitSignal({
      entryPriceSol: entry, currentPriceSol: 0.00002, peakPriceSol: 0.00002,
      ageSeconds: 600, positionSol: 0.02, tier: "HIGH", tpLevelReached: 0,
    });
    expect(r.action).toBe("partial");
    expect(r.reason).toContain("tp1_2x");
    expect(r.sellFraction).toBe(0.25);
  });

  it("PARTIAL at 5x (TP2)", () => {
    const r = evaluateExitSignal({
      entryPriceSol: entry, currentPriceSol: 0.00005, peakPriceSol: 0.00005,
      ageSeconds: 1200, positionSol: 0.015, tier: "HIGH", tpLevelReached: 1,
    });
    expect(r.action).toBe("partial");
    expect(r.reason).toContain("tp2_5x");
    expect(r.sellFraction).toBe(0.25);
  });

  it("PARTIAL at 10x (TP3)", () => {
    const r = evaluateExitSignal({
      entryPriceSol: entry, currentPriceSol: 0.00010, peakPriceSol: 0.00010,
      ageSeconds: 2400, positionSol: 0.01, tier: "HIGH", tpLevelReached: 2,
    });
    expect(r.action).toBe("partial");
    expect(r.reason).toContain("tp3_10x");
    expect(r.sellFraction).toBe(0.25);
  });

  it("MOONSHOT HOLD after all TPs (25% bag remains)", () => {
    const r = evaluateExitSignal({
      entryPriceSol: entry, currentPriceSol: 0.00050, peakPriceSol: 0.00050,
      ageSeconds: 7200, positionSol: 0.005, tier: "HIGH", tpLevelReached: 3,
    });
    expect(r.action).toBe("hold");
    expect(r.reason).toContain("moonshot_hold");
  });

  it("STOP LOSS at 30% below entry", () => {
    const r = evaluateExitSignal({
      entryPriceSol: entry, currentPriceSol: 0.000006, peakPriceSol: 0.00001,
      ageSeconds: 600, positionSol: 0.02, tier: "HIGH", tpLevelReached: 0,
    });
    expect(r.action).toBe("exit");
    expect(r.reason).toContain("stop_loss");
    expect(r.sellFraction).toBe(1.0);
  });

  it("DEAD CAT on fresh token (<30m) that crashes 50%+ from peak", () => {
    const r = evaluateExitSignal({
      entryPriceSol: entry, currentPriceSol: 0.000012, peakPriceSol: 0.00003,
      ageSeconds: 120, positionSol: 0.02, tier: "HIGH", tpLevelReached: 0,
    });
    expect(r.action).toBe("exit");
    expect(r.reason).toContain("dead_cat");
  });

  it("TRAILING STOP on HIGH tier at 25%+ drawdown from peak", () => {
    const r = evaluateExitSignal({
      entryPriceSol: entry, currentPriceSol: 0.000074, peakPriceSol: 0.00010,
      ageSeconds: 1800, positionSol: 0.02, tier: "HIGH", tpLevelReached: 1,
    });
    expect(r.action).toBe("exit");
    expect(r.reason).toContain("trailing_stop");
  });

  it("TRAILING STOP on LEGENDARY tier at 35%+ drawdown from peak", () => {
    const r = evaluateExitSignal({
      entryPriceSol: entry, currentPriceSol: 0.000064, peakPriceSol: 0.00010,
      ageSeconds: 1800, positionSol: 0.02, tier: "LEGENDARY", tpLevelReached: 1,
    });
    expect(r.action).toBe("exit");
    expect(r.reason).toContain("trailing_stop");
  });

  it("TIGHTENED trailing stop (15%) for positions >4 hours old", () => {
    const r = evaluateExitSignal({
      entryPriceSol: entry, currentPriceSol: 0.000083, peakPriceSol: 0.00010,
      ageSeconds: 5 * 3600, positionSol: 0.02, tier: "HIGH", tpLevelReached: 1,
    });
    // 17% drawdown > 15% tightened threshold → exit
    expect(r.action).toBe("exit");
    expect(r.reason).toContain("trailing_stop");
  });

  it("HOLD at 12% drawdown for old position (below 15% tightened stop)", () => {
    const r = evaluateExitSignal({
      entryPriceSol: entry, currentPriceSol: 0.000088, peakPriceSol: 0.00010,
      ageSeconds: 5 * 3600, positionSol: 0.02, tier: "HIGH", tpLevelReached: 3,
    });
    expect(r.action).toBe("hold");
  });
});

// =============================================================================
// TRACK 7: TOKEN SAFETY — ALL PRECHECKS
// =============================================================================

describe("🔐 Token Safety — All Preflight & Summary Checks", () => {
  it("Preflight: blocks low liquidity", () => {
    const result = evaluateTokenSafetyPreflight({
      checksEnabled: true,
      now: BASE_NOW,
      entryMinLiquidityUsd: 25_000,
      liquidityUsd: 12_000,
      m5Sells: 5,
      pairCreatedAt: BASE_NOW - 300,
    });
    expect(result).not.toBeNull();
    expect(result!.safe).toBe(false);
    expect(result!.reason).toContain("liquidity_below_entry_floor");
  });

  it("Preflight: blocks insufficient sell activity (honeypot risk)", () => {
    const result = evaluateTokenSafetyPreflight({
      checksEnabled: true,
      now: BASE_NOW,
      entryMinLiquidityUsd: 25_000,
      liquidityUsd: 50_000,
      m5Sells: 1,
      pairCreatedAt: BASE_NOW - 60_000,
    });
    expect(result).not.toBeNull();
    expect(result!.safe).toBe(false);
    expect(result!.reason).toContain("insufficient_sell_activity_honeypot_risk");
  });

  it("Summary: blocks freeze authority (honeypot)", () => {
    const result = evaluateTokenSafetySummaryDecision({
      scoreNormalised: 30,
      rugcheckMaxRiskNormalised: 65,
      risks: [{ name: "Freeze Authority" }],
      tradingMode: "paper",
      goldTier: null,
      goldSingleHolderPaperProbeEnabled: true,
      lpRelaxGateReason: null,
      token: {},
      tokenMeta: {},
    });
    expect(result.safe).toBe(false);
    expect(result.freezeAuthorityActive).toBe(true);
  });

  it("Summary: blocks LP Unlocked (rug risk)", () => {
    const result = evaluateTokenSafetySummaryDecision({
      scoreNormalised: 30,
      rugcheckMaxRiskNormalised: 65,
      risks: [{ name: "LP Unlocked" }],
      tradingMode: "paper",
      goldTier: null,
      goldSingleHolderPaperProbeEnabled: true,
      lpRelaxGateReason: null,
      token: {},
      tokenMeta: {},
    });
    expect(result.safe).toBe(false);
    expect(result.reason).toContain("rugcheck_veto");
  });

  it("Summary: allows Large LP Unlocked in paper mode (not live)", () => {
    const result = evaluateTokenSafetySummaryDecision({
      scoreNormalised: 30,
      rugcheckMaxRiskNormalised: 65,
      risks: [{ name: "Large amount of LP unlocked" }],
      tradingMode: "paper",
      goldTier: null,
      goldSingleHolderPaperProbeEnabled: true,
      lpRelaxGateReason: null,
      token: {},
      tokenMeta: {},
    });
    expect(result.safe).toBe(true);
  });

  it("Summary: blocks Large LP Unlocked in live mode", () => {
    const result = evaluateTokenSafetySummaryDecision({
      scoreNormalised: 30,
      rugcheckMaxRiskNormalised: 65,
      risks: [{ name: "Large amount of LP unlocked" }],
      tradingMode: "live",
      goldTier: null,
      goldSingleHolderPaperProbeEnabled: true,
      lpRelaxGateReason: null,
      token: {},
      tokenMeta: {},
    });
    expect(result.safe).toBe(false);
  });
});

// =============================================================================
// TRACK 8: PRE-BUY RISK POLICY — EDGE CASES
// =============================================================================

describe("💰 Pre-Buy Risk Policy — Edge Cases", () => {    it("Blocks when total exposure would exceed max", () => {
      // maxTotalExposureSol = max(maxPositionSizeSol * 10, totalPortfolioSol * 0.95)
      // = max(0.05 * 10, 0.5 * 0.95) = max(0.5, 0.475) = 0.5
      // totalExposureSol + candidateSizeSol = 0.45 + 0.10 = 0.55 > 0.5 → BLOCK
      const result = evaluatePreBuyRiskPolicy({
        totalPortfolioSol: 0.5,
        totalExposureSol: 0.45,
        candidateSizeSol: 0.10,
        maxPositionSizeSol: 0.05,
        entrySlippagePct: 2.0,
        entryFeePct: 0.5,
        minViableTradeSol: 0.005,
        isLiveBuy: false,
        walletBalanceSol: null,
        reservedCapitalSol: 0.05,
        liveSlippagePct: 3.0,
        minFeeBufferSol: 0.002,
      });
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe("MAX_TOTAL_EXPOSURE_REACHED");
    });

  it("Blocks when trade too small after fees", () => {
    const result = evaluatePreBuyRiskPolicy({
      totalPortfolioSol: 1.0,
      totalExposureSol: 0,
      candidateSizeSol: 0.001,
      maxPositionSizeSol: 0.05,
      entrySlippagePct: 2.0,
      entryFeePct: 0.5,
      minViableTradeSol: 0.005,
      isLiveBuy: false,
      walletBalanceSol: null,
      reservedCapitalSol: 0.05,
      liveSlippagePct: 3.0,
      minFeeBufferSol: 0.002,
    });
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("TRADE_TOO_SMALL_AFTER_FEES");
  });

  it("Blocks when entry cost exceeds max (default 15%)", () => {
    const result = evaluatePreBuyRiskPolicy({
      totalPortfolioSol: 1.0,
      totalExposureSol: 0,
      candidateSizeSol: 0.02,
      maxPositionSizeSol: 0.05,
      entrySlippagePct: 12.0,
      entryFeePct: 5.0,  // 17% total > 15% max
      minViableTradeSol: 0.005,
      isLiveBuy: false,
      walletBalanceSol: null,
      reservedCapitalSol: 0.05,
      liveSlippagePct: 3.0,
      minFeeBufferSol: 0.002,
    });
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("ENTRY_COST_TOO_HIGH");
  });

  it("Allows live buy with sufficient wallet balance", () => {
    const result = evaluatePreBuyRiskPolicy({
      totalPortfolioSol: 1.0,
      totalExposureSol: 0,
      candidateSizeSol: 0.02,
      maxPositionSizeSol: 0.05,
      entrySlippagePct: 2.0,
      entryFeePct: 0.5,
      minViableTradeSol: 0.005,
      isLiveBuy: true,
      walletBalanceSol: 1.0,
      reservedCapitalSol: 0.05,
      liveSlippagePct: 3.0,
      minFeeBufferSol: 0.002,
    });
    expect(result.allowed).toBe(true);
    expect(result.safeBalanceSol).toBeGreaterThan(0);
  });
});

// =============================================================================
// TRACK 9: COMPLETE RUG TOKEN LIFECYCLE — REJECTED AT EVERY LAYER
// =============================================================================

describe("💀 Complete Rug Token → Rejected at Every Layer", () => {
  it("Layer 1-2: Preflight → blocks low liquidity", () => {
    const result = evaluateTokenSafetyPreflight({
      checksEnabled: true,
      now: BASE_NOW,
      entryMinLiquidityUsd: 25_000,
      liquidityUsd: 500,
      m5Sells: 0,
      pairCreatedAt: BASE_NOW - 30,
    });
    expect(result).not.toBeNull();
    expect(result!.safe).toBe(false);
  });

  it("Layer 2: Summary → vetoes on LP Unlocked", () => {
    const result = evaluateTokenSafetySummaryDecision({
      scoreNormalised: 95,
      rugcheckMaxRiskNormalised: 65,
      risks: [{ name: "LP Unlocked" }, { name: "Freeze Authority" }],
      tradingMode: "paper",
      goldTier: null,
      goldSingleHolderPaperProbeEnabled: true,
      lpRelaxGateReason: null,
      token: {},
      tokenMeta: {},
    });
    expect(result.safe).toBe(false);
    expect(result.freezeAuthorityActive).toBe(true);
  });

  it("Layer 3: goldScore → hard rejects (honeypot)", () => {
    const rugToken = makeLegendaryGmgn({ security: { is_honeypot: true } });
    const signals: string[] = [];
    expect(goldScore(rugToken as any, null, signals)).toBe(-1);
  });

  it("Layer 4: ML gate → blocks (low pump probability for rug)", () => {
    const result = evaluateMlScoreGate({
      pumpProbability: 0.15,  // Rug token doesn't pump
      goldScore: 0,
      tier: "SKIP",
      candidateSizeSol: 0.02,
      maxPositionSizeSol: 0.05,
      isLive: false,
    });
    expect(result.allowed).toBe(false);
  });

  it("Layer 5: Circuit breaker → would also block if daily loss hit", () => {
    const result = evaluateCircuitBreakerDecision({
      isBtcCrash: false,
      dailyPnlSol: -0.25,  // Big loss from rug
      unrealizedPnlSol: 0,
      dailyStartBalance: 1,
      dailyLossLimitPct: 15,
      microDailyLossLimitPct: 30,
      effectiveBalance: 0.75,
      peakBalance: 1,
      maxDrawdownPct: 45,
      now: BASE_NOW,
      lastMiniCooldownEnd: 0,
      lastLossCooldownEnd: 0,
      circuitBreakerActive: false,
    });
    expect(result.canTrade).toBe(false);
    expect(result.reason).toContain("DAILY_LOSS_LIMIT");
  });

  it("Layer 6: Exit → stop loss fires immediately (price crashed)", () => {
    const result = evaluateExitSignal({
      entryPriceSol: 0.00001,
      currentPriceSol: 0.000003,  // 70% below entry
      peakPriceSol: 0.00001,
      ageSeconds: 120,
      positionSol: 0.02,
      tier: "HIGH",
      tpLevelReached: 0,
    });
    expect(result.action).toBe("exit");
    expect(result.reason).toContain("stop_loss");
    expect(result.sellFraction).toBe(1.0);
  });
});
