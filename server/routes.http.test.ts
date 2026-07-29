/**
 * routes.http.test.ts — HTTP INTEGRATION TEST FOR routes.ts EXPORTS
 *
 * Boots the real registerRoutes() once against mocked DB/RPC/fetch.
 * Uses REAL timers (no fake timers) because the trading engine uses
 * recursive setTimeout scheduling that fake timers can't fully flush.
 */

import { vi, describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createServer } from 'http';

// ──────────────────────────────────────────────────────────────────────────────
// GLOBAL MOCKS — MUST BE DEFINED BEFORE ANY IMPORT OF routes.ts
// ──────────────────────────────────────────────────────────────────────────────

// 1. Env before imports
process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/test';
process.env.ADMIN_SECRET = 'test-admin-secret';
process.env.WALLET_PRIVATE_KEY = '';
process.env.QUALITY_REQUIRE_JUPITER_VERIFIED = 'false';
process.env.NODE_ENV = 'test';

// 2. storage mock
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

// 3. jupiter mock — createJupiterService returns null, JupiterService is no-op
vi.mock('./jupiter', () => ({
  JupiterService: vi.fn(),
  createJupiterService: vi.fn().mockReturnValue(null),
  SOL_MINT: 'So11111111111111111111111111111111111111112',
  MIN_FEE_BUFFER_SOL: 0.004,
  getLatencyLog: vi.fn().mockReturnValue([]),
  clearLatencyLog: vi.fn(),
}));

// 4. advanced_filters mock
vi.mock('./advanced_filters', () => ({
  checkAdvancedFilters: vi.fn().mockResolvedValue({
    passed: true,
    score: 85,
    details: { liquidity: 50000, volume24h: 100000, holders: 500 },
  }),
}));

// 5. runtime-hooks mock
vi.mock('./runtime-hooks', () => ({
  startHeartbeat: vi.fn(),
  isHalted: vi.fn().mockReturnValue(false),
  healthState: { healthy: true, lastCheck: Date.now() },
}));

// 6. gold_standard_hunter mock
vi.mock('./gold_standard_hunter', () => ({
  runHunter: vi.fn().mockResolvedValue(undefined),
  checkMint: vi.fn().mockResolvedValue({ passed: true, score: 90 }),
  pollSignalFeed: vi.fn().mockResolvedValue([]),
  pollTrending: vi.fn().mockResolvedValue([]),
  pollTrenches: vi.fn().mockResolvedValue([]),
  pollSmartMoneyFeed: vi.fn().mockResolvedValue([]),
  pollDexScreenerFeeds: vi.fn().mockResolvedValue([]),
}));

// 7. newMintGate mock
vi.mock('./lib/newMintGate', () => ({
  evaluateNewMintGate: vi.fn().mockReturnValue({ passed: true, score: 80, reason: 'ok' }),
  GateInput: {},
}));

// 8. global.fetch stub — MUST intercept DexScreener SOL price fetch
const fetchMock = vi.fn().mockImplementation((url: string | URL) => {
  const u = String(url);
  // DexScreener SOL/USD price: https://api.dexscreener.com/latest/dex/tokens/So11111111111111111111111111111111111111112
  if (u.includes('api.dexscreener.com/latest/dex/tokens/So11111111111111111111111111111111111111112')) {
    return Promise.resolve({
      ok: true,
      json: () => Promise.resolve({
        pairs: [{
          baseToken: { address: 'So11111111111111111111111111111111111111112' },
          priceUsd: '100.00',
          liquidity: { usd: 5000000 },
          volume: { h24: 100000000 }
        }]
      }),
    } as Response);
  }
  // Generic DexScreener token search
  if (u.includes('api.dexscreener.com')) {
    return Promise.resolve({
      ok: true,
      json: () => Promise.resolve({ pairs: [] }),
    } as Response);
  }
  // RugCheck
  if (u.includes('api.rugcheck.xyz')) {
    return Promise.resolve({
      ok: true,
      json: () => Promise.resolve({ score: 0.1, risks: [], token: { mint: 'MOCK', supply: 1000000 } }),
    } as Response);
  }
  // Birdeye
  if (u.includes('public-api.birdeye.so')) {
    return Promise.resolve({
      ok: true,
      json: () => Promise.resolve({ data: { items: [] } }),
    } as Response);
  }
  // GMGN
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
// TEST SUITE — registerRoutes runs ONCE in beforeAll (no fake timers)
// ──────────────────────────────────────────────────────────────────────────────

let app: express.Express;
let httpServer: ReturnType<typeof createServer>;
let testRequest: request.SuperAgentTest;

describe('routes.ts — HTTP endpoints via registerRoutes()', () => {
  beforeAll(async () => {
    app = express();
    app.use(express.json());
    httpServer = createServer(app);

    // Import AFTER mocks are set up
    const { registerRoutes } = await import('./routes');
    await registerRoutes(httpServer, app);

    // Wait a moment for async engine startup to settle
    await new Promise(resolve => setTimeout(resolve, 100));

    testRequest = request.agent(httpServer);
  }, 60000);

  afterAll(async () => {
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  });

  it('GET /api/bot/status → 200 + expected JSON shape', async () => {
    const res = await testRequest.get('/api/bot/status');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('isRunning');
    expect(res.body).toHaveProperty('paperMode');
    expect(res.body).toHaveProperty('currentBalance');
  });

  it('GET /api/bot/trades → 200 + array', async () => {
    const res = await testRequest.get('/api/bot/trades');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  it('GET /api/engine/stats → 200 + stats shape', async () => {
    const res = await testRequest.get('/api/engine/stats');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('totalTrades');
    expect(res.body).toHaveProperty('winRate');
  });

  it('GET /api/engine/risk-status → 200 + risk shape', async () => {
    const res = await testRequest.get('/api/engine/risk-status');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('canTrade');
    expect(res.body).toHaveProperty('reason');
  });

  it('GET /api/settings → 200 + settings object', async () => {
    const res = await testRequest.get('/api/settings');
    expect(res.status).toBe(200);
    expect(typeof res.body).toBe('object');
  });
});