/**
 * observability-e2e.test.ts — END-TO-END wiring test for the observability and
 * provider-resilience layers (ARCHITECTURE.mdx: Observability Layer + Resilience
 * Layer) against the two main files: server/routes.ts + server/jupiter.ts.
 *
 * Verifies that decision audit events flow through the REAL pipeline:
 *   executeEnhancedEdgeFilter() → observability.logDecision() → GET /api/observability/events
 * and that provider circuit-breaker health is exposed:
 *   GET /api/providers/health → providerRegistry.getAllHealth() + degradedMode
 *
 * Mock strategy mirrors full-pipeline.monster.test.ts (proven-green scaffold):
 * storage/jupiter/advanced_filters/runtime-hooks/gold_standard_hunter/newMintGate
 * are mocked; observability + provider-circuit-breaker are REAL (they are the
 * system under test).
 */
import { vi, describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import express from 'express';
import { createServer } from 'http';

// ──────────────────────────────────────────────────────────────────────────────
// MOCK SETUP — BEFORE ANY IMPORT OF routes.ts
// ──────────────────────────────────────────────────────────────────────────────

process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/test';
process.env.ADMIN_SECRET = 'test-admin-secret';
process.env.WALLET_PRIVATE_KEY = '';
process.env.QUALITY_REQUIRE_JUPITER_VERIFIED = 'false';
process.env.NODE_ENV = 'test';

vi.mock('./logger', () => ({
  log: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
  },
}));

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
  getOpenTrades: vi.fn().mockResolvedValue([]),
  getCandidates: vi.fn().mockResolvedValue([]),
  addTrade: vi.fn().mockResolvedValue({}),
  closeTrade: vi.fn().mockResolvedValue(undefined),
  updateTradeCurrentPrice: vi.fn().mockResolvedValue(undefined),
  updateTradePeakPrice: vi.fn().mockResolvedValue(undefined),
  updateTradeAmount: vi.fn().mockResolvedValue(undefined),
  updateTradingMode: vi.fn().mockResolvedValue({}),
  updateBotRunning: vi.fn().mockResolvedValue({}),
  updateStrategyMode: vi.fn().mockResolvedValue({}),
  updateBotStats: vi.fn().mockResolvedValue(undefined),
  seedInitialData: vi.fn().mockResolvedValue(undefined),
  getShadowTrades: vi.fn().mockResolvedValue({ open: [], closed: [] }),
  addShadowTrade: vi.fn().mockResolvedValue(undefined),
  updateShadowTrade: vi.fn().mockResolvedValue(undefined),
  closeShadowTrade: vi.fn().mockResolvedValue(undefined),
};

