import { describe, expect, it } from "vitest";

import { evaluateMlScoreGate, type MlScoreGateInput } from "./ml-score-gate";

function makeInput(overrides: Partial<MlScoreGateInput> = {}): MlScoreGateInput {
  return {
    pumpProbability: 0.60,
    goldScore: 65,
    tier: "HIGH",
    candidateSizeSol: 0.02,
    maxPositionSizeSol: 0.05,
    isLive: false,
    ...overrides,
  };
}

describe("ml-score-gate", () => {
  describe("Block zone (pump_prob < 0.35)", () => {
    it("blocks trade when pump probability is below 0.35", () => {
      const result = evaluateMlScoreGate(makeInput({ pumpProbability: 0.30 }));

      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("ml_block");
      expect(result.adjustedSizeSol).toBe(0);
    });

    it("blocks at exactly 0.34", () => {
      const result = evaluateMlScoreGate(makeInput({ pumpProbability: 0.34 }));
      expect(result.allowed).toBe(false);
    });

    it("allows at exactly 0.35 (boundary)", () => {
      const result = evaluateMlScoreGate(makeInput({ pumpProbability: 0.35 }));
      expect(result.allowed).toBe(true);
    });

    it("logs reason with probability value for debugging", () => {
      const result = evaluateMlScoreGate(makeInput({ pumpProbability: 0.20 }));
      expect(result.reason).toContain("0.20");
    });
  });

  describe("Reduce zone (pump_prob 0.35–0.55)", () => {
    it("allows but reduces size by 50% at 0.40 probability", () => {
      const result = evaluateMlScoreGate(makeInput({
        pumpProbability: 0.40,
        candidateSizeSol: 0.02,
      }));

      expect(result.allowed).toBe(true);
      expect(result.adjustedSizeSol).toBeCloseTo(0.01, 4); // 50% reduction
      expect(result.reason).toContain("ml_reduce");
      expect(result.confidenceMultiplier).toBe(0.5);
    });

    it("reduces size at 0.54 (just below upper boundary)", () => {
      const result = evaluateMlScoreGate(makeInput({
        pumpProbability: 0.54,
        candidateSizeSol: 0.04,
      }));

      expect(result.allowed).toBe(true);
      expect(result.adjustedSizeSol).toBeCloseTo(0.02, 4);
    });

    it("allows at exactly 0.55 boundary with normal size", () => {
      const result = evaluateMlScoreGate(makeInput({
        pumpProbability: 0.55,
        candidateSizeSol: 0.02,
      }));

      expect(result.allowed).toBe(true);
      expect(result.confidenceMultiplier).toBe(1.0);
    });
  });

  describe("Normal zone (pump_prob 0.55–0.70)", () => {
    it("allows with normal size at 0.60", () => {
      const result = evaluateMlScoreGate(makeInput({
        pumpProbability: 0.60,
        candidateSizeSol: 0.02,
      }));

      expect(result.allowed).toBe(true);
      expect(result.adjustedSizeSol).toBeCloseTo(0.02, 4);
      expect(result.confidenceMultiplier).toBe(1.0);
      expect(result.reason).toContain("ml_normal");
    });

    it("does not boost or reduce at 0.65", () => {
      const result = evaluateMlScoreGate(makeInput({
        pumpProbability: 0.65,
        candidateSizeSol: 0.03,
      }));

      expect(result.adjustedSizeSol).toBeCloseTo(0.03, 4);
    });
  });

  describe("Boost zone (pump_prob > 0.70)", () => {
    it("boosts size by 20% at 0.80 probability", () => {
      const result = evaluateMlScoreGate(makeInput({
        pumpProbability: 0.80,
        candidateSizeSol: 0.02,
        maxPositionSizeSol: 0.05,
      }));

      expect(result.allowed).toBe(true);
      expect(result.adjustedSizeSol).toBeCloseTo(0.024, 4); // 20% boost
      expect(result.reason).toContain("ml_boost");
      expect(result.confidenceMultiplier).toBe(1.2);
    });

    it("caps boosted size at maxPositionSizeSol", () => {
      const result = evaluateMlScoreGate(makeInput({
        pumpProbability: 0.90,
        candidateSizeSol: 0.045, // 20% boost = 0.054, but max is 0.05
        maxPositionSizeSol: 0.05,
      }));

      expect(result.adjustedSizeSol).toBeCloseTo(0.05, 4); // capped at max
    });

    it("boosts at exactly 0.71", () => {
      const result = evaluateMlScoreGate(makeInput({ pumpProbability: 0.71 }));
      expect(result.confidenceMultiplier).toBe(1.2);
    });
  });

  describe("LEGENDARY tier relaxation", () => {
    it("allows LEGENDARY tokens with 0.30 probability (relaxed to 0.30 threshold)", () => {
      const result = evaluateMlScoreGate(makeInput({
        pumpProbability: 0.30,
        tier: "LEGENDARY",
        goldScore: 80,
      }));

      expect(result.allowed).toBe(true);
    });

    it("blocks LEGENDARY tokens below 0.30", () => {
      const result = evaluateMlScoreGate(makeInput({
        pumpProbability: 0.25,
        tier: "LEGENDARY",
        goldScore: 80,
      }));

      expect(result.allowed).toBe(false);
    });

    it("still blocks HIGH tier at 0.30 (only LEGENDARY gets relaxation)", () => {
      const result = evaluateMlScoreGate(makeInput({
        pumpProbability: 0.30,
        tier: "HIGH",
        goldScore: 60,
      }));

      expect(result.allowed).toBe(false);
    });
  });

  describe("Live vs Paper mode", () => {
    it("enforces ML gate in live mode", () => {
      const result = evaluateMlScoreGate(makeInput({
        pumpProbability: 0.20,
        isLive: true,
      }));

      expect(result.allowed).toBe(false);
    });

    it("enforces ML gate in paper mode too", () => {
      const result = evaluateMlScoreGate(makeInput({
        pumpProbability: 0.20,
        isLive: false,
      }));

      expect(result.allowed).toBe(false);
    });
  });

  describe("Size calculations", () => {
    it("returns adjustedSizeSol = 0 when blocked", () => {
      const result = evaluateMlScoreGate(makeInput({ pumpProbability: 0.10 }));
      expect(result.adjustedSizeSol).toBe(0);
    });

    it("adjustedSizeSol never exceeds maxPositionSizeSol regardless of boost", () => {
      const result = evaluateMlScoreGate(makeInput({
        pumpProbability: 0.99,
        candidateSizeSol: 0.10, // large candidate
        maxPositionSizeSol: 0.05,
      }));

      expect(result.adjustedSizeSol).toBeLessThanOrEqual(0.05);
    });

    it("adjustedSizeSol never goes below 0", () => {
      const result = evaluateMlScoreGate(makeInput({
        pumpProbability: 0.40,
        candidateSizeSol: 0.001,
      }));

      expect(result.adjustedSizeSol).toBeGreaterThanOrEqual(0);
    });
  });
});
