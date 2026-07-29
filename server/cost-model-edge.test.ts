// server/cost-model-edge.test.ts
// Deep edge-case coverage for calcTransactionCosts and calcCostAwareStopPrice.
import { describe, it, expect } from "vitest";

function calcTransactionCosts(liqUsd: number, sizeSol: number, solPriceUsd: number) {
  if (!solPriceUsd || solPriceUsd <= 0) return { entrySlippagePct: 0, exitSlippagePct: 0, entryFeePct: 0, exitFeePct: 0, totalRoundTripPct: 0 };
  const tradeValueUsd = sizeSol * solPriceUsd;
  const priceImpactPct = liqUsd > 0 ? Math.min(20, (tradeValueUsd / (liqUsd / 2)) * 100) : 10;
  const baseSlippage = liqUsd < 2000 ? 8 : liqUsd < 5000 ? 5 : liqUsd < 20000 ? 2.5 : 1.2;
  const mevEstimatePct = 1.5;
  const entrySlippagePct = Math.max(baseSlippage, priceImpactPct) + mevEstimatePct;
  const exitSlippagePct = (entrySlippagePct - mevEstimatePct) * 1.3 + mevEstimatePct;
  const feePct = 0;
  const totalRoundTripPct = entrySlippagePct + exitSlippagePct + feePct * 2;
  return { entrySlippagePct, exitSlippagePct, entryFeePct: feePct, exitFeePct: feePct, totalRoundTripPct };
}

function calcCostAwareStopPrice(entryPrice: number, liq: number, sizeSol: number, solPriceUsd: number, stopLossPct: number) {
  const costs = calcTransactionCosts(liq, sizeSol, solPriceUsd);
  const exitCostPct = costs.exitSlippagePct + costs.exitFeePct;
  const priceMoveTolerance = Math.max(Math.abs(stopLossPct), exitCostPct + 1);
  return entryPrice * (1 - priceMoveTolerance / 100);
}

const SOL = 180;

describe("calcTransactionCosts - zero NaN guards", () => {
  it("handles liq=0 without crashing", () => {
    const c = calcTransactionCosts(0, 0.01, SOL);
    expect(c.totalRoundTripPct).toBeGreaterThan(0);
    expect(isFinite(c.totalRoundTripPct)).toBe(true);
  });
  it("handles sizeSol=0 without crashing", () => {
    const c = calcTransactionCosts(10000, 0, SOL);
    expect(isFinite(c.totalRoundTripPct)).toBe(true);
  });
  it("handles solPriceUsd=0 without NaN", () => {
    const c = calcTransactionCosts(10000, 0.01, 0);
    expect(c.totalRoundTripPct).toBe(0);
  });
  it("handles negative liq without NaN", () => {
    const c = calcTransactionCosts(-100, 0.01, SOL);
    expect(isFinite(c.totalRoundTripPct)).toBe(true);
  });
  it("handles extreme sizeSol=100 SOL", () => {
    const c = calcTransactionCosts(5000, 100, SOL);
    expect(c.entrySlippagePct).toBeLessThanOrEqual(21.5);
    expect(isFinite(c.totalRoundTripPct)).toBe(true);
  });
});

describe("calcTransactionCosts - tier boundary precision", () => {
  const tests = [
    { liq: 1999, label: "just below 2k tier" },
    { liq: 2000, label: "exactly 2k tier" },
    { liq: 4999, label: "just below 5k tier" },
    { liq: 5000, label: "exactly 5k tier" },
    { liq: 19999, label: "just below 20k tier" },
    { liq: 20000, label: "exactly 20k tier" },
    { liq: 99999, label: "just below 100k tier" },
    { liq: 100000, label: "exactly 100k tier" },
  ];
  for (const t of tests) {
    it("liq=" + t.liq + " (" + t.label + ") no NaN", () => {
      const c = calcTransactionCosts(t.liq, 0.01, SOL);
      expect(isFinite(c.totalRoundTripPct)).toBe(true);
      expect(c.totalRoundTripPct).toBeGreaterThan(0);
      expect(c.entrySlippagePct).toBeGreaterThan(0);
      expect(c.exitSlippagePct).toBeGreaterThan(0);
    });
  }
  it("cost decreases monotonically as liq increases", () => {
    const liqs = [500, 1000, 2000, 5000, 10000, 20000, 50000, 100000, 500000];
    const costs = liqs.map(function(l) { return calcTransactionCosts(l, 0.01, SOL).totalRoundTripPct; });
    for (var i = 1; i < costs.length; i++) {
      expect(costs[i]).toBeLessThanOrEqual(costs[i - 1] + 0.01);
    }
  });
});

describe("calcTransactionCosts - extreme scenarios", () => {
  it("tiny liq (100) produces extreme cost", () => {
    const c = calcTransactionCosts(100, 0.001, SOL);
    expect(c.totalRoundTripPct).toBeGreaterThan(20);
  });
  it("massive liq (1M) has very low cost", () => {
    const c = calcTransactionCosts(1000000, 0.01, SOL);
    expect(c.totalRoundTripPct).toBeLessThan(6);
  });
  it("base slippage dominates at mid liq (3k)", () => {
    const c = calcTransactionCosts(3000, 0.005, SOL);
    expect(c.totalRoundTripPct).toBeGreaterThan(10);
  });
});

describe("calcCostAwareStopPrice - boundary behavior", () => {
  it("stop price is always below entry price", () => {
    expect(calcCostAwareStopPrice(0.001, 10000, 0.01, SOL, -8)).toBeLessThan(0.001);
  });
  it("stop price never negative", () => {
    expect(calcCostAwareStopPrice(0.0001, 100000, 0.001, SOL, -8)).toBeGreaterThan(0);
  });
  it("stop covers exit slippage + 1pct buffer for 50k liq", () => {
    const entry = 0.001;
    const stop = calcCostAwareStopPrice(entry, 50000, 0.02, SOL, -8);
    const exitCostFromCalc = calcTransactionCosts(50000, 0.02, SOL).exitSlippagePct;
    const minStopPct = exitCostFromCalc + 1;
    const actualStopPct = ((entry - stop) / entry) * 100;
    expect(actualStopPct).toBeGreaterThanOrEqual(minStopPct - 0.5);
  });
  it("stopPrice uses stopLoss as floor for high liq", () => {
    const stop = calcCostAwareStopPrice(0.001, 500000, 0.001, SOL, -8);
    expect(stop / 0.001).toBeGreaterThan(0.90);
  });
  it("very low liq stops are tight (exit cost dominates)", () => {
    const stop = calcCostAwareStopPrice(0.001, 500, 0.005, SOL, -8);
    const actualDrop = ((0.001 - stop) / 0.001) * 100;
    expect(actualDrop).toBeGreaterThan(8);
  });
});

describe("calcTransactionCosts - output sanity", () => {
  it("exit slippage is never less than entry slippage minus MEV", () => {
    for (const liq of [100, 1000, 5000, 50000, 200000]) {
      const c = calcTransactionCosts(liq, 0.01, SOL);
      expect(c.exitSlippagePct).toBeGreaterThanOrEqual(c.entrySlippagePct - 1.6);
    }
  });
  it("total round trip never underflows to negative", () => {
    for (const liq of [100, 1000, 5000, 50000, 200000]) {
      const c = calcTransactionCosts(liq, 0.01, SOL);
      expect(c.totalRoundTripPct).toBeGreaterThanOrEqual(0);
      expect(isFinite(c.totalRoundTripPct)).toBe(true);
    }
  });
});
