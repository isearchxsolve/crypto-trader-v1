/**
 * newMintGate.test.ts — Vitest unit tests for the NEW_MINT admission gate.
 *
 * Tests the REAL exported API of server/lib/newMintGate.ts (the pure decision
 * function wired into routes.ts at the gold-hunter entry path). Cases t1–t8
 * are ported from real trade history (see tests/newMintGate.test.ts, the
 * node:test twin of this suite):
 *   $H8NoF4 score 75 pc5m +30.6% → ADMIT SNIPER
 *   $3zYGCp score 67 pc5m +12.8% → ADMIT (NEW_MINT survivor bypasses EDGE_POCKET)
 *   $ztXmc4 score 66 pc5m +1%    → ADMIT
 *   $xGatR5 score 63             → REJECT (below NEW_MINT_MIN_SCORE 65)
 *   $6kA2JK score 35             → REJECT
 *   tier HIGH @ 67               → REJECT (global 90 wall intact)
 *   tier LEGENDARY sig 82        → ADMIT (boosted to 90, forced SNIPER)
 *   tier HIGH @ 90 SNIPER        → ADMIT
 */
import { describe, it, expect } from 'vitest';
import { evaluateNewMintGate, getEffectiveMinScore, GateInput } from './lib/newMintGate';

const defaultEnv = {
  NEW_MINT_MIN_SCORE: 65,
  EDGE_POCKET_ONLY: 'true',
  EDGE_MIN_SCORE: 80,
  EDGE_HIGH_CONF_SCORE: 90,
  EDGE_EXPLOSIVE_SCORE: 85,
  EDGE_EXPLOSIVE_ML: 80,
  EDGE_EXPLOSIVE_PX5M: 8,
  EDGE_EXPLOSIVE_VOLMOM: 1.5,
  ENTRY_CONFIRM_MIN_BP: 0.50,
  ENTRY_CONFIRM_MIN_PC5M: 0,
};

function createInput(overrides: Partial<GateInput> = {}): GateInput {
  return {
    tier: 'NEW_MINT',
    sigScore: 0,
    combinedScore: 0,
    mlScore: 0,
    px5m: 0,
    volMom: 0,
    bp5m: 0,
    pc5m: 0,
    qualifiedMode: null,
    isMicroWallet: false,
    env: { ...defaultEnv },
    ...overrides,
  };
}

describe('newMintGate — real trade-history cases', () => {
  it('t1: $H8NoF4 score 75, pc5m +30.6% → ADMIT SNIPER', () => {
    const r = evaluateNewMintGate(createInput({ combinedScore: 75, pc5m: 30.6 }));
    expect(r.admit).toBe(true);
    expect(r.mode).toBe('SNIPER');
  });

  it('t2: $3zYGCp score 67, pc5m +12.8% → ADMIT (survivor bypasses EDGE_POCKET)', () => {
    const r = evaluateNewMintGate(createInput({ combinedScore: 67, pc5m: 12.8 }));
    expect(r.admit).toBe(true);
  });

  it('t3: $ztXmc4 score 66, pc5m +1% → ADMIT', () => {
    const r = evaluateNewMintGate(createInput({ combinedScore: 66, pc5m: 1 }));
    expect(r.admit).toBe(true);
  });

  it('t4: $xGatR5 score 63 → REJECT below NEW_MINT_MIN_SCORE', () => {
    const r = evaluateNewMintGate(createInput({ combinedScore: 63 }));
    expect(r.admit).toBe(false);
    expect(r.reason).toContain('score');
  });

  it('t5: score 35 → REJECT', () => {
    const r = evaluateNewMintGate(createInput({ combinedScore: 35 }));
    expect(r.admit).toBe(false);
  });

  it('t6: tier HIGH @ 67 → REJECT (global 90 wall intact for non-survivors)', () => {
    const r = evaluateNewMintGate(createInput({ tier: 'HIGH', combinedScore: 67 }));
    expect(r.admit).toBe(false);
  });

  it('t7: tier LEGENDARY sig 82 → ADMIT (boosted to 90, forced SNIPER)', () => {
    const r = evaluateNewMintGate(createInput({ tier: 'LEGENDARY', sigScore: 82 }));
    expect(r.admit).toBe(true);
    expect(r.mode).toBe('SNIPER');
    expect(r.newCombinedScore).toBe(90);
  });

  it('t8: tier HIGH @ 90 with SNIPER mode → ADMIT', () => {
    const r = evaluateNewMintGate(createInput({ tier: 'HIGH', combinedScore: 90, qualifiedMode: 'SNIPER' }));
    expect(r.admit).toBe(true);
  });
});

