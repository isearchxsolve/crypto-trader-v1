/**
 * composite-scorer.test.ts — Unit tests for composite scorer fusion logic
 */
import { describe, it, expect } from 'vitest';
import {
  compositeScore,
  scoreTier,
  modeQualify,
  CompositeInput,
  DEFAULT_WEIGHTS
} from './composite-scorer';

describe('composite-scorer', () => {
  const baseInput: CompositeInput = {
    goldScore: 70,
    goldTier: 'HIGH',
    mlScore: 80,
    beastScore: 75,
    beastVerdict: 'PASS',
    bp5m: 0.65,
    pc5m: 2.5,
    volMom: 1.8,
    holderCount: 1200,
    liquidityUsd: 50000,
    marketCap: 200000,
    ageHours: 4,
  };

  it('should compute weighted composite correctly', () => {
    const result = compositeScore(baseInput);
    // gold: 70 * 0.35 = 24.5
    // ml: 80 * 0.30 = 24
    // beast: 75 * 0.25 = 18.75
    // confirm: bp5m 0.65->13, pc5m 2.5->10, volMom 1.8->9 = 32 * 0.10 = 3.2
    // total = 24.5 + 24 + 18.75 + 3.2 = 70.45
    expect(result.combinedScore).toBeCloseTo(70.45, 1);
    expect(result.breakdown.gold).toBeCloseTo(24.5, 1);
    expect(result.breakdown.ml).toBeCloseTo(24, 1);
    expect(result.breakdown.beast).toBeCloseTo(18.75, 1);
    expect(result.breakdown.confirmation).toBeCloseTo(3.2, 1);
  });

  it('should return VETO tier when beast verdict is VETO', () => {
    const input = { ...baseInput, beastVerdict: 'VETO' as const };
    const result = compositeScore(input);
    expect(result.tier).toBe('VETO');
    expect(result.mode).toBeNull();
  });

  it('should qualify LEGENDARY tier correctly', () => {
    const input = { ...baseInput, goldScore: 85, goldTier: 'LEGENDARY' as const };
    const result = compositeScore(input);
    expect(result.tier).toBe('LEGENDARY');
  });

  it('should qualify HIGH tier correctly', () => {
    const input = { ...baseInput, goldScore: 60, goldTier: 'HIGH' as const };
    const result = compositeScore(input);
    expect(result.tier).toBe('HIGH');
  });

  it('should qualify MEDIUM tier correctly', () => {
    const input = { ...baseInput, goldScore: 40, goldTier: 'MEDIUM' as const };
    const result = compositeScore(input);
    expect(result.tier).toBe('MEDIUM');
  });

  it('should qualify SNIPER mode for LEGENDARY with confirmations', () => {
    const input = { ...baseInput, goldTier: 'LEGENDARY' as const, goldScore: 80, bp5m: 0.7, pc5m: 3, volMom: 2 };
    const result = compositeScore(input);
    expect(result.mode).toBe('SNIPER');
  });

  it('should qualify EDGE mode for HIGH with strong confirmations', () => {
    const input = { ...baseInput, goldTier: 'HIGH' as const, goldScore: 65, bp5m: 0.75, pc5m: 4, volMom: 2.5 };
    const result = compositeScore(input);
    expect(result.mode).toBe('EDGE');
  });

  it('should qualify EXPLOSIVE mode for MEDIUM with extreme confirmations', () => {
    const input = { ...baseInput, goldTier: 'MEDIUM' as const, goldScore: 50, bp5m: 0.9, pc5m: 10, volMom: 5 };
    const result = compositeScore(input);
    expect(result.mode).toBe('EXPLOSIVE');
  });

  it('should return null mode when confirmations insufficient', () => {
    const input = { ...baseInput, bp5m: 0.3, pc5m: -1, volMom: 0.5 };
    const result = compositeScore(input);
    expect(result.mode).toBeNull();
  });

  it('should clamp scores to 0-100 range', () => {
    const input = { ...baseInput, goldScore: 150, mlScore: -10, beastScore: 200 };
    const result = compositeScore(input);
    expect(result.combinedScore).toBeLessThanOrEqual(100);
    expect(result.combinedScore).toBeGreaterThanOrEqual(0);
  });

  it('should handle missing optional fields gracefully', () => {
    const minimalInput: CompositeInput = {
      goldScore: 50,
      goldTier: 'MEDIUM',
      mlScore: 50,
      beastScore: 50,
      beastVerdict: 'PASS',
    };
    const result = compositeScore(minimalInput);
    expect(result.combinedScore).toBeGreaterThanOrEqual(0);
    expect(result.tier).toBeDefined();
  });

  it('should expose the documented fusion weights', () => {
    expect(DEFAULT_WEIGHTS.gold).toBeCloseTo(0.35, 5);
    expect(DEFAULT_WEIGHTS.ml).toBeCloseTo(0.30, 5);
    expect(DEFAULT_WEIGHTS.beast).toBeCloseTo(0.25, 5);
    expect(DEFAULT_WEIGHTS.confirmation).toBeCloseTo(0.10, 5);
  });
});

describe('scoreTier', () => {
  it('should map scores to correct tiers', () => {
    expect(scoreTier(85)).toBe('LEGENDARY');
    expect(scoreTier(75)).toBe('LEGENDARY');
    expect(scoreTier(74)).toBe('HIGH');
    expect(scoreTier(55)).toBe('HIGH');
    expect(scoreTier(50)).toBe('HIGH');
    expect(scoreTier(49)).toBe('MEDIUM');
    expect(scoreTier(35)).toBe('MEDIUM');
    expect(scoreTier(34)).toBe('SKIP');
    expect(scoreTier(10)).toBe('SKIP');
  });
});

describe('modeQualify', () => {
  it('should return SNIPER for LEGENDARY with strong bp5m', () => {
    expect(modeQualify('LEGENDARY', 80, 0.7, 3, 2)).toBe('SNIPER');
  });

  it('should return EDGE for HIGH with strong confirmations', () => {
    expect(modeQualify('HIGH', 65, 0.75, 4, 2.5)).toBe('EDGE');
  });

  it('should return EXPLOSIVE for MEDIUM with extreme confirmations', () => {
    expect(modeQualify('MEDIUM', 50, 0.9, 10, 5)).toBe('EXPLOSIVE');
  });

  it('should return null for insufficient confirmations', () => {
    expect(modeQualify('HIGH', 60, 0.3, -1, 0.5)).toBeNull();
  });
});
