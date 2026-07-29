/**
 * exit-anchors.test.ts — verifies the moonshot throughput tuning surface.
 *
 * The STAGNANT_GREEN_KILL and DIP_RECOVERY_FAILED anchors in routes.ts were
 * hardcoded magic numbers (1500s / 1800s) — the throughput simulation flagged
 * them as the named ceiling on moonshot throughput (25% of trades held 25-30min).
 *
 * This test confirms the anchors are now env-tunable (STAGNANT_GREEN_KILL_SECONDS,
 * DIP_RECOVERY_FAILED_SECONDS), mirroring the existing MAX_HOLD_SECONDS_OVERRIDE
 * pattern. It does NOT assert what the right value is — that requires forward/paper
 * data. It only asserts the tuning knob exists and is wired.
 *
 * Scope: static verification that the env override expressions are present in the
 * production source. This protects against regression (someone re-hardcoding them).
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const routesSource = readFileSync(resolve(__dirname, 'routes.ts'), 'utf-8');

describe('moonshot throughput tuning surface — exit anchors are env-tunable', () => {
  it('STAGNANT_GREEN_KILL reads STAGNANT_GREEN_KILL_SECONDS env (default 1500)', () => {
    // The override expression must be present in the production exit branch
    expect(routesSource).toContain('process.env.STAGNANT_GREEN_KILL_SECONDS');
    // Default of 1500 must be preserved (zero behavior change unless env set)
    expect(routesSource).toMatch(/STAGNANT_GREEN_KILL_SECONDS\)\s*\|\|\s*1500/);
  });

  it('DIP_RECOVERY_FAILED reads DIP_RECOVERY_FAILED_SECONDS env (default 1800)', () => {
    expect(routesSource).toContain('process.env.DIP_RECOVERY_FAILED_SECONDS');
    expect(routesSource).toMatch(/DIP_RECOVERY_FAILED_SECONDS\)\s*\|\|\s*1800/);
  });

  it('MAX_HOLD_SECONDS_OVERRIDE pattern still present (pre-existing TIME_EXIT knob)', () => {
    // Regression guard: the existing env-tunable TIME_EXIT anchor must still be wired
    expect(routesSource).toContain('process.env.MAX_HOLD_SECONDS_OVERRIDE');
    expect(routesSource).toMatch(/MAX_HOLD_SECONDS_OVERRIDE\)\s*\|\|\s*300/);
  });

  it('all three throughput anchors are env-tunable (no hardcoded magic numbers remain)', () => {
    // The old hardcoded forms must be gone — replaced by env-override expressions
    // STAGNANT_GREEN_KILL: was `holdTime > 1500`, now `holdTime > (Number(process.env.STAGNANT_GREEN_KILL_SECONDS) || 1500)`
    expect(routesSource).not.toMatch(/holdTime\s*>\s*1500\s*&&\s*pnlPct\s*>=\s*0/);
    // DIP_RECOVERY_FAILED: was `holdTime > 1800`, now env-override
    expect(routesSource).not.toMatch(/holdTime\s*>\s*1800\s*&&\s*pnlPct\s*<\s*0/);
  });
});
