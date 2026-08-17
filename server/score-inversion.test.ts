/**
 * score-inversion.test.ts — regression tests for the 2026-08-16 score-inversion fix.
 *
 * Diagnosis (shadow-trades.jsonl, n=208, 2026-06-26..07-04):
 *   - score 50 band: +4.06%/trade   (n=5)
 *   - score 70 band: -0.83%/trade   (n=85)
 *   - score 80 band: -8.14%/trade   (n=60)   <- WORST
 *   - score 90 band: -7.38%/trade   (n=31)
 *   The score was INVERSELY correlated with outcome: the engine bought local tops.
 *
 * Root causes proven here:
 *   1. smartMoneyScore (+30 max) and whaleScore (+25 max) were ADDITIVE and uncapped:
 *      a mediocre raw-59 token with hot tape hit 59+30+25 = 100 and cleared every
 *      gate (live example: $BILLI raw=59 -> sm=30 wh=12 -> 92 -> entered -> -12%).
 *      Tape hype was acting as a standalone admission signal, not confirmation.
 *   2. The blow-off guard left px5m in (15%, 40%] completely unpunished, so tokens
 *      that had ALREADY pumped 30% in 5 minutes earned the same px points as a
 *      fresh +10% breakout — the classic chase-the-top entry.
 *
 * Fixes under test:
 *   1. Combined sm+whale additive bonus capped at +15 (env SM_WHALE_BONUS_CAP).
 *      Negative whale-distribution penalties still pass through uncapped.
 *   2. Monotonic chase penalty: px5m >25% -> -6, >40% -> -12, >80% -> -18, >120% -> -24.
 *      The healthy +10..15% breakout bonus (+4) is preserved.
 */

import { vi, describe, it, expect, beforeAll } from 'vitest';

// ── Environment BEFORE any routes import ─────────────────────────────────────
process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/test';
process.env.ADMIN_SECRET = 'test-admin-secret';
process.env.WALLET_PRIVATE_KEY = '';
process.env.NODE_ENV = 'test';
process.env.QUALITY_REQUIRE_JUPITER_VERIFIED = 'false';
process.env.SCORE_BREAKDOWN_LOG = 'false';
// A Birdeye key makes smartMoneyEnabled() true so whaleScore() actually runs.
process.env.BIRDEYE_API_KEY_1 = 'test-birdeye-key';

vi.mock('./logger', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn() },
}));

const mockStorage = {
  getBotStatus: vi.fn().mockResolvedValue({
    isRunning: false, paperMode: true, startingBalance: 10, currentBalance: 10,
    totalTrades: 0, winningTrades: 0, totalPnl: 0, maxDrawdown: 0, winRate: 0, avgHoldTime: 0,
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
  checkAdvancedFilters: vi.fn().mockResolvedValue({ passed: true, score: 85, details: {} }),
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

vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({}) } as Response));

// ── Fixtures ─────────────────────────────────────────────────────────────────

function makePair(overrides: Record<string, any> = {}): any {
  const now = Date.now();
  return {
    chainId: 'solana',
    dexId: 'pumpswap',
    pairAddress: 'TESTPAIR1111111111111111111111111111111111',
    baseToken: { address: 'TESTMINT111111111111111111111111111111111', name: 'Test', symbol: 'TEST' },
    quoteToken: { address: 'So11111111111111111111111111111111111111112', name: 'SOL', symbol: 'SOL' },
    priceUsd: '0.0001',
    txns: { m5: { buys: 6, sells: 5 }, h1: { buys: 40, sells: 30 } },
    volume: { m5: 1100, h1: 4600, h24: 20000 },
    priceChange: { m5: 10, h1: 20 },
    liquidity: { usd: 29415 },
    fdv: 980000,
    marketCap: 1_000_000, // inside the 300k..5M organic band -> no mc penalty
    pairCreatedAt: now - 4782 * 1000,
    ...overrides,
  };
}

// Hot tape: 5 net smart-money buyers, whales net +5 -> OLD code added +30 and +25.
const hotTape = {
  count: 5, netBuyers: 5, topRealizedPnl: 5000, whaleCount: 10,
  whaleNetBuyers: 6, whaleNetSellers: 1, washSuspects: 0, source: 'helius' as const,
};

// Distribution tape: whales net-selling, zero buyers -> whaleScore penalty -20.
const distTape = {
  count: 4, netBuyers: 0, topRealizedPnl: 0, whaleCount: 10,
  whaleNetBuyers: 0, whaleNetSellers: 4, washSuspects: 0, source: 'helius' as const,
};

let scoreToken: (pair: any, ml?: any, micro?: boolean, sm?: any) => any;

beforeAll(async () => {
  const routes = await import('./routes');
  scoreToken = (routes as any).scoreToken;
}, 30_000);

describe('score-inversion fix (shadow data 2026-06-26..07-04: score>=80 was the WORST band)', () => {
  it('exports scoreToken for direct unit testing', () => {
    expect(typeof scoreToken).toBe('function');
  });

  it('caps the combined smart-money + whale additive bonus at +15', () => {
    const pair = makePair();
    const base = scoreToken(pair, null, false, null).combinedScore;
    const boosted = scoreToken(pair, null, false, hotTape).combinedScore;
    // Tape is confirmation, not admission: never more than +15 over the raw-driven score.
    expect(boosted).toBeLessThanOrEqual(base + 15);
    // ...but genuine accumulation still adds something.
    expect(boosted).toBeGreaterThan(base);
  });

  it('penalizes chasing an already-extended move (px5m > 25%)', () => {
    const s10 = scoreToken(makePair({ priceChange: { m5: 10, h1: 20 } }), null, false, null).combinedScore;
    const s30 = scoreToken(makePair({ priceChange: { m5: 30, h1: 40 } }), null, false, null).combinedScore;
    const s50 = scoreToken(makePair({ priceChange: { m5: 50, h1: 60 } }), null, false, null).combinedScore;
    // A +30% 5m move is a local top, not an entry: must score BELOW a fresh +10% breakout.
    expect(s30).toBeLessThan(s10);
    // Monotonic: the more extended, the harsher the penalty.
    expect(s50).toBeLessThan(s30);
  });

  it('preserves the healthy +10..15% breakout bonus', () => {
    const s12 = scoreToken(makePair({ priceChange: { m5: 12, h1: 20 } }), null, false, null).combinedScore;
    const s5 = scoreToken(makePair({ priceChange: { m5: 5, h1: 20 } }), null, false, null).combinedScore;
    expect(s12).toBeGreaterThan(s5);
  });

  it('keeps the whale distribution penalty intact (negative tape still punishes)', () => {
    const pair = makePair();
    const base = scoreToken(pair, null, false, null).combinedScore;
    const punished = scoreToken(pair, null, false, distTape).combinedScore;
    expect(punished).toBeLessThan(base);
  });

  it('BILLI replay: raw-59 hype-tape token no longer reaches the 80+ edge pocket', () => {
    // Live 2026-08-16: $BILLI raw=59, sm=30, wh=12 -> old score 92 -> entered -> -12.09%.
    // With the cap (+15) and mc penalty it must stay below the EDGE-POCKET high bar (80).
    const billi = makePair({
      liquidity: { usd: 29415 },
      marketCap: 150_000, // outside organic band -> -8 mc penalty, as in the live run
      priceChange: { m5: 24.7, h1: 40 },
      pairCreatedAt: Date.now() - 4782 * 1000,
    });
    const res = scoreToken(billi, null, false, hotTape);
    expect(res.combinedScore).toBeLessThan(80);
  });
});
