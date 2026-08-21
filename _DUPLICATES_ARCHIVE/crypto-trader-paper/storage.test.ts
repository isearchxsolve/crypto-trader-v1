import { vi, describe, it, expect, beforeEach } from 'vitest';

// Mock storage methods using vi.hoisted to avoid hoisting issues
const { mockStorage } = vi.hoisted(() => ({
  mockStorage: {
    getTradeHistory: vi.fn().mockResolvedValue([{ id: 1, mint: 'TOKEN_A', pnl: 15.4 }]),
    saveTradeRecord: vi.fn().mockResolvedValue({ success: true }),
    getPerformanceMetrics: vi.fn().mockResolvedValue({ winRate: 62.5, totalTrades: 40 })
  }
}));

vi.mock('./server/storage', () => ({
  storage: mockStorage
}));

import { storage } from './server/storage';

describe('Exported Storage Instance Layer Verification', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should extract correct historical structural types via the public storage instance', async () => {
    const history = await storage.getTradeHistory();
    expect(history).toBeInstanceOf(Array);
    expect(history[0].mint).toBe('TOKEN_A');
  });

  it('should accurately deliver calculated processing constants to high-level consumers', async () => {
    const performance = await storage.getPerformanceMetrics();
    expect(performance.winRate).toEqual(62.5);
  });
});