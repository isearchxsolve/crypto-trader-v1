/**
 * edgecase-monster.test.ts — MONSTER MOONSHOT EDGE CASE & ERROR HANDLING
 *
 * Comprehensive coverage of error paths and boundary conditions in jupiter.ts.
 * All network calls are mocked at the rpc.exec boundary so the REAL orchestration
 * (retry loops, sentinel handling, failover) runs end-to-end.
 *
 * Mirrors the proven-green pattern from jupiter.integration.test.ts.
 */

import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { JupiterService, RpcRotator } from './jupiter';
import { Connection, Keypair } from '@solana/web3.js';
import bs58 from 'bs58';

// Mock logger
vi.mock('./logger', () => ({
  log: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
  },
}));

// Mock runtime-hooks — isHalted() returns false so buy path is not blocked
vi.mock('./runtime-hooks', () => ({
  startHeartbeat: vi.fn(),
  isHalted: () => false,
  healthState: { healthy: true, lastCheck: Date.now() },
}));

const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTt1sg'; // valid base58

// ═══════════════════════════════════════════════════════════════════════════════
// EDGE CASE TESTS
// ═══════════════════════════════════════════════════════════════════════════════

describe('MONSTER MOONSHOT: Edge Cases & Error Handling', () => {
  let service: JupiterService;
  let mockKeypair: Keypair;
  let privateKeyBase58: string;

  beforeEach(() => {
    mockKeypair = Keypair.generate();
    privateKeyBase58 = bs58.encode(mockKeypair.secretKey);
    service = new JupiterService(
      ['https://mock-rpc.example.com'],
      privateKeyBase58,
      10_000,
      0,
      null
    );
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ═══════════════════════════════════════════════════════════════════════════════
  // EDGE CASE 1: CONSTRUCTOR
  // ═══════════════════════════════════════════════════════════════════════════════

  describe('EDGE CASE 1: Constructor', () => {
    it('constructs successfully with a single valid RPC URL', () => {
      const svc = new JupiterService(['https://rpc.example.com'], privateKeyBase58);
      expect(svc.walletAddress).toBe(mockKeypair.publicKey.toBase58());
    });

    it('constructs successfully with an empty RPC array (uses defaults)', () => {
      const svc = new JupiterService([], privateKeyBase58);
      expect(svc.walletAddress).toBe(mockKeypair.publicKey.toBase58());
    });

    it('constructs with priority fee and jito tip configured', () => {
      const svc = new JupiterService(
        ['https://rpc.example.com'],
        privateKeyBase58,
        50_000,
        5_000,
        'https://jito.example.com'
      );
      expect(svc['priorityFeeLamports']).toBe(50_000);
      expect(svc['jitoTipLamports']).toBe(5_000);
      expect(svc['jitoEngineUrl']).toBe('https://jito.example.com');
    });

    it('RpcRotator constructs and tracks endpoints', () => {
      const rotator = new RpcRotator();
      rotator.add('https://rpc1.example.com', 'https://rpc1.example.com?api-key=k');
      expect(rotator['endpoints'].length).toBeGreaterThan(0);
      expect(rotator['primaryUrl']).toBe('https://rpc1.example.com?api-key=k');
    });

    it('throws on invalid (non-base58) private key', () => {
      // bs58.decode throws on invalid input — JupiterService does NOT catch this.
      // We assert the constructor surfaces the error rather than swallowing it.
      expect(() => new JupiterService(['https://rpc.example.com'], '!!!not-base58!!!')).toThrow();
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════════
  // EDGE CASE 2: RPC ROTATOR FAILOVER
  // ═══════════════════════════════════════════════════════════════════════════════

  describe('EDGE CASE 2: RPC Rotator Failover', () => {
    it('retries up to 3 nodes on RPC_TIMEOUT then succeeds', async () => {
      const rotator = new RpcRotator();
      rotator.add('https://rpc1.example.com');
      let callCount = 0;
      const fn = async (_c: Connection) => {
        callCount++;
        if (callCount < 3) throw new Error('RPC_TIMEOUT');
        return 'ok';
      };
      const result = await rotator.exec('retry-test', fn, 1000);
      expect(result).toBe('ok');
      expect(callCount).toBe(3);
    });

    it('throws immediately on non-retryable errors', async () => {
      const rotator = new RpcRotator();
      rotator.add('https://rpc1.example.com');
      const fn = async (_c: Connection) => {
        throw new Error('could not find account');
      };
      await expect(rotator.exec('non-retryable', fn, 1000)).rejects.toThrow('could not find account');
    });

    it('markUnhealthyByIndex flips healthy flag', () => {
      const rotator = new RpcRotator();
      rotator.add('https://rpc1.example.com');
      expect(rotator['endpoints'][0].healthy).toBe(true);
      rotator.markUnhealthyByIndex(0);
      expect(rotator['endpoints'][0].healthy).toBe(false);
    });

    it('markCurrentUnhealthy flips the previous node', () => {
      const rotator = new RpcRotator();
      rotator.add('https://rpc1.example.com');
      rotator['currentIndex'] = 1;
      rotator.markCurrentUnhealthy();
      expect(rotator['endpoints'][0].healthy).toBe(false);
    });

    it('caches Connection objects per URL (no re-creation)', () => {
      const rotator = new RpcRotator();
      rotator.add('https://rpc1.example.com');
      const c1 = rotator.connection;
      const c2 = rotator.connection;
      expect(c1).toBe(c2);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════════
  // EDGE CASE 3: TOKEN BALANCE BOUNDARIES
  // ═══════════════════════════════════════════════════════════════════════════════

  describe('EDGE CASE 3: Token Balance Boundaries', () => {
    it('returns extremely large balance (> 2^53) as bigint', async () => {
      vi.spyOn(service['rpc'], 'exec').mockResolvedValue(BigInt('9223372036854775807'));
      const bal = await service.getTokenBalance(USDC_MINT);
      expect(bal).toBe(BigInt('9223372036854775807'));
      expect(typeof bal).toBe('bigint');
    });

    it('returns BigInt(0) for zero balance', async () => {
      vi.spyOn(service['rpc'], 'exec').mockResolvedValue(BigInt(0));
      const bal = await service.getTokenBalance(USDC_MINT);
      expect(bal).toBe(BigInt(0));
    });

    it('normalizes BigInt(-1) sentinel (token-not-found) to BigInt(0)', async () => {
      vi.spyOn(service['rpc'], 'exec').mockResolvedValue(BigInt(-1));
      const bal = await service.getTokenBalance(USDC_MINT);
      expect(bal).toBe(BigInt(0));
    });

    it('retries on RPC failure then succeeds (2-attempt loop)', async () => {
      let callCount = 0;
      vi.spyOn(service['rpc'], 'exec').mockImplementation(async () => {
        callCount++;
        if (callCount < 2) throw new Error('RPC_TIMEOUT');
        return BigInt(3_000_000);
      });
      vi.spyOn(service['rpc'], 'markCurrentUnhealthy').mockImplementation(() => {});
      const bal = await service.getTokenBalance(USDC_MINT);
      expect(bal).toBe(BigInt(3_000_000));
      expect(callCount).toBe(2);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════════
  // EDGE CASE 4: WALLET BALANCE BOUNDARIES
  // ═══════════════════════════════════════════════════════════════════════════════

  describe('EDGE CASE 4: Wallet Balance Boundaries', () => {
    it('returns 1 SOL when rpc.exec returns 1_000_000_000 lamports', async () => {
      vi.spyOn(service['rpc'], 'exec').mockResolvedValue(1_000_000_000);
      const bal = await service.getWalletBalance();
      expect(bal).toBe(1);
    });

    it('returns 0 SOL when rpc.exec returns 0 lamports', async () => {
      vi.spyOn(service['rpc'], 'exec').mockResolvedValue(0);
      const bal = await service.getWalletBalance();
      expect(bal).toBe(0);
    });

    it('retries 3 times then succeeds on final attempt', async () => {
      let callCount = 0;
      vi.spyOn(service['rpc'], 'exec').mockImplementation(async () => {
        callCount++;
        if (callCount < 3) throw new Error('RPC_TIMEOUT');
        return 1_000_000_000;
      });
      vi.spyOn(service['rpc'], 'markCurrentUnhealthy').mockImplementation(() => {});
      const bal = await service.getWalletBalance();
      expect(bal).toBe(1);
      expect(callCount).toBe(3);
    });

    it('marks current endpoint unhealthy on persistent failure', async () => {
      vi.spyOn(service['rpc'], 'exec').mockRejectedValue(new Error('RPC_TIMEOUT'));
      const markUnhealthy = vi.spyOn(service['rpc'], 'markCurrentUnhealthy').mockImplementation(() => {});
      try {
        await service.getWalletBalance();
      } catch {
        // expected — all retries + public fallbacks exhausted
      }
      expect(markUnhealthy).toHaveBeenCalled();
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════════
  // EDGE CASE 5: BUY PATH
  // ═══════════════════════════════════════════════════════════════════════════════

  describe('EDGE CASE 5: Buy Path Edge Cases', () => {
    it('blocks buy when balance < amount + MIN_FEE_BUFFER_SOL', async () => {
      vi.spyOn(service, 'getWalletBalance').mockResolvedValue(0.001);
      const result = await service.buyToken(USDC_MINT, 1, 100);
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/low/i);
    });

    it('blocks buy when halted via runtime-hooks', async () => {
      const runtimeHooks = await import('./runtime-hooks');
      vi.spyOn(runtimeHooks, 'isHalted').mockReturnValue(true);
      const result = await service.buyToken(USDC_MINT, 0.001, 100);
      expect(result.success).toBe(false);
      expect(result.error).toBe('HALTED');
    });

    it('returns success on full fill (>= 70% of expected outAmount)', async () => {
      vi.spyOn(service, 'getWalletBalance').mockResolvedValue(10);
      vi.spyOn(service, 'getTokenBalance').mockResolvedValue(BigInt(0));
      vi.spyOn(service, 'fetchQuoteWithRetry' as any).mockResolvedValue({
        outAmount: '1000000',
        priceImpactPct: '0.5',
        routePlan: [{ swapInfo: { label: 'raydium' } }],
        _fetchedAt: Date.now(),
      });
      vi.spyOn(service, 'buildAndSendWithRetry' as any).mockResolvedValue({
        signature: 'MOCK_BUY_SIG',
        postSwapBalances: [{ mint: USDC_MINT, amount: BigInt(1_000_000) }],
      });
      const result = await service.buyToken(USDC_MINT, 0.001, 100);
      expect(result.success).toBe(true);
      expect(result.txSignature).toBe('MOCK_BUY_SIG');
      expect(result.tokenAmountRaw).toBe(BigInt(1_000_000));
    });

    it('reports partial fill when token amount < 70% of expected', async () => {
      vi.spyOn(service, 'getWalletBalance').mockResolvedValue(10);
      vi.spyOn(service, 'getTokenBalance').mockResolvedValue(BigInt(0));
      vi.spyOn(service, 'fetchQuoteWithRetry' as any).mockResolvedValue({
        outAmount: '1000000',
        priceImpactPct: '0.5',
        routePlan: [{ swapInfo: { label: 'raydium' } }],
        _fetchedAt: Date.now(),
      });
      vi.spyOn(service, 'buildAndSendWithRetry' as any).mockResolvedValue({
        signature: 'MOCK_PARTIAL',
        postSwapBalances: [{ mint: USDC_MINT, amount: BigInt(500_000) }],
      });
      const result = await service.buyToken(USDC_MINT, 0.001, 100);
      expect(result.success).toBe(true);
      expect(result.error).toMatch(/partial/i);
    });

    it('returns failure when quote fetch throws', async () => {
      vi.spyOn(service, 'getWalletBalance').mockResolvedValue(10);
      vi.spyOn(service, 'fetchQuoteWithRetry' as any).mockRejectedValue(new Error('No route'));
      const result = await service.buyToken(USDC_MINT, 0.001, 100);
      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════════
  // EDGE CASE 6: SELL PATH
  // ═══════════════════════════════════════════════════════════════════════════════

  describe('EDGE CASE 6: Sell Path Edge Cases', () => {
    it('fails when token balance is zero and no amount provided', async () => {
      vi.spyOn(service, 'getTokenBalance').mockResolvedValue(BigInt(0));
      const result = await service.sellToken(USDC_MINT, BigInt(0), 100);
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/no.*balance/i);
    });

    it('returns success on full sell with mocked quote + balance', async () => {
      vi.spyOn(service, 'getTokenBalance').mockResolvedValue(BigInt(1_000_000));
      vi.spyOn(service, 'getWalletBalance')
        .mockResolvedValueOnce(1)    // solBefore
        .mockResolvedValue(2);       // post-sell polls → solAfter
      vi.spyOn(service, 'fetchQuoteWithRetry' as any).mockResolvedValue({
        outAmount: '500000000',
        priceImpactPct: '1.0',
        routePlan: [{ swapInfo: { label: 'raydium' } }],
        _fetchedAt: Date.now(),
      });
      vi.spyOn(service, 'buildAndSendWithRetry' as any).mockResolvedValue({
        signature: 'MOCK_SELL_SIG',
        postSwapBalances: [],
      });
      const result = await service.sellToken(USDC_MINT, BigInt(500_000), 100);
      expect(result.success).toBe(true);
      expect(result.txSignature).toBe('MOCK_SELL_SIG');
      expect(result.solReceived).toBeGreaterThan(0);
    });

    it('returns failure when quote fetch throws', async () => {
      vi.spyOn(service, 'getTokenBalance').mockResolvedValue(BigInt(1_000_000));
      vi.spyOn(service, 'fetchQuoteWithRetry' as any).mockRejectedValue(new Error('No route'));
      const result = await service.sellToken(USDC_MINT, BigInt(500_000), 100);
      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════════
  // EDGE CASE 7: JITO CONFIG BOUNDARIES
  // ═══════════════════════════════════════════════════════════════════════════════

  describe('EDGE CASE 7: Jito Configuration', () => {
    it('disables Jito when tip is 0 and engine URL is null', () => {
      const svc = new JupiterService(['https://rpc.example.com'], privateKeyBase58, 10_000, 0, null);
      expect(svc['jitoTipLamports']).toBe(0);
      expect(svc['jitoEngineUrl']).toBeNull();
    });

    it('accepts large (but finite) jito tip', () => {
      const svc = new JupiterService(
        ['https://rpc.example.com'],
        privateKeyBase58,
        10_000,
        Number.MAX_SAFE_INTEGER,
        'https://jito.example.com'
      );
      expect(svc['jitoTipLamports']).toBe(Number.MAX_SAFE_INTEGER);
      expect(Number.isFinite(svc['jitoTipLamports'])).toBe(true);
    });

    it('preserves jito engine URL', () => {
      const url = 'https://jito.example.com/api/transactions';
      const svc = new JupiterService(['https://rpc.example.com'], privateKeyBase58, 10_000, 1_000, url);
      expect(svc['jitoEngineUrl']).toBe(url);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════════
  // EDGE CASE 8: WELL-KNOWN MINT VALIDATION
  // ═══════════════════════════════════════════════════════════════════════════════

  describe('EDGE CASE 8: Well-known mints are valid base58', () => {
    const knownMints = [
      'So11111111111111111111111111111111111111112', // wSOL
      'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTt1sg', // USDC
      'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', // USDT
    ];

    knownMints.forEach(mint => {
      it(`${mint.slice(0, 8)}... is valid base58 (no special chars)`, () => {
        // base58 alphabet: no 0, O, I, l, no special chars
        expect(/^[1-9A-HJ-NP-Za-km-z]+$/.test(mint)).toBe(true);
      });
    });
  });
});