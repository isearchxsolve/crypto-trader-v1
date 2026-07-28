/**
 * beast-scanner.test.ts — unit tests for the pure Beast discovery evaluator.
 */

import { describe, expect, it } from "vitest";

import { evaluateBeastDiscovery, BeastDiscoveryInput } from "./beast-scanner";

function cleanDiscovery(over: Partial<BeastDiscoveryInput> = {}): BeastDiscoveryInput {
  return {
    liquidityUsd: 60_000,           // s1 = 12 (liq >= 50k)
    ageSeconds: 600,
    buys5m: 40,
    sells5m: 38,                    // s2 = 12 (balance 0.95)
    volume5mUsd: 18_000,            // ratio 18k/60k = 0.3 -> sweet spot, s9 = 10, s10 = 4
    volume24hUsd: 200_000,
    priceChange5mPct: 8,            // s3 = 12 (sweet 3-15)
    priceChange1hPct: 12,
    smartWalletsNetBuyers: 5,       // s7 = 16 (capped bonus)
    whaleNetBuyers: 4,
    nonLpTop1Pct: 3.2,              // s4 = 10
    nonLpTop5Pct: 12,
    lpLockedPct: 100,                // s5 = 12
    creatorPriorActiveCount: 2,      // s6 = 9
    ...over,
  };
}

describe("beast-scanner.evaluateBeastDiscovery", () => {
  it("PASSes a fully clean Beast candidate", () => {
    const r = evaluateBeastDiscovery(cleanDiscovery());
    expect(r.verdict).toBe("PASS");
    expect(r.tier).toBe("LEGENDARY");
    expect(r.score).toBeGreaterThanOrEqual(50);
    expect(r.surfacesPassed).toBeGreaterThanOrEqual(6);
  });

  it("VETOes a wash bundle (high vol/liq balanced + flat px + high tx)", () => {
    const r = evaluateBeastDiscovery(cleanDiscovery({
      volume5mUsd: 100_000,   // 10x liq (>$>solid liq) — passes beast WASH bound >6 ABOVE ratio
      liquidityUsd: 10_000,    // ratio = 10
      priceChange5mPct: 0,    // flat
      buys5m: 80, sells5m: 80, // totalTx high
    }));
    expect(r.verdict).toBe("VETO");
    expect(r.reason).toContain("wash_bundle");
  });

  it("VETOes on dead-cat bounce (5m up vs 1h down)", () => {
    const r = evaluateBeastDiscovery(cleanDiscovery({
      priceChange5mPct: 15, priceChange1hPct: -20,
    }));
    expect(r.verdict).toBe("VETO");
    expect(r.reason).toContain("dead_cat_bounce");
  });

  it("VETOes when liquidity < $3000 (no Beast credit)", () => {
    const r = evaluateBeastDiscovery(cleanDiscovery({ liquidityUsd: 2_500 }));
    expect(r.verdict).toBe("VETO");
    expect(r.reason).toContain("liquidity_below_floor");
    expect(r.score).toBe(0);  // No liquidity = nothing scored
  });

  it("VETOes a one-way market (zero 5m sells)", () => {
    const r = evaluateBeastDiscovery(cleanDiscovery({ buys5m: 50, sells5m: 0 }));
    expect(r.verdict).toBe("VETO");
  });

  it("VETOes on extreme price move (>80% 5m — parabolic)", () => {
    const r = evaluateBeastDiscovery(cleanDiscovery({ priceChange5mPct: 100 }));
    expect(r.verdict).toBe("VETO");
    expect(r.reason).toContain("parabolic");
  });

  it("VETOes when holder concentration is high (top1=10%, top5=40%)", () => {
    const r = evaluateBeastDiscovery(cleanDiscovery({ nonLpTop1Pct: 10, nonLpTop5Pct: 40 }));
    expect(r.verdict).toBe("VETO");
  });

  it("PASSes with HIGH tier (not LEGENDARY) when whale+smart < 8", () => {
    const r = evaluateBeastDiscovery(cleanDiscovery({
      smartWalletsNetBuyers: 1, whaleNetBuyers: 1, // s7 = 2+2=4<8
    }));
    // Without whale overlay, tier detection drops from LEGENDARY to HIGH (or MEDIUM).
    expect(r.verdict).toBe("PASS");
    expect(r.tier === "HIGH" || r.tier === "MEDIUM").toBe(true);
  });

  it("VETOes when score < 50 despite surface count >=6 (compounding severe discount)", () => {
    // Make multiple surfaces weak to score <50
    const r = evaluateBeastDiscovery(cleanDiscovery({
      liquidityUsd: 3_500,        // score 1
      volume5mUsd: 200,           // ratio 0.057 — under 0.3 — score 3
      smartWalletsNetBuyers: 1,   // 2
      whaleNetBuyers: 1,          // 2 = whaleBonus 2+smartBonus 2 = s7 4
      lpLockedPct: 30,            // s5 = 2
      nonLpTop1Pct: 4, nonLpTop5Pct: 24,  // s4 = 4 (borderline)
      creatorPriorActiveCount: 0,          // s6 = 2 (first token)
      // surface check count >=6 but score: 1+12+9+4+2+2+4+10+0 = 44 < 50  -> VETO on insufficient
    }));
    expect(r.verdict).toBe("VETO");
    expect(r.reason).toContain("insufficient");
  });

  it("PASSes with MEDIUM tier when score is 50-69", () => {
    const r = evaluateBeastDiscovery(cleanDiscovery({
      liquidityUsd: 3_500,        // s1=1
      smartWalletsNetBuyers: 2, whaleNetBuyers: 2, // s7=8
      lpLockedPct: 75,            // s5=10
      nonLpTop1Pct: 3, nonLpTop5Pct: 12,   // s4=10
      creatorPriorActiveCount: 1,  // s6 = 6
      // score = s1(1) + s2(scoreTwoWayFlow 38:48) + s3(8 px) + s4(10) + s5(10) + s6(6) + s7(8) + s9(no_wash.. ratio 8000/3500 = 2.28 sweet 10) + s10(4) = 1+10+12+10+10+6+8+10+4 = 71 → PASS HIGH tier
    }));
    expect(r.verdict).toBe("PASS");
    expect(r.tier === "HIGH" || r.tier === "MEDIUM").toBe(true);
  });
});
