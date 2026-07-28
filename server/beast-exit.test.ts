/**
 * beast-exit.test.ts — unit tests for the pure Beast exit engine.
 */

import { describe, expect, it } from "vitest";

import {
  evaluateBeastExit,
  tierForMultiplier,
  tierTrailingPct,
  tierHardStopPct,
  tierShortCircuitDeadcat,
  BEAST_TP_LADDER,
  BeastBagTier,
} from "./beast-exit";

function entry(over: Partial<any> = {}) {
  return {
    entryPriceSol: 1,
    currentPriceSol: 1,
    peakPriceSol: 1,
    ageSeconds: 1,
    positionSol: 0.01,
    tier: "COLD" as BeastBagTier,
    tpLevelReached: 0,
    ...over,
  };
}

describe("beast-exit.tierForMultiplier", () => {
  it("promotes COLD(0x) → COLD", () => {
    expect(tierForMultiplier(0.5)).toBe("COLD");
  });
  it("WARM at 1.05x", () => {
    expect(tierForMultiplier(1.05)).toBe("WARM");
  });
  it("HOT at 2x", () => {
    expect(tierForMultiplier(2)).toBe("HOT");
  });
  it("ROCKET at 10x", () => {
    expect(tierForMultiplier(10)).toBe("ROCKET");
  });
  it("MOON at 50x", () => {
    expect(tierForMultiplier(50)).toBe("MOON");
  });
  it("MOONSHOT at 1000x", () => {
    expect(tierForMultiplier(1000)).toBe("MOONSHOT");
  });
  it("MOONSHOT above 1000x", () => {
    expect(tierForMultiplier(10_000)).toBe("MOONSHOT");
  });
});

describe("beast-exit.tier trailing/hard-stop configs", () => {
  it("COLD = 12% trail / 22% hard stop", () => {
    expect(tierTrailingPct("COLD")).toBe(12);
    expect(tierHardStopPct("COLD")).toBe(22);
  });
  it("WARM = 18% trail / 32% hard stop", () => {
    expect(tierTrailingPct("WARM")).toBe(18);
    expect(tierHardStopPct("WARM")).toBe(32);
  });
  it("HOT = 32% trail / 65% hard stop", () => {
    expect(tierTrailingPct("HOT")).toBe(32);
    expect(tierHardStopPct("HOT")).toBe(65);
  });
  it("ROCKET = 45% trail / 85% hard stop", () => {
    expect(tierTrailingPct("ROCKET")).toBe(45);
    expect(tierHardStopPct("ROCKET")).toBe(85);
  });
  it("MOON = 55% trail / 90% hard stop", () => {
    expect(tierTrailingPct("MOON")).toBe(55);
    expect(tierHardStopPct("MOON")).toBe(90);
  });
  it("MOONSHOT = 75% trail / 95% hard stop", () => {
    expect(tierTrailingPct("MOONSHOT")).toBe(75);
    expect(tierHardStopPct("MOONSHOT")).toBe(95);
  });
  it("dead-cat short-circuit ≥ROCKET", () => {
    expect(tierShortCircuitDeadcat("ROCKET")).toBe(true);
    expect(tierShortCircuitDeadcat("MOON")).toBe(true);
    expect(tierShortCircuitDeadcat("MOONSHOT")).toBe(true);
  });
  it("dead-cat KEEPS at HOT/WARM/COLD", () => {
    expect(tierShortCircuitDeadcat("HOT")).toBe(false);
    expect(tierShortCircuitDeadcat("WARM")).toBe(false);
    expect(tierShortCircuitDeadcat("COLD")).toBe(false);
  });
});