vi.mock('./storage', () => ({
  storage: mockStorage,
  initStorageWrapper: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('./jupiter', () => ({
  JupiterService: vi.fn(),
  RpcRotator: vi.fn(),
  createJupiterService: vi.fn().mockReturnValue(null),
  SOL_MINT: 'So11111111111111111111111111111111111111112',
  MIN_FEE_BUFFER_SOL: 0.004,
  getLatencyLog: vi.fn().mockReturnValue([]),
  clearLatencyLog: vi.fn(),
}));

vi.mock('./advanced_filters', () => ({
  checkAdvancedFilters: vi.fn().mockResolvedValue({
    passed: true,
    score: 85,
    details: { liquidity: 50000, volume24h: 100000, holders: 500 },
  }),
}));

vi.mock('./runtime-hooks', () => ({
  startHeartbeat: vi.fn(),
  isHalted: vi.fn().mockReturnValue(false),
  healthState: vi.fn().mockReturnValue({ status: 'healthy', lastCheck: Date.now() }),
}));

vi.mock('./gold_standard_hunter', () => ({
  runHunter: vi.fn().mockResolvedValue(undefined),
  checkMint: vi.fn().mockResolvedValue({ passed: true, score: 90 }),
  pollSignalFeed: vi.fn().mockResolvedValue([]),
  pollTrending: vi.fn().mockResolvedValue([]),
  pollTrenches: vi.fn().mockResolvedValue([]),
  pollSmartMoneyFeed: vi.fn().mockResolvedValue([]),
  pollDexScreenerFeeds: vi.fn().mockResolvedValue([]),
}));

vi.mock('./lib/newMintGate', () => ({
  evaluateNewMintGate: vi.fn().mockReturnValue({ passed: true, score: 80, reason: 'ok' }),
  GateInput: {},
}));

const fetchMock = vi.fn().mockImplementation((url: string | URL) => {
  const u = String(url);
  if (u.includes('api.dexscreener.com')) {
    return Promise.resolve({
      ok: true,
      json: () => Promise.resolve({ pairs: [] }),
    } as Response);
  }
  if (u.includes('api.rugcheck.xyz')) {
    return Promise.resolve({
      ok: true,
      json: () => Promise.resolve({ score: 0.1, risks: [], token: { mint: 'MOCK', supply: 1000000 } }),
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

// ──────────────────────────────────────────────────────────────────────────────
// TEST SUITE
// ──────────────────────────────────────────────────────────────────────────────

let app: express.Express;
let httpServer: ReturnType<typeof createServer>;
let testRequest: request.SuperAgentTest;
let logSpy: ReturnType<typeof vi.spyOn>;

describe('MONSTER MOONSHOT: observability + resilience layers wired end-to-end', () => {
  beforeAll(async () => {
    // Silence the per-event JSON audit lines emitted by observability.logDecision
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    app = express();
    app.use(express.json());
    httpServer = createServer(app);

    const { registerRoutes } = await import('./routes');
    await registerRoutes(httpServer, app);

    await new Promise(resolve => setTimeout(resolve, 200));
    testRequest = request.agent(httpServer);
  }, 60_000);

  afterAll(async () => {
    logSpy.mockRestore();
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  });

  describe('decision audit trail (executeEnhancedEdgeFilter → observability)', () => {
    it('emits a DISCOVERY_ADMIT event when a strong candidate passes the edge filter', async () => {
      const { executeEnhancedEdgeFilter } = await import('./routes');

      const mockSignal = {
        mint: 'OBS_ADMIT_MINT',
        symbol: 'OBSA',
        name: 'Observability Admit',
        score: 70,
        gmgn: { creation_timestamp: Date.now() / 1000 - 120, bonding_currency: 'sol' },
      };
      const mockDexPair = {
        baseToken: { address: 'OBS_ADMIT_MINT', symbol: 'OBSA' },
        liquidity: { usd: 200000 },
        volume: { m5: 800000, h24: 5000000 },
        priceChange: { m5: 40 },
        marketCap: 1_000_000,
        priceUsd: 0.0001,
      };

      const result = await executeEnhancedEdgeFilter(mockSignal, mockDexPair, false, null);
      expect(result.allowed).toBe(true);

      const res = await testRequest.get('/api/observability/events').query({ token: 'OBS_ADMIT_MINT' });
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.events)).toBe(true);
      const admit = res.body.events.find((e: any) => e.kind === 'DISCOVERY_ADMIT');
      expect(admit).toBeDefined();
      expect(admit.tokenAddress).toBe('OBS_ADMIT_MINT');
      expect(admit.source).toBe('executeEnhancedEdgeFilter');
      expect(admit.payload.edgeScore).toBeGreaterThan(0);
    }, 30_000);

    it('emits a DISCOVERY_VETO event when a candidate is hard-blocked', async () => {
      const { executeEnhancedEdgeFilter } = await import('./routes');

      const mockSignal = {
        mint: 'OBS_VETO_MINT',
        symbol: 'OBSV',
        name: 'Observability Veto',
        score: 10,
        gmgn: { creation_timestamp: Date.now() / 1000 - 60, bonding_currency: 'sol' },
      };
      const mockDexPair = {
        baseToken: { address: 'OBS_VETO_MINT', symbol: 'OBSV' },
        liquidity: { usd: 50 },
        volume: { m5: 10, h24: 100 },
        priceChange: { m5: 1 },
        marketCap: 1000,
        priceUsd: 0.00001,
      };

      const result = await executeEnhancedEdgeFilter(mockSignal, mockDexPair, false, null);
      expect(result.allowed).toBe(false);

      const res = await testRequest.get('/api/observability/events').query({ token: 'OBS_VETO_MINT' });
      expect(res.status).toBe(200);
      const veto = res.body.events.find((e: any) => e.kind === 'DISCOVERY_VETO');
      expect(veto).toBeDefined();
      expect(veto.tokenAddress).toBe('OBS_VETO_MINT');
      expect(veto.reason).toContain('LIQUIDITY_TOO_LOW');
    }, 30_000);
  });

  describe('GET /api/observability/events', () => {
    it('returns 200 with events array and correlationId', async () => {
      const res = await testRequest.get('/api/observability/events');
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.events)).toBe(true);
      expect(typeof res.body.correlationId).toBe('string');
    });

    it('supports kind filter', async () => {
      const res = await testRequest.get('/api/observability/events').query({ kind: 'DISCOVERY_VETO' });
      expect(res.status).toBe(200);
      expect(res.body.events.every((e: any) => e.kind === 'DISCOVERY_VETO')).toBe(true);
    });

    it('honors the limit parameter', async () => {
      const res = await testRequest.get('/api/observability/events').query({ limit: 1 });
      expect(res.status).toBe(200);
      expect(res.body.events.length).toBeLessThanOrEqual(1);
    });
  });

  describe('GET /api/providers/health', () => {
    it('returns 200 with degradedMode and one health entry per provider', async () => {
      const res = await testRequest.get('/api/providers/health');
      expect(res.status).toBe(200);
      expect(['FULL', 'DEX_ONLY', 'ML_ONLY', 'OFFLINE']).toContain(res.body.degradedMode);
      expect(Array.isArray(res.body.providers)).toBe(true);
      const names = res.body.providers.map((p: any) => p.name).sort();
      expect(names).toEqual(['dexscreener', 'gmgn', 'helius', 'ml_server', 'rugcheck']);
      for (const p of res.body.providers) {
        expect(['CLOSED', 'OPEN', 'HALF_OPEN']).toContain(p.state);
        expect(typeof p.totalRequests).toBe('number');
        expect(typeof p.totalFailures).toBe('number');
      }
    });
  });
});
