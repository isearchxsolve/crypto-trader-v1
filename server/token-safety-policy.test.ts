import { describe, expect, it } from "vitest";

import {
  evaluateTokenSafetyPreflight,
  evaluateTokenSafetySummaryDecision,
} from "./token-safety-policy";

describe("token-safety-policy", () => {
  describe("Token Safety Preflight - Liquidity Checks", () => {
    it("blocks new entries below the configured liquidity floor before any network call", () => {
      const result = evaluateTokenSafetyPreflight({
        checksEnabled: true,
        now: 10_000,
        entryMinLiquidityUsd: 25_000,
        liquidityUsd: 12_000,
        m5Sells: 5,
        pairCreatedAt: 0,
      });

      expect(result).toEqual({
        safe: false,
        reason: "liquidity_below_entry_floor($12000 < $25000)",
      });
    });

    it("allows tokens above the liquidity floor", () => {
      const result = evaluateTokenSafetyPreflight({
        checksEnabled: true,
        now: 10_000,
        entryMinLiquidityUsd: 25_000,
        liquidityUsd: 50_000,
        m5Sells: 5,
        pairCreatedAt: 10_000, // age = 0s, minSells = 2
      });

      expect(result).toBeNull();
    });

    it("passes when checks are disabled", () => {
      const result = evaluateTokenSafetyPreflight({
        checksEnabled: false,
        now: 10_000,
        entryMinLiquidityUsd: 25_000,
        liquidityUsd: 12_000,
        m5Sells: 5,
        pairCreatedAt: 0,
      });

      expect(result).toEqual({
        safe: true,
        reason: "checks_disabled",
      });
    });
  });

  describe("Token Safety Preflight - Sell Activity Checks", () => {
    it("blocks tokens with insufficient sell activity for very new tokens (< 2 minutes)", () => {
      const result = evaluateTokenSafetyPreflight({
        checksEnabled: true,
        now: Date.now(),
        entryMinLiquidityUsd: 25_000,
        liquidityUsd: 50_000,
        m5Sells: 1,
        pairCreatedAt: Date.now() - 60_000, // 1 minute old
      });

      expect(result).toEqual({
        safe: false,
        reason: "insufficient_sell_activity_honeypot_risk(1/4@60s)",
      });
    });

    it("requires more sells for tokens 2-5 minutes old", () => {
      const result = evaluateTokenSafetyPreflight({
        checksEnabled: true,
        now: Date.now(),
        entryMinLiquidityUsd: 25_000,
        liquidityUsd: 50_000,
        m5Sells: 3,
        pairCreatedAt: Date.now() - 180_000, // 3 minutes old
      });

      expect(result).toEqual({
        safe: false,
        reason: "insufficient_sell_activity_honeypot_risk(3/5@180s)",
      });
    });

    it("requires even more sells for tokens 5-15 minutes old", () => {
      const result = evaluateTokenSafetyPreflight({
        checksEnabled: true,
        now: Date.now(),
        entryMinLiquidityUsd: 25_000,
        liquidityUsd: 50_000,
        m5Sells: 5,
        pairCreatedAt: Date.now() - 600_000, // 10 minutes old
      });

      expect(result).toEqual({
        safe: false,
        reason: "insufficient_sell_activity_honeypot_risk(5/8@600s)",
      });
    });

    it("allows tokens with sufficient sell activity for their age", () => {
      const result = evaluateTokenSafetyPreflight({
        checksEnabled: true,
        now: Date.now(),
        entryMinLiquidityUsd: 25_000,
        liquidityUsd: 50_000,
        m5Sells: 12,
        pairCreatedAt: Date.now() - 600_000, // 10 minutes old
      });

      expect(result).toBeNull();
    });

    it("treats missing/null pairCreatedAt as unknown age (99999s)", () => {
      const result = evaluateTokenSafetyPreflight({
        checksEnabled: true,
        now: Date.now(),
        entryMinLiquidityUsd: 25_000,
        liquidityUsd: 50_000,
        m5Sells: 1,
        pairCreatedAt: undefined as any,
      });

      expect(result).toEqual({
        safe: false,
        reason: "insufficient_sell_activity_honeypot_risk(1/10@99999s)",
      });
    });
  });

  describe("Token Safety Summary - Freeze Authority", () => {
    it("hard-vetoes tokens with freeze authority active via risk flag", () => {
      const result = evaluateTokenSafetySummaryDecision({
        scoreNormalised: 30,
        rugcheckMaxRiskNormalised: 65,
        risks: [{ name: "Freeze Authority" }],
        tradingMode: "live",
        goldTier: null,
        goldSingleHolderPaperProbeEnabled: true,
        lpRelaxGateReason: null,
        token: {},
        tokenMeta: {},
      });

      expect(result.safe).toBe(false);
      expect(result.reason).toBe("freeze_authority_active_honeypot_risk");
      expect(result.freezeAuthorityActive).toBe(true);
    });

    it("detects freeze authority from token metadata", () => {
      const result = evaluateTokenSafetySummaryDecision({
        scoreNormalised: 30,
        rugcheckMaxRiskNormalised: 65,
        risks: [],
        tradingMode: "live",
        goldTier: null,
        goldSingleHolderPaperProbeEnabled: true,
        lpRelaxGateReason: null,
        token: { freezeAuthority: "some-authority-address" },
        tokenMeta: {},
      });

      expect(result.safe).toBe(false);
      expect(result.freezeAuthorityActive).toBe(true);
    });

    it("detects freeze authority from tokenMeta", () => {
      const result = evaluateTokenSafetySummaryDecision({
        scoreNormalised: 30,
        rugcheckMaxRiskNormalised: 65,
        risks: [],
        tradingMode: "live",
        goldTier: null,
        goldSingleHolderPaperProbeEnabled: true,
        lpRelaxGateReason: null,
        token: {},
        tokenMeta: { freezeAuthority: "some-authority-address" },
      });

      expect(result.safe).toBe(false);
      expect(result.freezeAuthorityActive).toBe(true);
    });

    it("ignores null authority (revoked freeze authority)", () => {
      const result = evaluateTokenSafetySummaryDecision({
        scoreNormalised: 30,
        rugcheckMaxRiskNormalised: 65,
        risks: [],
        tradingMode: "live",
        goldTier: null,
        goldSingleHolderPaperProbeEnabled: true,
        lpRelaxGateReason: null,
        token: { freezeAuthority: "11111111111111111111111111111111" },
        tokenMeta: {},
      });

      expect(result.freezeAuthorityActive).toBe(false);
    });
  });

  describe("Token Safety Summary - Mint Authority", () => {
    it("detects mint authority from risk flags but doesn't veto (only freeze authority vetoes)", () => {
      const result = evaluateTokenSafetySummaryDecision({
        scoreNormalised: 30,
        rugcheckMaxRiskNormalised: 65,
        risks: [{ name: "Mint Authority" }],
        tradingMode: "live",
        goldTier: null,
        goldSingleHolderPaperProbeEnabled: true,
        lpRelaxGateReason: null,
        token: {},
        tokenMeta: {},
      });

      expect(result.safe).toBe(true);
      expect(result.mintAuthorityActive).toBe(true);
    });

    it("detects mint authority from token metadata", () => {
      const result = evaluateTokenSafetySummaryDecision({
        scoreNormalised: 30,
        rugcheckMaxRiskNormalised: 65,
        risks: [],
        tradingMode: "live",
        goldTier: null,
        goldSingleHolderPaperProbeEnabled: true,
        lpRelaxGateReason: null,
        token: { mintAuthority: "some-authority-address" },
        tokenMeta: {},
      });

      expect(result.mintAuthorityActive).toBe(true);
    });

    it("ignores null authority (revoked mint authority)", () => {
      const result = evaluateTokenSafetySummaryDecision({
        scoreNormalised: 30,
        rugcheckMaxRiskNormalised: 65,
        risks: [],
        tradingMode: "live",
        goldTier: null,
        goldSingleHolderPaperProbeEnabled: true,
        lpRelaxGateReason: null,
        token: { mintAuthority: "11111111111111111111111111111111" },
        tokenMeta: {},
      });

      expect(result.mintAuthorityActive).toBe(false);
    });
  });

  describe("Token Safety Summary - LP Risks", () => {
    it("hard-vetoes a token with a literal LP unlocked risk flag", () => {
      const result = evaluateTokenSafetySummaryDecision({
        scoreNormalised: 30,
        rugcheckMaxRiskNormalised: 65,
        risks: [{ name: "LP Unlocked" }],
        tradingMode: "live",
        goldTier: null,
        goldSingleHolderPaperProbeEnabled: true,
        lpRelaxGateReason: null,
        token: {},
        tokenMeta: {},
      });

      expect(result.safe).toBe(false);
      expect(result.reason).toBe("rugcheck_veto_lp_unlocked");
      expect(result.vetoRiskName).toBe("LP Unlocked");
    });

    it("vetoes single holder ownership risk in live mode", () => {
      const result = evaluateTokenSafetySummaryDecision({
        scoreNormalised: 30,
        rugcheckMaxRiskNormalised: 65,
        risks: [{ name: "Single Holder Ownership" }],
        tradingMode: "live",
        goldTier: null,
        goldSingleHolderPaperProbeEnabled: true,
        lpRelaxGateReason: null,
        token: {},
        tokenMeta: {},
      });

      expect(result.safe).toBe(false);
      expect(result.reason).toBe("rugcheck_veto_single_holder_ownership");
    });

    it("allows large amount of LP unlocked in paper mode", () => {
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

    it("vetoes large amount of LP unlocked in live mode", () => {
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

  describe("Token Safety Summary - Gold Tier Exception", () => {
    it("allows single holder ownership for LEGENDARY gold tier in paper mode with probe enabled", () => {
      const result = evaluateTokenSafetySummaryDecision({
        scoreNormalised: 30,
        rugcheckMaxRiskNormalised: 65,
        risks: [{ name: "Single Holder Ownership" }],
        tradingMode: "paper",
        goldTier: "LEGENDARY",
        goldSingleHolderPaperProbeEnabled: true,
        lpRelaxGateReason: null,
        token: {},
        tokenMeta: {},
      });

      expect(result.safe).toBe(true);
    });

    it("does not allow single holder ownership when probe is disabled", () => {
      const result = evaluateTokenSafetySummaryDecision({
        scoreNormalised: 30,
        rugcheckMaxRiskNormalised: 65,
        risks: [{ name: "Single Holder Ownership" }],
        tradingMode: "paper",
        goldTier: "LEGENDARY",
        goldSingleHolderPaperProbeEnabled: false,
        lpRelaxGateReason: null,
        token: {},
        tokenMeta: {},
      });

      expect(result.safe).toBe(false);
    });

    it("does not allow single holder ownership in live mode even with gold tier", () => {
      const result = evaluateTokenSafetySummaryDecision({
        scoreNormalised: 30,
        rugcheckMaxRiskNormalised: 65,
        risks: [{ name: "Single Holder Ownership" }],
        tradingMode: "live",
        goldTier: "LEGENDARY",
        goldSingleHolderPaperProbeEnabled: true,
        lpRelaxGateReason: null,
        token: {},
        tokenMeta: {},
      });

      expect(result.safe).toBe(false);
    });

    it("vetoes single holder ownership when combined with LP unlocked risk", () => {
      const result = evaluateTokenSafetySummaryDecision({
        scoreNormalised: 30,
        rugcheckMaxRiskNormalised: 65,
        risks: [
          { name: "Single Holder Ownership" },
          { name: "LP Unlocked" }
        ],
        tradingMode: "paper",
        goldTier: "LEGENDARY",
        goldSingleHolderPaperProbeEnabled: true,
        lpRelaxGateReason: null,
        token: {},
        tokenMeta: {},
      });

      expect(result.safe).toBe(false);
    });
  });

  describe("Token Safety Summary - LP Relax Gate", () => {
    it("fails closed when the unlocked-LP discriminator produces a veto reason", () => {
      const result = evaluateTokenSafetySummaryDecision({
        scoreNormalised: 30,
        rugcheckMaxRiskNormalised: 65,
        risks: [],
        tradingMode: "paper",
        goldTier: null,
        goldSingleHolderPaperProbeEnabled: true,
        lpRelaxGateReason: "lp_unlocked_no_safety_data(whaleBlind,concUnavailable,firstSighting)",
        token: {},
        tokenMeta: {},
      });

      expect(result.safe).toBe(false);
      expect(result.reason).toBe("lp_unlocked_no_safety_data(whaleBlind,concUnavailable,firstSighting)");
    });

    it("passes when lpRelaxGateReason is null", () => {
      const result = evaluateTokenSafetySummaryDecision({
        scoreNormalised: 30,
        rugcheckMaxRiskNormalised: 65,
        risks: [],
        tradingMode: "paper",
        goldTier: null,
        goldSingleHolderPaperProbeEnabled: true,
        lpRelaxGateReason: null,
        token: {},
        tokenMeta: {},
      });

      expect(result.safe).toBe(true);
    });
  });

  describe("Token Safety Summary - Risk Score", () => {
    it("blocks tokens with risk score above threshold", () => {
      const result = evaluateTokenSafetySummaryDecision({
        scoreNormalised: 70,
        rugcheckMaxRiskNormalised: 65,
        risks: [],
        tradingMode: "paper",
        goldTier: null,
        goldSingleHolderPaperProbeEnabled: true,
        lpRelaxGateReason: null,
        token: {},
        tokenMeta: {},
      });

      expect(result.safe).toBe(false);
      expect(result.reason).toBe("rugcheck_risk_high(norm=70)");
    });

    it("allows tokens with risk score below threshold", () => {
      const result = evaluateTokenSafetySummaryDecision({
        scoreNormalised: 50,
        rugcheckMaxRiskNormalised: 65,
        risks: [],
        tradingMode: "paper",
        goldTier: null,
        goldSingleHolderPaperProbeEnabled: true,
        lpRelaxGateReason: null,
        token: {},
        tokenMeta: {},
      });

      expect(result.safe).toBe(true);
    });

    it("allows tokens with null risk score", () => {
      const result = evaluateTokenSafetySummaryDecision({
        scoreNormalised: null,
        rugcheckMaxRiskNormalised: 65,
        risks: [],
        tradingMode: "paper",
        goldTier: null,
        goldSingleHolderPaperProbeEnabled: true,
        lpRelaxGateReason: null,
        token: {},
        tokenMeta: {},
      });

      expect(result.safe).toBe(true);
    });
  });

  describe("Token Safety Summary - Clean Tokens", () => {
    it("passes a clean token with acceptable risk score", () => {
      const result = evaluateTokenSafetySummaryDecision({
        scoreNormalised: 50,
        rugcheckMaxRiskNormalised: 65,
        risks: [],
        tradingMode: "paper",
        goldTier: null,
        goldSingleHolderPaperProbeEnabled: true,
        lpRelaxGateReason: null,
        token: {},
        tokenMeta: {},
      });

      expect(result).toMatchObject({
        safe: true,
        reason: "ok",
        freezeAuthorityActive: false,
        mintAuthorityActive: false,
      });
    });

    it("passes a clean token with no risk score", () => {
      const result = evaluateTokenSafetySummaryDecision({
        scoreNormalised: null,
        rugcheckMaxRiskNormalised: 65,
        risks: [],
        tradingMode: "live",
        goldTier: null,
        goldSingleHolderPaperProbeEnabled: true,
        lpRelaxGateReason: null,
        token: {},
        tokenMeta: {},
      });

      expect(result).toMatchObject({
        safe: true,
        reason: "ok",
        freezeAuthorityActive: false,
        mintAuthorityActive: false,
        vetoRiskName: null,
      });
    });
  });
});
