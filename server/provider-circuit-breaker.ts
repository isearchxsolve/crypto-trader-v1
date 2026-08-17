/**
 * provider-circuit-breaker.ts — Circuit breaker + degraded-mode fallback for external providers.
 *
 * Provides:
 *   - CircuitBreaker class with configurable failure threshold, timeout, half-open probe
 *   - ProviderRegistry to manage multiple providers (GMGN, DexScreener, Helius, ML)
 *   - DegradedMode enum: FULL | DEX_ONLY | ML_ONLY | OFFLINE
 *   - Automatic fallback chain when providers trip
 *   - Health metrics for observability
 */

export type ProviderName = 'gmgn' | 'dexscreener' | 'helius' | 'ml_server' | 'rugcheck';

export type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

export type DegradedMode = 'FULL' | 'DEX_ONLY' | 'ML_ONLY' | 'OFFLINE';

export interface CircuitBreakerConfig {
  failureThreshold: number;      // consecutive failures before OPEN
  successThreshold: number;      // consecutive successes in HALF_OPEN before CLOSE
  timeoutMs: number;             // time in OPEN before transitioning to HALF_OPEN
  halfOpenMaxRequests: number;   // max requests allowed in HALF_OPEN
}

export interface ProviderHealth {
  name: ProviderName;
  state: CircuitState;
  consecutiveFailures: number;
  consecutiveSuccesses: number;
  lastFailure?: number;
  lastSuccess?: number;
  totalRequests: number;
  totalFailures: number;
  avgLatencyMs: number;
}

const DEFAULT_CONFIG: Record<ProviderName, CircuitBreakerConfig> = {
  gmgn: { failureThreshold: 5, successThreshold: 3, timeoutMs: 30_000, halfOpenMaxRequests: 3 },
  dexscreener: { failureThreshold: 5, successThreshold: 3, timeoutMs: 30_000, halfOpenMaxRequests: 3 },
  helius: { failureThreshold: 3, successThreshold: 2, timeoutMs: 60_000, halfOpenMaxRequests: 2 },
  ml_server: { failureThreshold: 3, successThreshold: 2, timeoutMs: 15_000, halfOpenMaxRequests: 2 },
  rugcheck: { failureThreshold: 5, successThreshold: 3, timeoutMs: 30_000, halfOpenMaxRequests: 3 },
};

export class CircuitBreaker {
  private config: CircuitBreakerConfig;
  private state: CircuitState = 'CLOSED';
  private consecutiveFailures = 0;
  private consecutiveSuccesses = 0;
  private lastFailure?: number;
  private lastSuccess?: number;
  private totalRequests = 0;
  private totalFailures = 0;
  private latencySum = 0;
  private latencyCount = 0;
  private halfOpenRequests = 0;

  constructor(private name: ProviderName, config?: Partial<CircuitBreakerConfig>) {
    this.config = { ...DEFAULT_CONFIG[name], ...config };
  }

  getState(): CircuitState {
    if (this.state === 'OPEN') {
      const now = Date.now();
      if (now - (this.lastFailure ?? 0) >= this.config.timeoutMs) {
        this.state = 'HALF_OPEN';
        this.halfOpenRequests = 0;
        this.consecutiveSuccesses = 0;
      }
    }
    return this.state;
  }

  getHealth(): ProviderHealth {
    return {
      name: this.name,
      state: this.getState(),
      consecutiveFailures: this.consecutiveFailures,
      consecutiveSuccesses: this.consecutiveSuccesses,
      lastFailure: this.lastFailure,
      lastSuccess: this.lastSuccess,
      totalRequests: this.totalRequests,
      totalFailures: this.totalFailures,
      avgLatencyMs: this.latencyCount > 0 ? this.latencySum / this.latencyCount : 0,
    };
  }

