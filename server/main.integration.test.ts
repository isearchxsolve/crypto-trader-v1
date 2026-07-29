/**
 * main.integration.test.ts — INTEGRATION TESTS FOR routes.ts EXPORTED FUNCTIONS
 *
 * Scope: exercises the REAL exported functions of server/routes.ts that are NOT
 * covered by the other gated test files:
 *   - tests/smoke.test.ts            → import-boundary (routes.ts + jupiter.ts parse cleanly)
 *   - server/routes.http.test.ts     → HTTP surface via registerRoutes() (5 endpoints)
 *   - server/jupiter.integration.test.ts → JupiterService buy/hold/sell (27 tests)
 *   - THIS FILE                      → executeEnhancedEdgeFilter + getShadowTrades/setShadowModeEnabled
 *
 * MOCK STRATEGY (lifted from routes.http.test.ts, the proven-green scaffold):
 *   - vi.mock('./server/storage')          → storage + initStorageWrapper (DB gone)
 *   - vi.mock('./server/jupiter')          → createJupiterService → null (no live RPC)
 *   - vi.mock('./server/advanced_filters') → checkAdvancedFilters (Helius/DexScreener gone)
 *   - vi.mock('./server/runtime-hooks')    → startHeartbeat (fs write gone), isHalted
 *   - vi.mock('./server/gold_standard_hunter') → all pollers/fetchers (GMGN/DexScreener gone)
 *   - vi.mock('./server/lib/newMintGate')  → evaluateNewMintGate (pure gate, safe)
 *   - global.fetch stub                    → all outbound HTTP
 *
 * TIMERS: REAL timers (NOT fake). The trading engine uses recursive setTimeout
 * scheduling that fake timers cannot flush through pending awaits — this is the
 * exact failure that broke the prior version of this file (beforeEach hung at
 * 10s). The green routes.http.test.ts uses real timers for the same reason.
 * We do NOT call registerRoutes() here (the HTTP block lives in routes.http.test.ts),
 * so no engine boot and no timer-flush is needed at all.
 */

