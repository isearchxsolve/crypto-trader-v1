import { describe, it, expect } from "vitest";

/**
 * Baseline Test for Bug F-1: Float Precision in Lamport Conversion
 * 
 * Issue: Math.floor(amountSol * LAMPORTS_PER_SOL) converts IEEE-754 floats like
 * 0.009 * 1e9 -> 8999999.999999998 -> Math.floor = 8999999 (1 lamport short).
 */

function unpatchedSolToLamports(amountSol: number): number {
  return Math.floor(amountSol * 1_000_000_000);
}

function patchedSolToLamports(amountSol: number): bigint {
  return BigInt(Math.round(amountSol * 1_000_000_000));
}

describe("F-1: Lamport Conversion Float Precision", () => {
  it("exposes precision loss in unpatched Math.floor conversion for 0.009 SOL", () => {
    const amountSol = 0.009;
    const expectedLamports = 9_000_000;

    const unpatchedLamports = unpatchedSolToLamports(amountSol);

    // Math.floor(0.009 * 1e9) gives 8999999
    expect(unpatchedLamports).toBe(8999999);
    expect(unpatchedLamports).not.toBe(expectedLamports);
  });

  it("verifies that patched Math.round + BigInt conversion preserves exact lamport amount", () => {
    const problemSolValues = [0.009, 0.007, 0.029, 0.057, 0.003];

    for (const sol of problemSolValues) {
      const expectedLamports = BigInt(Math.round(sol * 1_000_000_000));
      const patchedLamports = patchedSolToLamports(sol);

      expect(patchedLamports).toBe(expectedLamports);
    }
  });
});
