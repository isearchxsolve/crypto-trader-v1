/**
 * profit-session.test.ts — unit tests for the data-driven entry-session filters.
 *
 * Encodes the two strongest loss concentrations from the 208-trade shadow ledger:
 *   - UTC hours 0-5 and 20-21 produced ~82% of net loss (win rate 0-33%, avg -3 to -18%)
 *   - the micro-wallet lane (0.005 SOL) was the entire loss (-780 of -811 net)
 */

import { describe, it, expect } from 'vitest';
import {
  inProfitSession,
  getObjectiveEvMargin,
  evaluateEvAdmission,
  peakMomentumMultiplier,
  DEFAULT_BLOCK_HOURS,
  DEFAULT_EV_MARGIN,
  DEFAULT_MICRO_EV_MARGIN,
  DEFAULT_EV_ADMISSION_MIN_LIQ,
  DEFAULT_EV_ADMISSION_MIN_PX5M,
  DEFAULT_EV_ADMISSION_MIN_VOLMOM,
} from './profit-session';

const atHour = (h: number) => new Date(Date.UTC(2026, 7, 16, h, 30, 0));

describe('inProfitSession — block the data-negative UTC hours', () => {
  it('blocks every hour in the default negative set (0-5, 20, 21)', () => {
    for (const h of DEFAULT_BLOCK_HOURS) {
      expect(inProfitSession(atHour(h))).toBe(false);
    }
  });

  it('allows the data-positive hours (8, 12-16)', () => {
    for (const h of [8, 12, 13, 14, 15, 16]) {
      expect(inProfitSession(atHour(h))).toBe(true);
    }
  });

  it('allows all hours when PROFIT_SESSION_FILTER=false', () => {
    for (let h = 0; h < 24; h++) {
      expect(inProfitSession(atHour(h), { PROFIT_SESSION_FILTER: 'false' })).toBe(true);
    }
  });

  it('honors a custom PROFIT_SESSION_BLOCK_HOURS list', () => {
    const env = { PROFIT_SESSION_BLOCK_HOURS: '17,18' };
    expect(inProfitSession(atHour(17), env)).toBe(false);
    expect(inProfitSession(atHour(18), env)).toBe(false);
    // hours outside the custom list are allowed, including default-blocked ones
    expect(inProfitSession(atHour(1), env)).toBe(true);
  });

  it('ignores malformed hour entries in the block list', () => {
    const env = { PROFIT_SESSION_BLOCK_HOURS: '2,99,-1,abc,21' };
    expect(inProfitSession(atHour(2), env)).toBe(false);
    expect(inProfitSession(atHour(21), env)).toBe(false);
    expect(inProfitSession(atHour(3), env)).toBe(true);
  });

  it('treats an empty block list as allow-all', () => {
    expect(inProfitSession(atHour(1), { PROFIT_SESSION_BLOCK_HOURS: '' })).toBe(true);
  });
});

describe('getObjectiveEvMargin — micro wallets need more forward edge', () => {
  it('returns the tighter margin for micro wallets', () => {
    expect(getObjectiveEvMargin(true)).toBe(DEFAULT_MICRO_EV_MARGIN);
    expect(getObjectiveEvMargin(true)).toBeGreaterThan(getObjectiveEvMargin(false));
  });

  it('returns the normal margin for non-micro wallets', () => {
    expect(getObjectiveEvMargin(false)).toBe(DEFAULT_EV_MARGIN);
  });

  it('honors env overrides', () => {
    expect(getObjectiveEvMargin(true, { MICRO_OBJECTIVE_EV_MARGIN: '2.5' })).toBe(2.5);
    expect(getObjectiveEvMargin(false, { OBJECTIVE_EV_MARGIN: '0.5' })).toBe(0.5);
  });

  it('falls back to defaults on invalid env values', () => {
    expect(getObjectiveEvMargin(true, { MICRO_OBJECTIVE_EV_MARGIN: 'abc' })).toBe(DEFAULT_MICRO_EV_MARGIN);
    expect(getObjectiveEvMargin(false, { OBJECTIVE_EV_MARGIN: '-3' })).toBe(DEFAULT_EV_MARGIN);
  });
});