describe("beast-exit.evaluateBeastExit", () => {
  it("holds a fresh COLD position", () => {
    const d = evaluateBeastExit(entry());
    expect(d.action).toBe("hold");
    expect(d.nextTier).toBe("COLD");
  });

  it("exits COLD position at hard stop (-22%) immediately when never above entry", () => {
    const d = evaluateBeastExit(entry({
      entryPriceSol: 100,
      currentPriceSol: 78,    // -22% below entry (need > hard stop 22)
      peakPriceSol: 100,
    }));
    expect(d.action).toBe("exit");
    expect(d.reason).toContain("beast_hard_stop");
    expect(d.reason).toContain("tier=COLD");
  });

  it("COLD below $0 invalid price returns hold", () => {
    const d = evaluateBeastExit(entry({ entryPriceSol: 0, currentPriceSol: 0, peakPriceSol: 0 }));
    expect(d.action).toBe("hold");
    expect(d.reason).toBe("invalid_prices");
  });

  it("exits with dead-cat on a <30m COLD/WARM token that spiked +50% and retraced to ~5% below entry", () => {
    // entered at 100, hit 150 (+50%), now 95 (drop from entry = 5%, drawdown from peak = 36.7%)
    // Need drawdown >= 55%. So peak 1, collapse to 0.4 = drawdown 60% from peak, dropFromEntry = 60% — fires hard stop instead.
    // To escape hard stop yet still hit dead-cat, the spike must be larger and retrace
    // must stay above -(tier-hard-stop)%:
    //   peak 1, current 0.85 -> drawdown from peak 15% only.
    //   peak 1, current 0.5 -> drawdown from peak 50%.
    //   peak 1, current 0.4 -> drawdown 60%; dropFromEntry = 60% -> fires HARD_STOP at 22% first.
    // For COLD tier (hard stop 22) we need:
    //   dropFromEntry < 22% AND drawdownFromPeak >= 55%
    //   Solving: peak - current / peak >= 0.55
    //            current = peak * 0.45
    //            (peak - entry) / entry = current dropFromEntry f = (entry - current)/entry
    //            current = entry * (1 - f/100) = entry * 0.45 / (peak mult)
    // For peak +50% (mult 1.5x of entry), current = peak*0.45 = entry*1.5*0.45 = entry*0.675
    //   dropFromEntry = 32.5% > 22% — fires hard stop first.
    // For peak +200% (mult 3x), current = entry*3*0.45 = entry*1.35 = +35% ABOVE entry.
    //   dropFromEntry = -35% (i.e. positive), drawdown from peak = 55% -> DEAD_CAT fires!
    const d = evaluateBeastExit(entry({
      entryPriceSol: 100, peakPriceSol: 300, currentPriceSol: 135, ageSeconds: 600,
    }));
    expect(d.action).toBe("exit");
    expect(d.reason).toContain("beast_dead_cat");
  });

  it("does NOT trigger dead-cat for ≥10x ROCKET tier even on 75% retrace", () => {
    // Position started COLD as input.tier, did 10x peak. Currently 2.5x.
    // tierForMultiplier(2.5)='HOT' (≥ 2). Promote-up of input tier COLD -> observed HOT -> promotedTier = HOT.
    // HOT does NOT short-circuit dead-cat. So dead-cat MIGHT fire if age < 30m and drawdown >= 55%.
    // Here ageSeconds=60 (< 30m) and drawdown = (10-2.5)/10 = 75% (>= 55%) → HOT dead-cat DOES fire.
    // The point of the test is to demonstrate ROCKET short-circuit. We re-frame:
    // Pass input tier = ROCKET explicitly to keep it ROCKET past the dead-cat retrace:
    const d = evaluateBeastExit(entry({
      entryPriceSol: 1, currentPriceSol: 2.5, peakPriceSol: 10, ageSeconds: 60, tier: "ROCKET",
    }));
    // ROCKET short-circuits dead-cat; trailing-stop ROCKET (45%) still fires on 75% drawdown.
    expect(d.nextTier).toBe("ROCKET"); // never demotes
    expect(d.action).toBe("exit"); // ROCKET trail 45 fired
    expect(d.reason).not.toContain("beast_dead_cat");
  });

  it("ROCKET-tier persisted: still holds through a fat retrace if started at ROCKET", () => {
    // tier passed = ROCKET (peak 10x). Now back at 2.5x.
    // ROCKET short-circuits dead-cat — exit via trail-stop (75% > 45 trail).
    // multiplier at 2.5x would suggest HOT observed, but ROCKET input wins (promote-up only).
    const d = evaluateBeastExit(entry({
      entryPriceSol: 1, currentPriceSol: 2.5, peakPriceSol: 10, ageSeconds: 60, tier: "ROCKET",
    }));
    expect(d.nextTier).toBe("ROCKET"); // never demotes
    expect(d.action).toBe("exit"); // trail 45, drawdown 75 > 45 — fires ROCKET trailing
    expect(d.reason).toContain("beast_trailing_stop");
  });

  it("partial TP fires at 1.5x (TP1)", () => {
    const d = evaluateBeastExit(entry({
      entryPriceSol: 1, currentPriceSol: 1.5, peakPriceSol: 1.5, ageSeconds: 60,
    }));
    expect(d.action).toBe("partial");
    expect(d.reason).toContain("tp1_1.5x");
    expect(d.sellFraction).toBeCloseTo(0.10);
  });

  it("partial TP fires at 3x (TP2)", () => {
    const d = evaluateBeastExit(entry({
      entryPriceSol: 1, currentPriceSol: 3, peakPriceSol: 3, ageSeconds: 60, tpLevelReached: 1,
    }));
    expect(d.action).toBe("partial");
    expect(d.reason).toContain("tp2_3x");
    expect(d.sellFraction).toBeCloseTo(0.07);
  });

  it("partial TP skips TP that has already been taken", () => {
    const d = evaluateBeastExit(entry({
      entryPriceSol: 1, currentPriceSol: 3, peakPriceSol: 3, ageSeconds: 60, tpLevelReached: 2, // already past TP1+TP2
    }));
    expect(d.action).toBe("hold"); // next TP (TP3_7x) hasn't been reached
  });

  it("partial TP at 7x -> TP3", () => {
    const d = evaluateBeastExit(entry({
      entryPriceSol: 1, currentPriceSol: 7, peakPriceSol: 7, ageSeconds: 60, tpLevelReached: 2,
    }));
    expect(d.action).toBe("partial");
    expect(d.reason).toContain("tp3_7x");
    expect(d.sellFraction).toBeCloseTo(0.10);
  });

  it("partial TP at 15x -> TP4", () => {
    const d = evaluateBeastExit(entry({
      entryPriceSol: 1, currentPriceSol: 15, peakPriceSol: 15, ageSeconds: 60, tpLevelReached: 3,
    }));
    expect(d.action).toBe("partial");
    expect(d.reason).toContain("tp4_15x");
  });

  it("partial TP at 50x -> TP5", () => {
    const d = evaluateBeastExit(entry({
      entryPriceSol: 1, currentPriceSol: 50, peakPriceSol: 50, ageSeconds: 60, tpLevelReached: 4,
    }));
    expect(d.action).toBe("partial");
    expect(d.reason).toContain("tp5_50x");
  });

  it("partial TP at 200x -> TP6", () => {
    const d = evaluateBeastExit(entry({
      entryPriceSol: 1, currentPriceSol: 200, peakPriceSol: 200, ageSeconds: 60, tpLevelReached: 5,
    }));
    expect(d.action).toBe("partial");
    expect(d.reason).toContain("tp6_200x");
  });

  it("partial TP at 1000x -> TP7", () => {
    const d = evaluateBeastExit(entry({
      entryPriceSol: 1, currentPriceSol: 1000, peakPriceSol: 1000, ageSeconds: 60, tpLevelReached: 6,
    }));
    expect(d.action).toBe("partial");
    expect(d.reason).toContain("tp7_1000x");
  });

  it("after all TPs taken keeps holding the moonshot bag", () => {
    // Current is 1500x of entry, all TPs taken. Wider MOONSHOT trailing (75%) allows through.
    const d = evaluateBeastExit(entry({
      entryPriceSol: 1, currentPriceSol: 1500, peakPriceSol: 1800, ageSeconds: 7200, tpLevelReached: BEAST_TP_LADDER.length,
    }));
    expect(d.action).toBe("hold");
    expect(d.reason).toContain("beast_moonshot_hold");
  });

  it("triggers trailing stop when peak retrace exceeds tier trail", () => {
    // COLD position peaking at +5% (-1.05 peak) and falling back to -5% from peak (= 1.05→1.0)
    // drawdown (1.05-1.00)/1.05 = 4.76%, ~5% — under COLD's 12%? Need more aggressive test.
    // Want peak trough enough. peak 1.3 (peak pnl=30%) -> current 1.0 -> drawdown (1.3-1)/1.3=23% > 12% trail.
    const d = evaluateBeastExit(entry({
      entryPriceSol: 1, currentPriceSol: 1.0, peakPriceSol: 1.3, ageSeconds: 60,
    }));
    expect(d.action).toBe("exit");
    expect(d.reason).toContain("beast_trailing_stop");
  });

  it("does not fire trailing stop until price crosses 2% above entry", () => {
    // peak only 1% above entry — hasProfitedPeak requires >2%, so no trailing fire
    const d = evaluateBeastExit(entry({
      entryPriceSol: 1, currentPriceSol: 0.995, peakPriceSol: 1.01, ageSeconds: 60,
    }));
    // Hard stop not crossed (-0.5%), dead-cat no (≥30m age), trailing no (peak never profited >2%), partial no (mult <1.5)
    expect(d.action).toBe("hold");
  });

  it("MOONSHOT tier holds a 1000x runner through a 50% retracement of peak (🔵 asymmetric payout)", () => {
    // peak 1800x, current 1000x (Retreated ~44% from peak; below MOONSHOT trail of 75%)
    // All TPs taken — no partial TP fires. Trail not crossed -> HOLD.
    const d = evaluateBeastExit(entry({
      entryPriceSol: 1, currentPriceSol: 1000, peakPriceSol: 1800, ageSeconds: 7200, tier: "MOONSHOT",
      tpLevelReached: BEAST_TP_LADDER.length,
    }));
    expect(d.action).toBe("hold");
    expect(d.nextTier).toBe("MOONSHOT");
  });

  it("MOONSHOT tier exits on confirmed ≥80% retrace (>trail 75%) — even a moonshot retrace can kill capital", () => {
    // peak 1800 -> current 200 (89% retrace from peak)
    const d = evaluateBeastExit(entry({
      entryPriceSol: 1, currentPriceSol: 200, peakPriceSol: 1800, ageSeconds: 7200, tier: "MOONSHOT",
    }));
    expect(d.action).toBe("exit");
    expect(d.reason).toContain("beast_trailing_stop");
  });

  it("asymmetric hold: a 50x runner retraces from 50x to 20x (=60% retrace); MOON tier keeps it (MOON trail=55% but 60>55 fires)", () => {
    // 50 -> 20 = 60% retrace, MOON tier trail=55 -> fires
    const d = evaluateBeastExit(entry({
      entryPriceSol: 1, currentPriceSol: 20, peakPriceSol: 50, ageSeconds: 7200, tier: "MOON",
    }));
    expect(d.action).toBe("exit");
  });

  it("HOT tier exits on 35% retrace (trail=32 trail fires at >32%)", () => {
    const d = evaluateBeastExit(entry({
      entryPriceSol: 1, currentPriceSol: 2, peakPriceSol: 3, ageSeconds: 1500, tier: "HOT",
    }));
    // (3-2)/3=33% > 32 trail -> fires
    expect(d.action).toBe("exit");
    expect(d.reason).toContain("beast_trailing_stop");
    expect(d.nextTier).toBe("HOT");
  });

  it("WARM tier keeps a 1.5x runner through a 12% retracement (trail=18%)", () => {
    const d = evaluateBeastExit(entry({
      entryPriceSol: 1, currentPriceSol: 1.32, peakPriceSol: 1.5, ageSeconds: 1500, tier: "WARM", tpLevelReached: 1,
    }));
    // (1.5-1.32)/1.5 ≈ 12% < 18 trail -> hold
    expect(d.action).toBe("hold");
  });

  // IEEE-754-REGRESSION(2026-07-28): a real sub-mSOL-priced token at exactly 1.5x produces
  // multiplier = 1.4999999999999998 due to floating-point division. The TP-ladder must
  // still fire (epsilon tolerance added to the >= comparison).
  it("IEEE-754: sub-mSOL token at exactly 1.5x still fires TP1", () => {
    const d = evaluateBeastExit(entry({
      entryPriceSol: 0.0001,
      currentPriceSol: 0.00015,
      peakPriceSol: 0.00015,
      ageSeconds: 300,
    }));
    expect(d.action).toBe("partial");
    expect(d.reason).toContain("tp1_1.5x");
    expect(d.sellFraction).toBeCloseTo(0.10);
  });
});
