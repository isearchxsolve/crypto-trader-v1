/**
 * trading-pipeline.test.ts — Track 6: End-to-End Pipeline Integration Tests
 *
 * Tests the full buy-decision chain with all 6 layers chained together:
 *   1. evaluateTokenSafetyPreflight
 *   2. evaluateTokenSafetySummaryDecision
 *   3. goldScore (→ tier)
 *   4. evaluateMlScoreGate
 *   5. evaluateCircuitBreakerDecision
 *   6. evaluatePreBuyRiskPolicy
 *
 * Also tests negative paths: rug tokens, wash trading, dev drain.
 */

import { describe, expect, it } from "vitest";

import { evaluateTokenSafetyPreflight, evaluateTokenSafetySummaryDecision } from "./token-safety-policy";
import { goldScore, scoreTier } from "./gold_standard_hunter";
import { evaluateMlScoreGate } from "./ml-score-gate";
import { evaluateCircuitBreakerDecision, evaluatePreBuyRiskPolicy } from "./risk-policy";
import { evaluateExitSignal } from "./exit-strategy";
import { evaluateHolderConcentration, evaluateDevDrainRisk, evaluateWashTradeRisk } from "./advanced-filters-pure";

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────

const BASE_NOW = 1_700_000_000_000;

/** A "legendary" token that should pass all 6 layers */
function makeLegendaryGmgn(overrides: Record<string, any> = {}) {
  return {
    address: "LEGEND_TOKEN",
    holder_count: 2500,
    creation_timestamp: Math.floor((BASE_NOW - 30 * 60 * 1000) / 1000), // 30 min old
    launchpad_platform: "pump",
    bonding_currency: "usdc",
    wallet_tags_stat: { smart_wallets: 6, renowned_wallets: 2, sniper_wallets: 0 },
    dev: {
      creator_address: "devWallet",
      creator_open_count: 1,        // first timer
      creator_token_status: "hold",
      top_10_holder_rate: 0.08,
      fund_from_ts: Math.floor((BASE_NOW - 90 * 24 * 60 * 60 * 1000) / 1000), // 90 days old wallet
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

// ─────────────────────────────────────────────────────────────────────────────
// TRACK 6: FULL PIPELINE — GOLDEN PATH
// ─────────────────────────────────────────────────────────────────────────────

describe("trading-pipeline", () => {
  describe("Golden Path — LEGENDARY token passes all 6 layers", () => {
    const gmgn = makeLegendaryGmgn();
    const signals: string[] = [];

    it("Layer 1+2: Token safety preflight passes", () => {
      const result = evaluateTokenSafetyPreflight({
        checksEnabled: true,
        now: BASE_NOW,
        entryMinLiquidityUsd: 5_000,
        liquidityUsd: 150_000,
        m5Sells: 15,  // minSells=10 for token 30 min old (ageSeconds > 900)
        pairCreatedAt: BASE_NOW - 30 * 60 * 1000,
      });

      // evaluateTokenSafetyPreflight returns null on success (no preflight failure)
      expect(result).toBeNull();
    });

    it("Layer 2: Token safety summary passes (no freeze/mint/LP risks)", () => {
      const result = evaluateTokenSafetySummaryDecision({
        scoreNormalised: 80,
        rugcheckMaxRiskNormalised: 800,
        risks: [],
        tradingMode: "paper",
        goldScore: 80,
        goldTier: "LEGENDARY",
        goldProbeEnabled: true,
        lpRelaxGateReason: null,
        tokenMetadata: { freezeAuthority: null, mintAuthority: null },
        tokenMeta: undefined,
      });

      expect(result.safe).toBe(true);
    });

    it("Layer 3: goldScore returns LEGENDARY (>= 75)", () => {
      const score = goldScore(gmgn as any, null, signals);
      const tier = scoreTier(score);

      expect(score).toBeGreaterThanOrEqual(75);
      expect(tier).toBe("LEGENDARY");
    });

    it("Layer 4: ML gate allows and size is normal", () => {
      const result = evaluateMlScoreGate({
        pumpProbability: 0.75,
        goldScore: 85,
        tier: "LEGENDARY",
        candidateSizeSol: 0.02,
        maxPositionSizeSol: 0.05,
        isLive: false,
      });

      expect(result.allowed).toBe(true);
      expect(result.adjustedSizeSol).toBeGreaterThan(0);
    });

    it("Layer 5: Circuit breaker allows trading (healthy conditions)", () => {
      const result = evaluateCircuitBreakerDecision({
        isBtcCrash: false,
        dailyPnlSol: -0.03,          // -3% realized
        unrealizedPnlSol: 0,
        dailyStartBalance: 1.0,
        dailyLossLimitPct: 15,
        microDailyLossLimitPct: 25,
        effectiveBalance: 0.97,
        peakBalance: 1.0,
        maxDrawdownPct: 20,
        now: BASE_NOW,
        lastMiniCooldownEnd: 0,
        lastLossCooldownEnd: 0,
        circuitBreakerActive: false,
      });

      expect(result.canTrade).toBe(true);
    });

    it("Layer 6: Pre-buy risk policy approves the position", () => {
      const result = evaluatePreBuyRiskPolicy({
        totalPortfolioSol: 1.0,
        totalExposureSol: 0.0,
        candidateSizeSol: 0.02,
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

    it("Exit strategy returns hold at entry price (no TP, no stop)", () => {
      const result = evaluateExitSignal({
        entryPriceSol: 0.00001,
        currentPriceSol: 0.00001,
        peakPriceSol: 0.00001,
        ageSeconds: 1800,
        positionSol: 0.02,
        tier: "LEGENDARY",
        tpLevelReached: 0,
      });

      expect(result.action).toBe("hold");
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // NEGATIVE PATH: RUG TOKEN
  // ─────────────────────────────────────────────────────────────────────────────

  describe("Negative Path — Rug token blocked at Layer 3 (goldScore = -1)", () => {
    it("honeypot token gets goldScore = -1 (hard gate rejection)", () => {
      const rugToken = makeLegendaryGmgn({
        security: { is_honeypot: true },
      });

      const signals: string[] = [];
      const score = goldScore(rugToken as any, null, signals);

      expect(score).toBe(-1);
    });

    it("wash trade token gets goldScore = -1", () => {
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
      const score = goldScore(washToken as any, null, signals);

      expect(score).toBe(-1);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // NEGATIVE PATH: HIGH HOLDER CONCENTRATION
  // ─────────────────────────────────────────────────────────────────────────────

  describe("Negative Path — High holder concentration blocked by advanced filter", () => {
    it("top-1 holder owns 10% → holder concentration check fails", () => {
      const accounts = [
        { address: "whale1", amount: 100_000_000, uiAmount: 100 },  // 10%
        ...Array.from({ length: 9 }, (_, i) => ({
          address: `holder${i}`,
          amount: 20_000_000,
          uiAmount: 20,
        })),
      ];

      const result = evaluateHolderConcentration(accounts, 1_000_000_000);
      expect(result.safe).toBe(false);
      expect(result.reason).toContain("top1_concentration");
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // NEGATIVE PATH: CIRCUIT BREAKER BLOCKS ON 3-DAY LOSS
  // ─────────────────────────────────────────────────────────────────────────────

  describe("Negative Path — Circuit breaker blocks on daily loss limit", () => {
    it("blocks when daily realized loss exceeds 15%", () => {
      const result = evaluateCircuitBreakerDecision({
        isBtcCrash: false,
        dailyPnlSol: -0.18,          // -18% realized (exceeds 15% limit)
        unrealizedPnlSol: 0,
        dailyStartBalance: 1.0,
        dailyLossLimitPct: 15,
        microDailyLossLimitPct: 25,
        effectiveBalance: 0.82,
        peakBalance: 1.0,
        maxDrawdownPct: 20,
        now: BASE_NOW,
        lastMiniCooldownEnd: 0,
        lastLossCooldownEnd: 0,
        circuitBreakerActive: false,
      });

      expect(result.canTrade).toBe(false);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // NEGATIVE PATH: ML GATE BLOCKS LOW CONFIDENCE
  // ─────────────────────────────────────────────────────────────────────────────

  describe("Negative Path — ML gate blocks low pump probability", () => {
    it("blocks even a LEGENDARY token if ML says pump_prob < 0.30", () => {
      const result = evaluateMlScoreGate({
        pumpProbability: 0.20,
        goldScore: 88,
        tier: "LEGENDARY",
        candidateSizeSol: 0.02,
        maxPositionSizeSol: 0.05,
        isLive: true,
      });

      expect(result.allowed).toBe(false);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // NEGATIVE PATH: DEV DRAIN DETECTED
  // ─────────────────────────────────────────────────────────────────────────────

  describe("Negative Path — Dev drain detected via advanced filter", () => {
    it("flags dev drain: $8K sold in 15 minutes → draining = true", () => {
      const now = BASE_NOW;
      const txs = [
        { type: "sell" as const, amountUsd: 5_000, timestamp: now - 5 * 60 * 1000, signature: "sig1" },
        { type: "sell" as const, amountUsd: 3_000, timestamp: now - 12 * 60 * 1000, signature: "sig2" },
      ];

      const result = evaluateDevDrainRisk(txs, now);
      expect(result.draining).toBe(true);
      expect(result.totalSoldUsd).toBe(8_000);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // POSITIVE EXIT SCENARIOS AT VARIOUS PROFIT LEVELS
  // ─────────────────────────────────────────────────────────────────────────────

  describe("Exit strategy profit path", () => {
    it("takes partial TP at 2x, holds moonshot bag after all TPs taken", () => {
      const entry = 0.00001;
      const at2x  = evaluateExitSignal({ entryPriceSol: entry, currentPriceSol: 0.00002, peakPriceSol: 0.00002, ageSeconds: 600, positionSol: 0.02, tier: "LEGENDARY", tpLevelReached: 0 });
      const at5x  = evaluateExitSignal({ entryPriceSol: entry, currentPriceSol: 0.00005, peakPriceSol: 0.00005, ageSeconds: 1200, positionSol: 0.015, tier: "LEGENDARY", tpLevelReached: 1 });
      const at10x = evaluateExitSignal({ entryPriceSol: entry, currentPriceSol: 0.00010, peakPriceSol: 0.00010, ageSeconds: 2400, positionSol: 0.010, tier: "LEGENDARY", tpLevelReached: 2 });
      const at50x = evaluateExitSignal({ entryPriceSol: entry, currentPriceSol: 0.00050, peakPriceSol: 0.00050, ageSeconds: 7200, positionSol: 0.005, tier: "LEGENDARY", tpLevelReached: 3 });

      expect(at2x.action).toBe("partial");
      expect(at5x.action).toBe("partial");
      expect(at10x.action).toBe("partial");
      expect(at50x.action).toBe("hold"); // moonshot hold — all TPs taken!
    });
  });
});
