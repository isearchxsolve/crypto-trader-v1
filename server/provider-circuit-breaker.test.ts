/**
 * provider-circuit-breaker.test.ts — Unit tests for the circuit breaker and
 * provider registry / degraded-mode fallback logic.
 *
 * Tests the REAL exported API of provider-circuit-breaker.ts:
 *   - CircuitBreaker: CLOSED → OPEN → HALF_OPEN → CLOSED lifecycle
 *   - ProviderRegistry: per-provider breakers + degraded-mode evaluation
 *   - withCircuitBreaker / isProviderAvailable helpers
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  CircuitBreaker,
  ProviderRegistry,
  providerRegistry,
  withCircuitBreaker,
  getDegradedMode,
  evaluateDegradedMode,
  isProviderAvailable,
} from './provider-circuit-breaker';

const FAST_CONFIG = {
  failureThreshold: 2,
  successThreshold: 1,
  timeoutMs: 1_000,
  halfOpenMaxRequests: 3,
};

async function tripBreaker(breaker: CircuitBreaker, failures: number): Promise<void> {
  for (let i = 0; i < failures; i++) {
    await expect(breaker.execute(() => Promise.reject(new Error('fail')))).rejects.toThrow();
  }
}

describe('CircuitBreaker', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('starts CLOSED and passes calls through', async () => {
    const breaker = new CircuitBreaker('gmgn', FAST_CONFIG);
    expect(breaker.getState()).toBe('CLOSED');
    await expect(breaker.execute(() => Promise.resolve('ok'))).resolves.toBe('ok');
    expect(breaker.getState()).toBe('CLOSED');
  });

  it('opens after failureThreshold consecutive failures', async () => {
    const breaker = new CircuitBreaker('gmgn', FAST_CONFIG);
    await tripBreaker(breaker, 2);
    expect(breaker.getState()).toBe('OPEN');
  });

  it('does not open when a success resets the failure streak before threshold', async () => {
    const breaker = new CircuitBreaker('gmgn', { ...FAST_CONFIG, failureThreshold: 3 });
    await tripBreaker(breaker, 2);
    await breaker.execute(() => Promise.resolve('ok')); // resets streak
    await tripBreaker(breaker, 2);
    expect(breaker.getState()).toBe('CLOSED'); // streak restarted, only 2 consecutive
  });

  it('rejects immediately while OPEN without invoking the function', async () => {
    const breaker = new CircuitBreaker('gmgn', FAST_CONFIG);
    await tripBreaker(breaker, 2);
    const fn = vi.fn(() => Promise.resolve('should not run'));
    await expect(breaker.execute(fn)).rejects.toThrow(/OPEN/);
    expect(fn).not.toHaveBeenCalled();
  });

  it('transitions to HALF_OPEN after timeoutMs and closes on probe success', async () => {
    const breaker = new CircuitBreaker('gmgn', FAST_CONFIG);
    await tripBreaker(breaker, 2);
    expect(breaker.getState()).toBe('OPEN');

    vi.advanceTimersByTime(1_000);
    expect(breaker.getState()).toBe('HALF_OPEN');

    await expect(breaker.execute(() => Promise.resolve('recovered'))).resolves.toBe('recovered');
    expect(breaker.getState()).toBe('CLOSED');
  });

  it('reopens on failure while HALF_OPEN', async () => {
    const breaker = new CircuitBreaker('gmgn', FAST_CONFIG);
    await tripBreaker(breaker, 2);
    vi.advanceTimersByTime(1_000);
    expect(breaker.getState()).toBe('HALF_OPEN');

    await expect(breaker.execute(() => Promise.reject(new Error('still broken')))).rejects.toThrow();
    expect(breaker.getState()).toBe('OPEN');
  });

  it('caps concurrent probes at halfOpenMaxRequests', async () => {
    const breaker = new CircuitBreaker('gmgn', { ...FAST_CONFIG, halfOpenMaxRequests: 1, successThreshold: 5 });
    await tripBreaker(breaker, 2);
    vi.advanceTimersByTime(1_000);

    // First probe allowed but never resolves; second probe is rejected by the cap.
    let release!: () => void;
    const pending = breaker.execute(() => new Promise<string>(resolve => { release = () => resolve('late'); }));
    await expect(breaker.execute(() => Promise.resolve('too many'))).rejects.toThrow(/HALF_OPEN limit/);
    release();
    await pending;
  });

  it('reports health counters and latency', async () => {
    const breaker = new CircuitBreaker('helius', FAST_CONFIG);
    await breaker.execute(() => Promise.resolve('ok'));
    await tripBreaker(breaker, 1);

    const health = breaker.getHealth();
    expect(health.name).toBe('helius');
    expect(health.totalRequests).toBe(2);
    expect(health.totalFailures).toBe(1);
    expect(health.avgLatencyMs).toBeGreaterThanOrEqual(0);
  });

  it('reset() returns the breaker to CLOSED', async () => {
    const breaker = new CircuitBreaker('gmgn', FAST_CONFIG);
    await tripBreaker(breaker, 2);
    expect(breaker.getState()).toBe('OPEN');
    breaker.reset();
    expect(breaker.getState()).toBe('CLOSED');
  });
});

describe('ProviderRegistry', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('starts in FULL degraded mode with all providers available', () => {
    const registry = new ProviderRegistry();
    expect(registry.getDegradedMode()).toBe('FULL');
    expect(registry.evaluateDegradedMode()).toBe('FULL');
    expect(registry.isProviderAvailable('gmgn')).toBe(true);
    expect(registry.isProviderAvailable('ml_server')).toBe(true);
  });

  it('degrades to DEX_ONLY when gmgn trips but dex+helius stay up', async () => {
    const registry = new ProviderRegistry();
    await tripBreaker(registry.getBreaker('gmgn'), 5); // gmgn default threshold = 5
    expect(registry.evaluateDegradedMode()).toBe('DEX_ONLY');
    expect(registry.isProviderAvailable('gmgn')).toBe(false);
  });

  it('degrades to ML_ONLY when only ml_server remains closed', async () => {
    const registry = new ProviderRegistry();
    await tripBreaker(registry.getBreaker('gmgn'), 5);
    await tripBreaker(registry.getBreaker('dexscreener'), 5);
    await tripBreaker(registry.getBreaker('helius'), 3); // helius default threshold = 3
    expect(registry.evaluateDegradedMode()).toBe('ML_ONLY');
  });

  it('degrades to OFFLINE when every provider has tripped', async () => {
    const registry = new ProviderRegistry();
    await tripBreaker(registry.getBreaker('gmgn'), 5);
    await tripBreaker(registry.getBreaker('dexscreener'), 5);
    await tripBreaker(registry.getBreaker('helius'), 3);
    await tripBreaker(registry.getBreaker('ml_server'), 3);
    await tripBreaker(registry.getBreaker('rugcheck'), 5);
    expect(registry.evaluateDegradedMode()).toBe('OFFLINE');
  });

  it('resetAll() restores FULL mode', async () => {
    const registry = new ProviderRegistry();
    await tripBreaker(registry.getBreaker('gmgn'), 5);
    registry.evaluateDegradedMode();
    registry.resetAll();
    expect(registry.getDegradedMode()).toBe('FULL');
    expect(registry.getBreaker('gmgn').getState()).toBe('CLOSED');
  });

  it('getAllHealth() reports one entry per provider', () => {
    const registry = new ProviderRegistry();
    const health = registry.getAllHealth();
    expect(health.map(h => h.name).sort()).toEqual(
      ['dexscreener', 'gmgn', 'helius', 'ml_server', 'rugcheck'].sort()
    );
  });
});

describe('singleton helpers', () => {
  afterEach(() => {
    providerRegistry.resetAll();
  });

  it('withCircuitBreaker routes through the shared registry', async () => {
    await expect(withCircuitBreaker('rugcheck', () => Promise.resolve(42))).resolves.toBe(42);
  });

  it('isProviderAvailable / getDegradedMode / evaluateDegradedMode reflect the singleton', () => {
    expect(isProviderAvailable('dexscreener')).toBe(true);
    expect(getDegradedMode()).toBe('FULL');
    expect(evaluateDegradedMode()).toBe('FULL');
  });
});
