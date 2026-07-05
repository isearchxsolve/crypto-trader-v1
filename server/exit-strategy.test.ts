import { describe, expect, it } from "vitest";

import { evaluateExitSignal, type ExitSignalInput } from "./exit-strategy";

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────

function makeInput(overrides: Partial<ExitSignalInput> = {}): ExitSignalInput {
  return {
    entryPriceSol: 0.00001,
    currentPriceSol: 0.00001,
    peakPriceSol: 0.00001,
    ageSeconds: 600,          // 10 minutes old
    positionSol: 0.05,
    tier: "HIGH",
    tpLevelReached: 0,        // no TP hit yet
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// TRAILING STOP TESTS
// ─────────────────────────────────────────────────────────────────────────────

describe("exit-strategy", () => {
  describe("Trailing Stop — HIGH tier (25% from peak)", () => {
    it("holds when price is at peak (no drawdown)", () => {
      const result = evaluateExitSignal(makeInput({
        entryPriceSol: 0.00001,
        currentPriceSol: 0.00005, // 5x
        peakPriceSol: 0.00005,
        tier: "HIGH",
        tpLevelReached: 2, // 2x and 5x already taken — avoids TP ladder firing
      }));

      expect(result.action).toBe("hold");
    });

    it("exits when price falls 25% from peak for HIGH tier", () => {
      const result = evaluateExitSignal(makeInput({
        entryPriceSol: 0.00001,
        peakPriceSol: 0.00010,  // 10x peak
        currentPriceSol: 0.000074, // ~26% below peak
        tier: "HIGH",
        tpLevelReached: 1,     // at least 2x was hit
      }));

      expect(result.action).toBe("exit");
      expect(result.reason).toContain("trailing_stop");
      expect(result.sellFraction).toBe(1.0);
    });

    it("holds when drawdown is exactly 24% from peak (below threshold)", () => {
      const result = evaluateExitSignal(makeInput({
        entryPriceSol: 0.00001,
        peakPriceSol: 0.00010,
        currentPriceSol: 0.000076, // 24% below peak, but 7.6x from entry
        tier: "HIGH",
        tpLevelReached: 3, // all TPs taken — avoids TP ladder firing
      }));

      expect(result.action).toBe("hold");
    });
  });

  describe("Trailing Stop — LEGENDARY tier (35% from peak)", () => {
    it("holds when price falls 30% from peak for LEGENDARY tier", () => {
      const result = evaluateExitSignal(makeInput({
        entryPriceSol: 0.00001,
        peakPriceSol: 0.00010,
        currentPriceSol: 0.000070, // 30% below peak, 7x from entry
        tier: "LEGENDARY",
        tpLevelReached: 3, // all TPs taken
      }));

      expect(result.action).toBe("hold");
    });

    it("exits when price falls 35% from peak for LEGENDARY tier", () => {
      const result = evaluateExitSignal(makeInput({
        entryPriceSol: 0.00001,
        peakPriceSol: 0.00010,
        currentPriceSol: 0.000064, // 36% below peak
        tier: "LEGENDARY",
        tpLevelReached: 1,
      }));

      expect(result.action).toBe("exit");
      expect(result.reason).toContain("trailing_stop");
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // PARTIAL TAKE PROFIT TESTS
  // ─────────────────────────────────────────────────────────────────────────────

  describe("Partial Take Profit ladder", () => {
    it("takes 25% profit at 2x entry price", () => {
      const result = evaluateExitSignal(makeInput({
        entryPriceSol: 0.00001,
        currentPriceSol: 0.00002, // exactly 2x
        peakPriceSol: 0.00002,
        tpLevelReached: 0, // no TP hit yet
      }));

      expect(result.action).toBe("partial");
      expect(result.reason).toContain("tp1_2x");
      expect(result.sellFraction).toBe(0.25);
    });

    it("takes 25% profit at 5x entry price", () => {
      const result = evaluateExitSignal(makeInput({
        entryPriceSol: 0.00001,
        currentPriceSol: 0.00005, // exactly 5x
        peakPriceSol: 0.00005,
        tpLevelReached: 1, // 2x already hit
      }));

      expect(result.action).toBe("partial");
      expect(result.reason).toContain("tp2_5x");
      expect(result.sellFraction).toBe(0.25);
    });

    it("takes 25% profit at 10x entry price", () => {
      const result = evaluateExitSignal(makeInput({
        entryPriceSol: 0.00001,
        currentPriceSol: 0.00010, // exactly 10x
        peakPriceSol: 0.00010,
        tpLevelReached: 2, // 2x and 5x already hit
      }));

      expect(result.action).toBe("partial");
      expect(result.reason).toContain("tp3_10x");
      expect(result.sellFraction).toBe(0.25);
    });

    it("does NOT re-trigger a TP level that was already taken", () => {
      // Price is 5x but TP2 already hit
      const result = evaluateExitSignal(makeInput({
        entryPriceSol: 0.00001,
        currentPriceSol: 0.00005,
        peakPriceSol: 0.00005,
        tpLevelReached: 2, // both 2x and 5x already hit
      }));

      expect(result.action).toBe("hold");
    });

    it("holds moonshot bag (25%) after all 3 TP levels taken", () => {
      // Price is at 15x, all TPs hit — hold the moonshot remainder
      const result = evaluateExitSignal(makeInput({
        entryPriceSol: 0.00001,
        currentPriceSol: 0.00015,
        peakPriceSol: 0.00015,
        tpLevelReached: 3, // all 3 TPs hit
      }));

      expect(result.action).toBe("hold");
      expect(result.reason).toContain("moonshot_hold");
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // DEAD CAT DETECTION TESTS
  // ─────────────────────────────────────────────────────────────────────────────

  describe("Dead Cat Bounce Detection", () => {
    it("exits on dead cat: price drops > 15% in estimated 5 min after peak spike", () => {
      // Entry was 1x, spike to 3x, now crashed back to 1.2x from 3x peak
      // drawdown from peak = (3x - 1.2x) / 3x = 60% — massive dump
      const result = evaluateExitSignal(makeInput({
        entryPriceSol: 0.00001,
        currentPriceSol: 0.000012, // back to near entry (crashed 60% from peak)
        peakPriceSol: 0.00003,     // spiked to 3x
        ageSeconds: 120,           // only 2 min old — very fresh token
        tier: "HIGH",
        tpLevelReached: 0,
      }));

      expect(result.action).toBe("exit");
      expect(result.reason).toContain("dead_cat");
    });

    it("does NOT flag dead cat when drawdown is moderate (< 50% from peak)", () => {
      // Use a 20% drawdown (below 25% trailing stop AND below 50% dead cat threshold)
      // price stays below 2x so TP1 doesn't fire either
      const result = evaluateExitSignal(makeInput({
        entryPriceSol: 0.00001,
        currentPriceSol: 0.000016, // 1.6x from entry — below TP1 (2x)
        peakPriceSol: 0.00002,     // 2x peak (so hasProfitedPeak = true)
        ageSeconds: 120,           // young token
        tier: "HIGH",
        tpLevelReached: 0,
      }));

      // 20% drawdown from peak (0.000016 vs 0.00002) — below both 25% trailing stop and 50% dead cat
      expect(result.action).toBe("hold");
    });

    it("does NOT apply dead cat logic to old positions (> 30 min)", () => {
      // For old positions, trailing stop handles the exit — not dead cat
      const result = evaluateExitSignal(makeInput({
        entryPriceSol: 0.00001,
        currentPriceSol: 0.000012, // near entry
        peakPriceSol: 0.00003,
        ageSeconds: 2400,          // 40 minutes old
        tier: "HIGH",
        tpLevelReached: 0,
      }));

      // Should be exit via trailing_stop logic, NOT dead_cat
      if (result.action === "exit") {
        expect(result.reason).not.toContain("dead_cat");
      }
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // STOP LOSS (BELOW ENTRY) TESTS
  // ─────────────────────────────────────────────────────────────────────────────

  describe("Hard Stop Loss (below entry)", () => {
    it("exits when price drops 30% below entry (stop loss)", () => {
      const result = evaluateExitSignal(makeInput({
        entryPriceSol: 0.00001,
        currentPriceSol: 0.000006, // 40% below entry
        peakPriceSol: 0.00001,     // never went up
        tier: "HIGH",
        tpLevelReached: 0,
      }));

      expect(result.action).toBe("exit");
      expect(result.reason).toContain("stop_loss");
    });

    it("holds when price is 20% below entry (within stop loss tolerance)", () => {
      // Price must be below 2x entry to avoid TP1 firing
      const result = evaluateExitSignal(makeInput({
        entryPriceSol: 0.00001,
        currentPriceSol: 0.0000082, // 18% below entry — within tolerance, below 2x so no TP
        peakPriceSol: 0.0000082,    // no profit peak recorded
        tier: "HIGH",
        tpLevelReached: 0,
      }));

      expect(result.action).toBe("hold");
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // AGE-BASED TIGHTENING
  // ─────────────────────────────────────────────────────────────────────────────

  describe("Age-based Stop Tightening", () => {
    it("tightens trailing stop to 15% for positions > 4 hours old", () => {
      const result = evaluateExitSignal(makeInput({
        entryPriceSol: 0.00001,
        peakPriceSol: 0.00010,
        currentPriceSol: 0.000083, // 17% below peak — above 15% tightened stop
        tier: "HIGH",
        ageSeconds: 5 * 3600,  // 5 hours
        tpLevelReached: 1,
      }));

      // Should exit because 17% > 15% (tightened threshold for old positions)
      expect(result.action).toBe("exit");
      expect(result.reason).toContain("trailing_stop");
    });

    it("holds at 12% drawdown for old position (below 15% tightened stop)", () => {
      const result = evaluateExitSignal(makeInput({
        entryPriceSol: 0.00001,
        peakPriceSol: 0.00010,
        currentPriceSol: 0.000088, // 12% below peak, 8.8x from entry
        tier: "HIGH",
        ageSeconds: 5 * 3600,
        tpLevelReached: 3, // all TPs taken — avoids TP ladder
      }));

      expect(result.action).toBe("hold");
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // INTEGRATION TESTS
  // ─────────────────────────────────────────────────────────────────────────────

  describe("Integration scenarios", () => {
    it("correctly sequences: hold → partial (2x) → partial (5x) → moonshot hold", () => {
      // Simulate a token going 1x → 1.5x → 2x → 3x → 5x → hold
      const at1x = evaluateExitSignal(makeInput({ currentPriceSol: 0.00001, peakPriceSol: 0.00001, tpLevelReached: 0 }));
      const at1_5x = evaluateExitSignal(makeInput({ currentPriceSol: 0.000015, peakPriceSol: 0.000015, tpLevelReached: 0 }));
      const at2x = evaluateExitSignal(makeInput({ currentPriceSol: 0.00002, peakPriceSol: 0.00002, tpLevelReached: 0 }));
      const at5x = evaluateExitSignal(makeInput({ currentPriceSol: 0.00005, peakPriceSol: 0.00005, tpLevelReached: 1 }));
      const at8x = evaluateExitSignal(makeInput({ currentPriceSol: 0.00008, peakPriceSol: 0.00008, tpLevelReached: 2 }));

      expect(at1x.action).toBe("hold");
      expect(at1_5x.action).toBe("hold");
      expect(at2x.action).toBe("partial");
      expect(at5x.action).toBe("partial");
      expect(at8x.action).toBe("hold");  // between 5x and 10x with both TPs hit
    });

    it("returns sellFraction between 0 and 1 for all actions", () => {
      const inputs: ExitSignalInput[] = [
        makeInput({ currentPriceSol: 0.00001, tpLevelReached: 0 }),
        makeInput({ currentPriceSol: 0.00002, tpLevelReached: 0 }),
        makeInput({ currentPriceSol: 0.000006, peakPriceSol: 0.00001 }),
      ];

      for (const input of inputs) {
        const result = evaluateExitSignal(input);
        expect(result.sellFraction).toBeGreaterThanOrEqual(0);
        expect(result.sellFraction).toBeLessThanOrEqual(1);
      }
    });
  });
});
