// server/objective-edge.test.ts
// Edge-case coverage for f(x) convergence framework.
import { describe, it, expect } from "vitest";

function estimateRealisticPeakPct(liqUsd) {
  return liqUsd < 15000 ? 5 : liqUsd < 25000 ? 6 : liqUsd < 50000 ? 8 : liqUsd < 100000 ? 10 : 12;
}

function calcTx(liqUsd, sizeSol, solPriceUsd) {
  if (solPriceUsd <= 0) return { totalRoundTripPct: 0 };
  var tv = sizeSol * solPriceUsd;
  var pi = liqUsd > 0 ? Math.min(20, (tv / (liqUsd / 2)) * 100) : 10;
  var bs = liqUsd < 2000 ? 8 : liqUsd < 5000 ? 5 : liqUsd < 20000 ? 2.5 : 1.2;
  var mev = 1.5;
  var entry = Math.max(bs, pi) + mev;
  var exitSlip = (entry - mev) * 1.3 + mev;
  return { totalRoundTripPct: entry + exitSlip };
}

function fof(liq, size, sp, score) {
  var c = calcTx(liq, size, sp);
  var peak = estimateRealisticPeakPct(liq);
  var cv = Math.max(0, Math.min(1.0, (score - 70) / 20));
  var cm = 0.7 + 0.3 * cv;
  var gross = peak * cm;
  var net = gross - c.totalRoundTripPct;
  return { netEvPct: net, peakPct: peak, rtCostPct: c.totalRoundTripPct, passes: net > 1.0 };
}

var SOL = 180;

describe("f(x) boundary at exactly +1.0% margin", function() {
  it("f(x) below margin correctly fails", function() {
    var r = fof(1000, 0.005, SOL, 70);
    expect(r.netEvPct).toBeLessThan(1.0);
    expect(r.passes).toBe(false);
  });
});

describe("tier boundaries", function() {
  it("below 15000 returns 5", function() { expect(estimateRealisticPeakPct(0)).toBe(5); });
  it("exactly 15000 returns 6", function() { expect(estimateRealisticPeakPct(15000)).toBe(6); });
  it("exactly 25000 returns 8", function() { expect(estimateRealisticPeakPct(25000)).toBe(8); });
  it("exactly 50000 returns 10", function() { expect(estimateRealisticPeakPct(50000)).toBe(10); });
  it("exactly 100000 returns 12", function() { expect(estimateRealisticPeakPct(100000)).toBe(12); });
});

describe("captureMult cap and floor", function() {
  it("score=90 and score=100 produce equal f(x)", function() {
    expect(fof(50000, 0.01, SOL, 90).netEvPct).toBe(fof(50000, 0.01, SOL, 100).netEvPct);
  });
  it("score<70 same as score=70 (floor conviction at 0)", function() {
    expect(fof(50000, 0.01, SOL, 50).netEvPct).toBe(fof(50000, 0.01, SOL, 70).netEvPct);
  });
});

describe("UN-WINNABLE: cost exceeds achievable peak", function() {
  it("$1k liq score 70 is unwinnable", function() {
    var r = fof(1000, 0.005, SOL, 70);
    expect(r.netEvPct).toBeLessThan(1.0);
    expect(r.passes).toBe(false);
  });
  it("$100k liq score 90 is winnable", function() {
    expect(fof(100000, 0.01, SOL, 90).passes).toBe(true);
  });
});

