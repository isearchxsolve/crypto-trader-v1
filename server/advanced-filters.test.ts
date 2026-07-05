import { describe, expect, it } from "vitest";

import {
  evaluateHolderConcentration,
  evaluateDevDrainRisk,
  evaluateWashTradeRisk,
  type HolderAccount,
  type DevTransaction,
} from "./advanced-filters-pure";

// ─────────────────────────────────────────────────────────────────────────────
// HOLDER CONCENTRATION TESTS
// ─────────────────────────────────────────────────────────────────────────────

describe("advanced-filters", () => {
  describe("evaluateHolderConcentration", () => {
    function makeAccounts(amounts: number[], totalSupply: number): HolderAccount[] {
      return amounts.map((amount, i) => ({
        address: `wallet${i}`,
        amount,
        uiAmount: amount / 1e6,
      }));
    }

    it("blocks token where top-1 holder owns > 5%", () => {
      const accounts = makeAccounts([60_000_000, 20_000_000, 10_000_000], 1_000_000_000);
      const result = evaluateHolderConcentration(accounts, 1_000_000_000);

      expect(result.safe).toBe(false);
      expect(result.reason).toContain("top1_concentration");
      expect(result.top1Pct).toBeCloseTo(6, 0);
    });

    it("allows token where top-1 holder owns exactly 5%", () => {
      const accounts = makeAccounts([50_000_000, 20_000_000, 10_000_000], 1_000_000_000);
      const result = evaluateHolderConcentration(accounts, 1_000_000_000);

      expect(result.safe).toBe(true);
    });

    it("blocks token where top-5 holders own > 20%", () => {
      // 5 wallets each owning 5% = 25% total
      const amounts = [50_000_000, 50_000_000, 50_000_000, 50_000_000, 50_000_000];
      const accounts = makeAccounts(amounts, 1_000_000_000);
      const result = evaluateHolderConcentration(accounts, 1_000_000_000);

      expect(result.safe).toBe(false);
      expect(result.reason).toContain("top5_concentration");
      expect(result.top5Pct).toBeCloseTo(25, 0);
    });

    it("allows token where top-5 holders own exactly 20%", () => {
      // 5 wallets each owning 4% = 20% total
      const amounts = [40_000_000, 40_000_000, 40_000_000, 40_000_000, 40_000_000];
      const accounts = makeAccounts(amounts, 1_000_000_000);
      const result = evaluateHolderConcentration(accounts, 1_000_000_000);

      expect(result.safe).toBe(true);
    });

    it("blocks token where top-10 holders own > 35%", () => {
      // 10 wallets each owning 4% = 40% total
      const amounts = Array(10).fill(40_000_000);
      const accounts = makeAccounts(amounts, 1_000_000_000);
      const result = evaluateHolderConcentration(accounts, 1_000_000_000);

      expect(result.safe).toBe(false);
      expect(result.reason).toContain("top10_concentration");
      expect(result.top10Pct).toBeCloseTo(40, 0);
    });

    it("allows token where top-10 holders own exactly 35%", () => {
      // 10 wallets each owning 3.5% = 35% total
      const amounts = Array(10).fill(35_000_000);
      const accounts = makeAccounts(amounts, 1_000_000_000);
      const result = evaluateHolderConcentration(accounts, 1_000_000_000);

      expect(result.safe).toBe(true);
    });

    it("blocks on top-1 violation before checking top-5", () => {
      // top-1 = 10% (fails top-1), top-5 = 15% (would pass top-5)
      const accounts = makeAccounts([100_000_000, 10_000_000, 10_000_000, 10_000_000, 10_000_000], 1_000_000_000);
      const result = evaluateHolderConcentration(accounts, 1_000_000_000);

      expect(result.safe).toBe(false);
      expect(result.reason).toContain("top1_concentration");
    });

    it("returns safe for cleanly distributed token", () => {
      // 20 wallets each owning 1% = nicely distributed
      const amounts = Array(20).fill(10_000_000);
      const accounts = makeAccounts(amounts, 1_000_000_000);
      const result = evaluateHolderConcentration(accounts, 1_000_000_000);

      expect(result.safe).toBe(true);
      expect(result.reason).toBe("holder_concentration_ok");
    });

    it("handles empty accounts gracefully", () => {
      const result = evaluateHolderConcentration([], 1_000_000_000);
      expect(result.safe).toBe(true);
    });

    it("handles zero total supply gracefully", () => {
      const accounts = [{ address: "wallet0", amount: 100, uiAmount: 100 }];
      const result = evaluateHolderConcentration(accounts, 0);
      expect(result.safe).toBe(true); // Can't compute meaningful pct
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // DEV DRAIN RISK TESTS
  // ─────────────────────────────────────────────────────────────────────────────

  describe("evaluateDevDrainRisk", () => {
    const now = 1_700_000_000_000; // arbitrary fixed timestamp
    const THIRTY_MINUTES = 30 * 60 * 1000;

    function makeTx(
      type: "sell" | "buy" | "transfer_out",
      amountUsd: number,
      msAgo: number
    ): DevTransaction {
      return {
        type,
        amountUsd,
        timestamp: now - msAgo,
        signature: `sig_${msAgo}`,
      };
    }

    it("flags dev drain when large sells within 30 minutes", () => {
      const txs: DevTransaction[] = [
        makeTx("sell", 5_000, 5 * 60 * 1000),  // $5K sell 5 min ago
        makeTx("sell", 3_000, 12 * 60 * 1000), // $3K sell 12 min ago
      ];
      const result = evaluateDevDrainRisk(txs, now);

      expect(result.draining).toBe(true);
      expect(result.reason).toContain("dev_drain_risk");
      expect(result.totalSoldUsd).toBeGreaterThan(5_000);
    });

    it("does NOT flag dev drain for sells older than 30 minutes", () => {
      const txs: DevTransaction[] = [
        makeTx("sell", 10_000, 35 * 60 * 1000), // $10K sell 35 min ago — outside window
      ];
      const result = evaluateDevDrainRisk(txs, now);

      expect(result.draining).toBe(false);
    });

    it("does NOT flag drain for small sells (below $1000 threshold)", () => {
      const txs: DevTransaction[] = [
        makeTx("sell", 500, 5 * 60 * 1000), // only $500 — minor
      ];
      const result = evaluateDevDrainRisk(txs, now);

      expect(result.draining).toBe(false);
    });

    it("flags transfer_out as drain risk when large amount", () => {
      const txs: DevTransaction[] = [
        makeTx("transfer_out", 8_000, 10 * 60 * 1000),
      ];
      const result = evaluateDevDrainRisk(txs, now);

      expect(result.draining).toBe(true);
      expect(result.reason).toContain("dev_drain_risk");
    });

    it("does NOT flag buys as drain", () => {
      const txs: DevTransaction[] = [
        makeTx("buy", 50_000, 5 * 60 * 1000), // massive buy — dev is bullish
      ];
      const result = evaluateDevDrainRisk(txs, now);

      expect(result.draining).toBe(false);
    });

    it("handles empty transaction list gracefully", () => {
      const result = evaluateDevDrainRisk([], now);
      expect(result.draining).toBe(false);
      expect(result.totalSoldUsd).toBe(0);
    });

    it("accumulates multiple sells within the window", () => {
      const txs: DevTransaction[] = [
        makeTx("sell", 1_500, 2 * 60 * 1000),
        makeTx("sell", 2_000, 8 * 60 * 1000),
        makeTx("sell", 1_800, 15 * 60 * 1000),
      ];
      const result = evaluateDevDrainRisk(txs, now);

      expect(result.draining).toBe(true);
      expect(result.totalSoldUsd).toBeCloseTo(5_300, 0);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // WASH TRADE RISK TESTS
  // ─────────────────────────────────────────────────────────────────────────────

  describe("evaluateWashTradeRisk", () => {
    it("flags wash trading when vol/liq ratio > 10x within 5 min", () => {
      const result = evaluateWashTradeRisk({
        vol5m: 100_000,   // $100K in 5 min
        liquidityUsd: 8_000, // only $8K liquidity
        vol24h: 500_000,
      });

      expect(result.suspicious).toBe(true);
      expect(result.reason).toContain("vol_liq_ratio");
      expect(result.ratio).toBeGreaterThan(10);
    });

    it("does NOT flag when vol/liq ratio is healthy (< 5x)", () => {
      const result = evaluateWashTradeRisk({
        vol5m: 20_000,
        liquidityUsd: 50_000,
        vol24h: 200_000,
      });

      expect(result.suspicious).toBe(false);
    });

    it("flags when 5m volume is impossibly high relative to 24h", () => {
      // 5m vol is 80% of 24h vol — physically impossible for organic trading
      const result = evaluateWashTradeRisk({
        vol5m: 400_000,
        liquidityUsd: 500_000,  // liq is fine
        vol24h: 500_000,
      });

      expect(result.suspicious).toBe(true);
      expect(result.reason).toContain("impossible_5m_vol");
    });

    it("allows when 5m volume is a reasonable % of 24h", () => {
      // 5m = 5% of 24h is very normal during a pump
      const result = evaluateWashTradeRisk({
        vol5m: 25_000,
        liquidityUsd: 100_000,
        vol24h: 500_000,
      });

      expect(result.suspicious).toBe(false);
    });

    it("handles zero liquidity gracefully", () => {
      const result = evaluateWashTradeRisk({
        vol5m: 10_000,
        liquidityUsd: 0,
        vol24h: 100_000,
      });

      // With 0 liquidity, ratio is infinite — should flag
      expect(result.suspicious).toBe(true);
    });

    it("handles zero volume gracefully", () => {
      const result = evaluateWashTradeRisk({
        vol5m: 0,
        liquidityUsd: 50_000,
        vol24h: 0,
      });

      expect(result.suspicious).toBe(false);
    });
  });
});