describe('newMintGate — score floor and boost mechanics', () => {
  it('boosts combinedScore to round(sigScore * 1.1) when higher', () => {
    const r = evaluateNewMintGate(createInput({ tier: 'LEGENDARY', sigScore: 82, combinedScore: 50 }));
    expect(r.newCombinedScore).toBe(90); // max(50, round(82*1.1)=90)
  });

  it('keeps combinedScore when it already exceeds the sig boost', () => {
    const r = evaluateNewMintGate(createInput({ combinedScore: 80, pc5m: 5 }));
    expect(r.newCombinedScore).toBe(80);
  });

  it('LEGENDARY without a qualified mode is forced to SNIPER', () => {
    const r = evaluateNewMintGate(createInput({ tier: 'LEGENDARY', combinedScore: 92 }));
    expect(r.mode).toBe('SNIPER');
    expect(r.admit).toBe(true);
  });

  it('NEW_MINT survivor without a qualified mode is forced to SNIPER', () => {
    const r = evaluateNewMintGate(createInput({ combinedScore: 70, pc5m: 2 }));
    expect(r.mode).toBe('SNIPER');
    expect(r.effectiveMinScore).toBe(65);
  });
});

describe('newMintGate — effective min score', () => {
  it('getEffectiveMinScore: 85 for micro wallets, 90 otherwise', () => {
    expect(getEffectiveMinScore(true)).toBe(85);
    expect(getEffectiveMinScore(false)).toBe(90);
  });

  it('micro wallet admits a SNIPER edge at 86 (floor 85)', () => {
    const r = evaluateNewMintGate(createInput({ tier: 'HIGH', combinedScore: 86, qualifiedMode: 'SNIPER', isMicroWallet: true }));
    expect(r.admit).toBe(true);
    expect(r.effectiveMinScore).toBe(85);
  });

  it('micro wallet rejects at 84 (below floor 85)', () => {
    const r = evaluateNewMintGate(createInput({ tier: 'HIGH', combinedScore: 84, qualifiedMode: 'SNIPER', isMicroWallet: true }));
    expect(r.admit).toBe(false);
  });

  it('minScoreOverride wins over the wallet-derived floor', () => {
    const r = evaluateNewMintGate(createInput({ tier: 'HIGH', combinedScore: 82, qualifiedMode: 'SNIPER', minScoreOverride: 70 }));
    expect(r.effectiveMinScore).toBe(70);
    expect(r.admit).toBe(true); // 82 >= 70 and SNIPER@82 clears EDGE_MIN_SCORE 80
  });
});

describe('newMintGate — EDGE_POCKET_ONLY wall', () => {
  it('rejects an outside-pocket token even above the score floor', () => {
    // score 85 clears the micro-wallet floor 85, but HWR is not an EDGE mode
    const r = evaluateNewMintGate(createInput({
      tier: 'HIGH', combinedScore: 85, qualifiedMode: 'HWR', isMicroWallet: true,
    }));
    expect(r.admit).toBe(false);
    expect(r.reason).toContain('outside EDGE_POCKET');
  });

  it('EDGE_POCKET_ONLY=false lifts the pocket wall', () => {
    const r = evaluateNewMintGate(createInput({
      tier: 'HIGH', combinedScore: 85, qualifiedMode: 'HWR', isMicroWallet: true,
      env: { ...defaultEnv, EDGE_POCKET_ONLY: 'false' },
    }));
    expect(r.admit).toBe(true);
  });

  it('high-confidence (>=90) bypasses the pocket wall', () => {
    const r = evaluateNewMintGate(createInput({ tier: 'HIGH', combinedScore: 92, qualifiedMode: 'HWR' }));
    expect(r.admit).toBe(true);
  });

  it('explosive-quality bypasses the pocket wall', () => {
    const r = evaluateNewMintGate(createInput({
      tier: 'HIGH', combinedScore: 91, qualifiedMode: 'HWR',
      mlScore: 85, px5m: 10, volMom: 2,
    }));
    expect(r.admit).toBe(true);
  });
});

describe('newMintGate — entry confirmation (rolling-over guard)', () => {
  it('rejects a sub-90 entry with weak buy-pressure and negative 5m change', () => {
    const r = evaluateNewMintGate(createInput({ combinedScore: 70, bp5m: 0.3, pc5m: -2 }));
    expect(r.admit).toBe(false);
    expect(r.reason).toContain('rolling over');
  });

  it('admits when bp5m clears ENTRY_CONFIRM_MIN_BP', () => {
    const r = evaluateNewMintGate(createInput({ combinedScore: 70, bp5m: 0.6, pc5m: -2 }));
    expect(r.admit).toBe(true);
  });

  it('admits when pc5m clears ENTRY_CONFIRM_MIN_PC5M', () => {
    const r = evaluateNewMintGate(createInput({
      combinedScore: 70, bp5m: 0.3, pc5m: 1,
      env: { ...defaultEnv, ENTRY_CONFIRM_MIN_PC5M: 0.5 },
    }));
    expect(r.admit).toBe(true);
  });

  it('score >= 90 skips the confirmation gate entirely', () => {
    const r = evaluateNewMintGate(createInput({ tier: 'HIGH', combinedScore: 95, qualifiedMode: 'SNIPER', bp5m: 0, pc5m: -5 }));
    expect(r.admit).toBe(true);
  });
});