import { vi, describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';

// ──────────────────────────────────────────────────────────────────────────────
// 1. GLOBAL ENV + MOCKS (hoisted before any import of routes.ts)
// ──────────────────────────────────────────────────────────────────────────────

process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/test';
process.env.ADMIN_SECRET = 'test-admin-secret';
process.env.WALLET_PRIVATE_KEY = ''; // ensure createJupiterService returns null
process.env.QUALITY_REQUIRE_JUPITER_VERIFIED = 'false';
process.env.NODE_ENV = 'test';

// ---- storage mock (complete DB surface used by routes.ts) ----
const mockStorage = {
  getBotStatus: vi.fn().mockResolvedValue({
    isRunning: false,
    paperMode: true,
    startingBalance: 10,
    currentBalance: 10,
    totalTrades: 0,
    winningTrades: 0,
    totalPnl: 0,
    maxDrawdown: 0,
    winRate: 0,
    avgHoldTime: 0,
  }),
  getTrades: vi.fn().mockResolvedValue([]),
  getEngineStats: vi.fn().mockResolvedValue({
    totalScans: 0,
    tokensAnalyzed: 0,
    signalsGenerated: 0,
    buysExecuted: 0,
    sellsExecuted: 0,
    errors: 0,
    uptime: 0,
  }),
  getRiskStatus: vi.fn().mockResolvedValue({
    circuitBreakerActive: false,
    dailyLoss: 0,
    dailyLossLimit: 50,
    consecutiveLosses: 0,
    maxConsecutiveLosses: 3,
    currentDrawdown: 0,
    maxDrawdownLimit: 20,
  }),
  getSettings: vi.fn().mockResolvedValue({}),
  updateSettings: vi.fn().mockResolvedValue(undefined),
  seedInitialData: vi.fn().mockResolvedValue(undefined),
  getShadowTrades: vi.fn().mockResolvedValue({ open: [], closed: [] }),
  addShadowTrade: vi.fn().mockResolvedValue(undefined),
  updateShadowTrade: vi.fn().mockResolvedValue(undefined),
  closeShadowTrade: vi.fn().mockResolvedValue(undefined),
};

vi.mock('./server/storage', () => ({
  storage: mockStorage,
  initStorageWrapper: vi.fn().mockResolvedValue(undefined),
}));

// ---- jupiter mock (createJupiterService → null so no live RPC is constructed) ----
vi.mock('./server/jupiter', () => ({
  JupiterService: vi.fn(),
  createJupiterService: vi.fn().mockReturnValue(null),
  SOL_MINT: 'So11111111111111111111111111111111111111112',
  MIN_FEE_BUFFER_SOL: 0.004,
  getLatencyLog: vi.fn().mockReturnValue([]),
  clearLatencyLog: vi.fn(),
}));

// ---- advanced_filters mock (checkAdvancedFilters calls Helius/DexScreener fetch) ----
vi.mock('./server/advanced_filters', () => ({
  checkAdvancedFilters: vi.fn().mockResolvedValue({
    passed: true,
    score: 85,
    details: { liquidity: 50000, volume24h: 100000, holders: 500 },
  }),
}));

// ---- runtime-hooks mock (startHeartbeat writes .heartbeat file every 5s) ----
vi.mock('./server/runtime-hooks', () => ({
  startHeartbeat: vi.fn(),
  isHalted: vi.fn().mockReturnValue(false),
  healthState: { healthy: true, lastCheck: Date.now() },
}));

// ---- gold_standard_hunter mock (pollers do network fetches) ----
vi.mock('./server/gold_standard_hunter', () => ({
  runHunter: vi.fn().mockResolvedValue(undefined),
  checkMint: vi.fn().mockResolvedValue({ passed: true, score: 90 }),
  pollSignalFeed: vi.fn().mockResolvedValue([]),
  pollTrending: vi.fn().mockResolvedValue([]),
  pollTrenches: vi.fn().mockResolvedValue([]),
  pollSmartMoneyFeed: vi.fn().mockResolvedValue([]),
  pollDexScreenerFeeds: vi.fn().mockResolvedValue([]),
}));

// ---- newMintGate mock (pure gate, but safe to stub) ----
vi.mock('./server/lib/newMintGate', () => ({
  evaluateNewMintGate: vi.fn().mockReturnValue({ passed: true, score: 80, reason: 'ok' }),
  GateInput: {},
}));

// ---- global.fetch stub (catches all outbound HTTP not covered above) ----
const fetchMock = vi.fn().mockImplementation((url: string | URL) => {
  const u = String(url);
  if (u.includes('api.rugcheck.xyz')) {
    return Promise.resolve({
      ok: true,
      json: () => Promise.resolve({ score: 0.1, risks: [], token: { mint: 'MOCK', supply: 1000000 } }),
    } as Response);
  }
  if (u.includes('api.dexscreener.com')) {
    return Promise.resolve({
      ok: true,
      json: () => Promise.resolve({ pairs: [{ baseToken: { address: 'MOCK' }, liquidity: { usd: 50000 }, volume: { h24: 100000 } }] }),
    } as Response);
  }
  if (u.includes('public-api.birdeye.so')) {
    return Promise.resolve({
      ok: true,
      json: () => Promise.resolve({ data: { items: [] } }),
    } as Response);
  }
  if (u.includes('gmgn.ai')) {
    return Promise.resolve({
      ok: true,
      json: () => Promise.resolve({ data: { holders: 500, smartMoney: 5 } }),
    } as Response);
  }
  return Promise.resolve({
    ok: true,
    json: () => Promise.resolve({}),
  } as Response);
});

vi.stubGlobal('fetch', fetchMock);

// ---- fs.writeFileSync spy (silences .heartbeat writes if any mock leaks) ----
const writeFileSyncSpy = vi.spyOn(fs, 'writeFileSync').mockImplementation(() => {});

// ──────────────────────────────────────────────────────────────────────────────
// 2. TEST SUITE — imports routes.ts AFTER mocks are in place
// ──────────────────────────────────────────────────────────────────────────────

describe('routes.ts exported functions — real code paths against mocked deps', () => {
  // REAL timers — no registerRoutes() boot, so no engine setTimeout to flush.
  beforeAll(() => {
    // no-op; real timers
  });

  afterAll(() => {
    writeFileSyncSpy.mockRestore();
  });

  // ════════════════════════════════════════════════════════════════════════════
  // getShadowTrades / setShadowModeEnabled — exported getter/setter round-trip
  // ════════════════════════════════════════════════════════════════════════════

  describe('getShadowTrades / setShadowModeEnabled', () => {
    it('getShadowTrades returns the documented shape { open: [], closed: [] }', async () => {
      const { getShadowTrades } = await import('./routes');
      const result = getShadowTrades();
      expect(result).toHaveProperty('open');
      expect(result).toHaveProperty('closed');
      expect(Array.isArray(result.open)).toBe(true);
      expect(Array.isArray(result.closed)).toBe(true);
    });

    it('setShadowModeEnabled(true) then getShadowTrades() round-trips without error', async () => {
      const { setShadowModeEnabled, getShadowTrades } = await import('./routes');
      setShadowModeEnabled(true);
      const result = getShadowTrades();
      expect(result).toHaveProperty('open');
      expect(result).toHaveProperty('closed');
      setShadowModeEnabled(false); // reset
    });
  });

  // ════════════════════════════════════════════════════════════════════════════
  // executeEnhancedEdgeFilter — scored decision against mocked fetch/filters
  // ════════════════════════════════════════════════════════════════════════════

  describe('executeEnhancedEdgeFilter', () => {
    // Real return type (routes.ts:172): { allowed: boolean; reason: string; edgeScore: number }
    // Real field reads: dexPair.liquidity.usd, dexPair.volume.m5, dexPair.priceChange.m5,
    //                   dexPair.marketCap|fdv; signal.gmgn.creation_timestamp, signal.score
    it('returns a scored decision object { allowed, reason, edgeScore } for a candidate', async () => {
      const { executeEnhancedEdgeFilter } = await import('./routes');

      const mockSignal = {
        mint: 'TEST_MINT_123',
        symbol: 'TEST',
        name: 'Test Token',
        score: 70, // goldScore contribution: 70 * 0.4 = 28
        gmgn: { creation_timestamp: Date.now() / 1000 - 120, bonding_currency: 'sol' },
      };

      // Strong candidate: high liquidity, big 5m move, healthy volume/m5 -> should be allowed
      const mockDexPair = {
        baseToken: { address: 'TEST_MINT_123', symbol: 'TEST' },
        liquidity: { usd: 200000 },
        volume: { m5: 800000, h24: 5000000 },
        priceChange: { m5: 40 }, // 40% in 5m — strong edge
        marketCap: 1_000_000,
        priceUsd: 0.0001,
      };

      const result = await executeEnhancedEdgeFilter(mockSignal, mockDexPair, false, null);

      expect(result).toBeDefined();
      expect(typeof result).toBe('object');
      expect(typeof result.allowed).toBe('boolean');
      expect(typeof result.reason).toBe('string');
      expect(typeof result.edgeScore).toBe('number');
      expect(result.edgeScore).toBeGreaterThanOrEqual(0);
      expect(result.edgeScore).toBeLessThanOrEqual(100);
    }, 15000);

    it('hard-blocks a low-liquidity candidate (allowed=false, reason describes the block)', async () => {
      const { executeEnhancedEdgeFilter } = await import('./routes');

      const mockSignal = {
        mint: 'LOW_LIQ_MINT',
        symbol: 'LOW',
        name: 'Low Liquidity',
        score: 10,
        gmgn: { creation_timestamp: Date.now() / 1000 - 60, bonding_currency: 'sol' },
      };

      // liq=50 < 15000 floor -> hard-block on LIQUIDITY_TOO_LOW
      const mockDexPair = {
        baseToken: { address: 'LOW_LIQ_MINT', symbol: 'LOW' },
        liquidity: { usd: 50 },
        volume: { m5: 10, h24: 100 },
        priceChange: { m5: 1 },
        marketCap: 1000,
        priceUsd: 0.00001,
      };

      const result = await executeEnhancedEdgeFilter(mockSignal, mockDexPair, false, null);
      expect(result).toBeDefined();
      expect(result.allowed).toBe(false);
      expect(typeof result.reason).toBe('string');
      expect(result.reason.length).toBeGreaterThan(0);
    }, 15000);
  });
});