  async execute<T>(fn: () => Promise<T>): Promise<T> {
    const state = this.getState();
    if (state === 'OPEN') {
      throw new Error(`Circuit breaker ${this.name} is OPEN`);
    }
    if (state === 'HALF_OPEN') {
      if (this.halfOpenRequests >= this.config.halfOpenMaxRequests) {
        throw new Error(`Circuit breaker ${this.name} HALF_OPEN limit reached`);
      }
      this.halfOpenRequests++;
    }
    const start = Date.now();
    this.totalRequests++;
    try {
      const result = await fn();
      const latency = Date.now() - start;
      this.latencySum += latency;
      this.latencyCount++;
      this.onSuccess();
      return result;
    } catch (error) {
      const latency = Date.now() - start;
      this.latencySum += latency;
      this.latencyCount++;
      this.onFailure();
      throw error;
    }
  }

  private onSuccess() {
    this.consecutiveFailures = 0;
    this.consecutiveSuccesses++;
    this.lastSuccess = Date.now();
    if (this.state === 'HALF_OPEN' && this.consecutiveSuccesses >= this.config.successThreshold) {
      this.state = 'CLOSED';
      this.consecutiveSuccesses = 0;
      this.halfOpenRequests = 0;
    }
  }

  private onFailure() {
    this.consecutiveFailures++;
    this.totalFailures++;
    this.lastFailure = Date.now();
    if (this.state === 'HALF_OPEN') {
      this.state = 'OPEN';
      this.halfOpenRequests = 0;
    } else if (this.state === 'CLOSED' && this.consecutiveFailures >= this.config.failureThreshold) {
      this.state = 'OPEN';
    }
  }

  reset() {
    this.state = 'CLOSED';
    this.consecutiveFailures = 0;
    this.consecutiveSuccesses = 0;
  }
}

export class ProviderRegistry {
  private breakers = new Map<ProviderName, CircuitBreaker>();
  private degradedMode: DegradedMode = 'FULL';

  constructor() {
    for (const name of ['gmgn', 'dexscreener', 'helius', 'ml_server', 'rugcheck'] as ProviderName[]) {
      this.breakers.set(name, new CircuitBreaker(name));
    }
  }

  getBreaker(name: ProviderName): CircuitBreaker {
    return this.breakers.get(name)!;
  }

  async execute<T>(name: ProviderName, fn: () => Promise<T>): Promise<T> {
    return this.breakers.get(name)!.execute(fn);
  }

  getHealth(name: ProviderName): ProviderHealth {
    return this.breakers.get(name)!.getHealth();
  }

  getAllHealth(): ProviderHealth[] {
    return Array.from(this.breakers.values()).map(b => b.getHealth());
  }

  getDegradedMode(): DegradedMode {
    return this.degradedMode;
  }

  evaluateDegradedMode(): DegradedMode {
    const health = this.getAllHealth();
    const gmgn = health.find(h => h.name === 'gmgn')!;
    const dexscreener = health.find(h => h.name === 'dexscreener')!;
    const helius = health.find(h => h.name === 'helius')!;
    const ml = health.find(h => h.name === 'ml_server')!;

    // Priority: FULL > DEX_ONLY > ML_ONLY > OFFLINE
    if (gmgn.state === 'CLOSED' && dexscreener.state === 'CLOSED' && helius.state === 'CLOSED') {
      this.degradedMode = 'FULL';
    } else if (dexscreener.state === 'CLOSED' && helius.state === 'CLOSED') {
      this.degradedMode = 'DEX_ONLY';
    } else if (ml.state === 'CLOSED') {
      this.degradedMode = 'ML_ONLY';
    } else {
      this.degradedMode = 'OFFLINE';
    }
    return this.degradedMode;
  }

  isProviderAvailable(name: ProviderName): boolean {
    return this.breakers.get(name)!.getState() !== 'OPEN';
  }

  resetAll() {
    for (const b of this.breakers.values()) b.reset();
    this.degradedMode = 'FULL';
  }
}

// Singleton instance
export const providerRegistry = new ProviderRegistry();

// Helper for callers
export async function withCircuitBreaker<T>(name: ProviderName, fn: () => Promise<T>): Promise<T> {
  return providerRegistry.execute(name, fn);
}

export function getDegradedMode(): DegradedMode {
  return providerRegistry.getDegradedMode();
}

export function evaluateDegradedMode(): DegradedMode {
  return providerRegistry.evaluateDegradedMode();
}

export function isProviderAvailable(name: ProviderName): boolean {
  return providerRegistry.isProviderAvailable(name);
}