describe('evaluateEvAdmission — forward-EV arbiter for deep-liquidity tokens', () => {
  const base = { netEvPct: 2.5, liqUsd: 150_000, px5m: 12, volMom: 2.4, qualifiedMode: 'MG' as string | null, isMicroWallet: false };

  it('admits a deep-liquidity live mover with positive forward EV', () => {
    const res = evaluateEvAdmission(base);
    expect(res.admit).toBe(true);
  });

  it('rejects thin-liquidity tokens even at positive EV (round-trip cost traps)', () => {
    const res = evaluateEvAdmission({ ...base, liqUsd: 19_500 });
    expect(res.admit).toBe(false);
    expect(res.reason).toMatch(/liq/i);
  });

  it('rejects negative-EV tokens regardless of liquidity', () => {
    const res = evaluateEvAdmission({ ...base, netEvPct: -1.2 });
    expect(res.admit).toBe(false);
    expect(res.reason).toMatch(/EV/i);
  });

  it('admits a mode-less live mover — the $RADON regression', () => {
    // $RADON: passed safety + momentum-aware EV at +1.64% (px5m 21.4%, volMom 3.20)
    // but the old arbiter rejected it for lacking a descriptive mode label. The momentum
    // pocket is the signal now, so a mode-less mover is admitted.
    const res = evaluateEvAdmission({ ...base, netEvPct: 1.64, px5m: 21.4, volMom: 3.2, qualifiedMode: null, isMicroWallet: true });
    expect(res.admit).toBe(true);
    expect(res.reason).toMatch(/mode-less/);
  });

  it('rejects a flat deep-liquidity token below the momentum pocket — the $XERIS regression', () => {
    const res = evaluateEvAdmission({ ...base, px5m: 0.5, volMom: 1.06 });
    expect(res.admit).toBe(false);
    expect(res.reason).toMatch(/momentum/i);
  });

  it('rejects a falling deep-liquidity token below the momentum pocket — the $DEGS regression', () => {
    const res = evaluateEvAdmission({ ...base, px5m: -5.1, volMom: 0.65 });
    expect(res.admit).toBe(false);
    expect(res.reason).toMatch(/momentum/i);
  });

  it('requires BOTH legs of the momentum pocket', () => {
    expect(evaluateEvAdmission({ ...base, px5m: 15, volMom: 1.0 }).admit).toBe(false); // price without volume
    expect(evaluateEvAdmission({ ...base, px5m: 4, volMom: 3.0 }).admit).toBe(false);  // volume without price
    expect(evaluateEvAdmission({ ...base, px5m: 10, volMom: 2.0 }).admit).toBe(true);  // exactly at the bar
  });

  it('applies the tighter micro-wallet margin', () => {
    // netEv 1.2 clears the normal margin (1.0) but not the micro margin (1.5)
    expect(evaluateEvAdmission({ ...base, netEvPct: 1.2, isMicroWallet: false }).admit).toBe(true);
    expect(evaluateEvAdmission({ ...base, netEvPct: 1.2, isMicroWallet: true }).admit).toBe(false);
    expect(evaluateEvAdmission({ ...base, netEvPct: 1.6, isMicroWallet: true }).admit).toBe(true);
  });

  it('is disabled entirely by EV_ADMISSION=false', () => {
    const res = evaluateEvAdmission(base, { EV_ADMISSION: 'false' });
    expect(res.admit).toBe(false);
    expect(res.reason).toMatch(/disabled/i);
  });

  it('honors a custom EV_ADMISSION_MIN_LIQ', () => {
    const env = { EV_ADMISSION_MIN_LIQ: '100000' };
    expect(evaluateEvAdmission({ ...base, liqUsd: 80_000 }, env).admit).toBe(false);
    expect(evaluateEvAdmission({ ...base, liqUsd: 120_000 }, env).admit).toBe(true);
  });

  it('honors custom momentum-pocket thresholds', () => {
    const env = { EV_ADMISSION_MIN_PX5M: '20', EV_ADMISSION_MIN_VOLMOM: '3' };
    expect(evaluateEvAdmission({ ...base, px5m: 15, volMom: 2.5 }, env).admit).toBe(false);
    expect(evaluateEvAdmission({ ...base, px5m: 21, volMom: 3.1 }, env).admit).toBe(true);
  });

  it('exposes the default liquidity floor and momentum pocket', () => {
    expect(DEFAULT_EV_ADMISSION_MIN_LIQ).toBe(50_000);
    expect(DEFAULT_EV_ADMISSION_MIN_PX5M).toBe(10);
    expect(DEFAULT_EV_ADMISSION_MIN_VOLMOM).toBe(2.0);
  });
});

describe('peakMomentumMultiplier — discount the modeled peak when the pool is not moving', () => {
  it('returns 1.0 at the proven edge bar (px5m>=10, volMom>=2.0)', () => {
    expect(peakMomentumMultiplier(10, 2.0)).toBe(1.0);
    expect(peakMomentumMultiplier(25, 4.5)).toBe(1.0); // capped at 1.0
  });

  it('returns 0 for a flat pool (px5m ~0) — the $XERIS regression', () => {
    // $XERIS: px5m +0.5%, volMom 1.06 -> near-zero multiplier -> negative net EV -> rejected
    const m = peakMomentumMultiplier(0.5, 1.06);
    expect(m).toBeLessThan(0.25);
    expect(peakMomentumMultiplier(0, 1.06)).toBe(0.4 * (1.06 / 2)); // price drive 0
  });

  it('returns 0 for a falling pool (px5m < 0) — the $DEGS regression', () => {
    // $DEGS: px5m -5.1%, volMom 0.65 -> price drive 0 -> tiny multiplier -> rejected
    const m = peakMomentumMultiplier(-5.1, 0.65);
    expect(m).toBeLessThan(0.2);
    expect(peakMomentumMultiplier(-5.1, 0.65)).toBeCloseTo(0.4 * (0.65 / 2), 5);
  });

  it('scales proportionally between flat and the edge bar', () => {
    // px5m 5 (half of 10), volMom 1.0 (half of 2.0) -> 0.6*0.5 + 0.4*0.5 = 0.5
    expect(peakMomentumMultiplier(5, 1.0)).toBeCloseTo(0.5, 5);
  });

  it('treats zero/negative volume momentum as no confirmation', () => {
    expect(peakMomentumMultiplier(10, 0)).toBeCloseTo(0.6, 5);
    expect(peakMomentumMultiplier(10, -1)).toBeCloseTo(0.6, 5);
  });

  it('is disabled by PEAK_MOMENTUM=false (restores liquidity-only peak)', () => {
    expect(peakMomentumMultiplier(0.5, 1.06, { PEAK_MOMENTUM: 'false' })).toBe(1.0);
    expect(peakMomentumMultiplier(-5.1, 0.65, { PEAK_MOMENTUM: 'false' })).toBe(1.0);
  });
});
