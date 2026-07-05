import { vi, beforeEach, afterEach } from 'vitest';

vi.setConfig({ testTimeout: 30000 });

Object.defineProperty(global, 'fetch', {
  value: vi.fn(),
  writable: true,
});

Object.defineProperty(global, 'AbortSignal', {
  value: {
    timeout: (ms: number) => ({ aborted: false, addEventListener: () => {}, removeEventListener: () => {} }),
  },
  writable: true,
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ now: new Date('2024-01-15T12:00:00Z') });
});

afterEach(() => {
  vi.useRealTimers();
});

export const mockDexScreenerPair = (overrides: Partial<any> = {}) => ({
  chainId: 'solana',
  dexId: 'raydium',
  pairAddress: 'test-pair-address',
  baseToken: { address: 'test-token-mint', name: 'Test', symbol: 'TEST' },
  quoteToken: { address: 'So11111111111111111111111111111111111111112', name: 'Solana', symbol: 'SOL' },
  priceUsd: '0.000123',
  priceNative: '0.00000068',
  txns: { m5: { buys: 100, sells: 20 }, h1: { buys: 500, sells: 100 }, h24: { buys: 5000, sells: 2000 } },
  volume: { m5: 5000, h1: 25000, h6: 100000, h24: 500000 },
  priceChange: { m5: 5.5, h1: 12.3, h6: 25.0, h24: 45.0 },
  liquidity: { usd: 50000 },
  fdv: 500000,
  marketCap: 400000,
  pairCreatedAt: Date.now() - 300000,
  ...overrides,
});

export const mockTrade = (overrides: Partial<any> = {}) => ({
  id: 1,
  tokenAddress: 'test-token-mint',
  tokenSymbol: 'TEST',
  type: 'BUY',
  mode: 'SNIPER',
  tradingMode: 'paper',
  status: 'OPEN',
  amount: '0.01',
  price: '0.000123',
  currentPrice: '0.000123',
  peakPrice: '0.000123',
  pnl: '0',
  peakPnl: '0',
  score: '85',
  txHash: 'paper_test_hash',
  liquidity: '50000',
  dex: 'raydium',
  timestamp: new Date().toISOString(),
  ...overrides,
});

export const mockJupiterQuote = (overrides: Partial<any> = {}) => ({
  inputMint: 'So11111111111111111111111111111111111111112',
  outputMint: 'test-token-mint',
  outAmount: '100000000',
  priceImpactPct: '2.5',
  routePlan: [{ swapInfo: { label: 'Raydium' } }],
  _fetchedAt: Date.now(),
  _quoteDurationMs: 150,
  ...overrides,
});

export const mockJupiterSwapResponse = (overrides: Partial<any> = {}) => ({
  swapTransaction: Buffer.from('mock-transaction').toString('base64'),
  lastValidBlockHeight: 123456789,
  ...overrides,
});

export const mockMLPrediction = (overrides: Partial<any> = {}) => ({
  pumpProb: 0.75,
  dumpRisk: 0.2,
  version: 'test-1.0',
  ...overrides,
});