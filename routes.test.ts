import { vi, describe, it, expect, beforeEach, beforeAll } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createServer } from 'http';

// Mock DATABASE_URL before any imports
process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/test';

// Mock storage module before importing routes
const { mockStorage } = vi.hoisted(() => ({
  mockStorage: {
    getBotStatus: vi.fn().mockResolvedValue({ 
      mode: "AUTO", 
      tradingMode: "paper", 
      isRunning: true, 
      walletBalance: "10.00",
      totalPnl: "0",
      winRate: "0",
      totalTrades: 0,
      openPositions: 0,
      lastSignal: null
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
  }
}));

vi.mock('./server/storage', () => ({
  storage: mockStorage,
  DatabaseStorage: vi.fn().mockImplementation(() => mockStorage),
  initStorageWrapper: vi.fn().mockResolvedValue(mockStorage)
}));

vi.mock('./server/jupiter', () => ({
  createJupiterService: vi.fn().mockReturnValue(null),
  JupiterService: vi.fn(),
  SOL_MINT: 'So11111111111111111111111111111111111111112',
  MIN_FEE_BUFFER_SOL: 0.004,
  getLatencyLog: vi.fn().mockReturnValue([]),
  clearLatencyLog: vi.fn()
}));

// Stub environment configuration before compilation reads initialization paths
process.env.ADMIN_SECRET = 'LIVE_TEST_SECRET_KEY';

// Mock external dependency points to isolate route responses
global.fetch = vi.fn();

let app: express.Express;

beforeAll(async () => {
  app = express();
  app.use(express.json());
  
  const httpServer = createServer(app);
  const { registerRoutes } = await import('./server/routes');
  await registerRoutes(httpServer, app);
});

describe('API Gateway Public Endpoints and Guardrails', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should return bot status on /api/bot/status', async () => {
    const response = await request(app).get('/api/bot/status');
    
    expect(response.status).toBe(200);
    expect(response.body).toHaveProperty('mode');
    expect(response.body).toHaveProperty('tradingMode');
    expect(response.body).toHaveProperty('isRunning');
  });

  it('should return trades list on /api/bot/trades', async () => {
    const response = await request(app).get('/api/bot/trades');
    
    expect(response.status).toBe(200);
    expect(response.body).toBeInstanceOf(Array);
  });

  it('should return engine stats on /api/engine/stats', async () => {
    const response = await request(app).get('/api/engine/stats');
    
    expect(response.status).toBe(200);
    expect(response.body).toHaveProperty('totalTrades');
    expect(response.body).toHaveProperty('winRate');
    expect(response.body).toHaveProperty('uptimeSeconds');
  });

  it('should return risk status on /api/engine/risk-status', async () => {
    const response = await request(app).get('/api/engine/risk-status');
    
    expect(response.status).toBe(200);
    expect(response.body).toHaveProperty('canTrade');
    expect(response.body).toHaveProperty('reason');
  });

  it('should return settings on /api/settings', async () => {
    const response = await request(app).get('/api/settings');
    
    expect(response.status).toBe(200);
    expect(response.body).toHaveProperty('trailingStopActivation');
  });
});