/**
 * jupiter.integration.test.ts — END-TO-END INTEGRATION TEST FOR jupiter.ts
 *
 * Exercises the REAL JupiterService class. Mocks at the method boundary
 * (getWalletBalance / getTokenBalance / fetchQuoteWithRetry / buildAndSendWithRetry)
 * so the real buyToken/sellToken orchestration logic runs while the networked
 * leaves (Jupiter HTTP API, on-chain RPC) are stubbed. Mirrors the proven-green
 * patterns from jupiter.test.ts — NO fake timers (the 30s setInterval in
 * RpcRotator is harmless; tests finish long before it fires).
 *
 * Field names match the REAL BuyResult / SellResult interfaces:
 *   BuyResult  { success, txSignature, actualSolSpent, tokenAmountRaw, priceImpactPct, feesSol, error? }
 *   SellResult { success, txSignature, solReceived, feesSol, error? }
 */

import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { JupiterService, RpcRotator, SOL_MINT, MIN_FEE_BUFFER_SOL, getLatencyLog, clearLatencyLog } from './jupiter';
import { Connection, Keypair } from '@solana/web3.js';
import bs58 from 'bs58';

// ──────────────────────────────────────────────────────────────────────────────
// GLOBAL MOCKS — must be defined BEFORE importing jupiter.ts internals
// ──────────────────────────────────────────────────────────────────────────────

// Mock logger to avoid console spam
vi.mock('./logger', () => ({
  log: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// Mock runtime-hooks — isHalted() returns false so the buy path is not blocked
vi.mock('./runtime-hooks', () => ({
  isHalted: () => false,
}));

describe('jupiter.ts — integration: real JupiterService against stubbed RPC', () => {
  let service: JupiterService;
  let mockKeypair: Keypair;
  let privateKeyBase58: string;

  beforeEach(() => {
    mockKeypair = Keypair.generate();
    privateKeyBase58 = bs58.encode(mockKeypair.secretKey);
    service = new JupiterService(
      ['https://mock-rpc.example.com'],
      privateKeyBase58,
      10_000, // priority fee
      1_000,  // jito tip
      'https://mock-jito.example.com/api/transactions'
    );
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ═══════════════════════════════════════════════════════════════════════════════
  // SMOKE — module imports and exports
  // ═══════════════════════════════════════════════════════════════════════════════

  it('jupiter.ts imports cleanly and exports expected symbols', async () => {
    const mod = await import('./jupiter');
    expect(mod.JupiterService).toBeDefined();
    expect(typeof mod.createJupiterService).toBe('function');
    expect(mod.SOL_MINT).toBe('So11111111111111111111111111111111111111112');
    expect(typeof mod.MIN_FEE_BUFFER_SOL).toBe('number');
    expect(typeof mod.getLatencyLog).toBe('function');
    expect(typeof mod.clearLatencyLog).toBe('function');
    expect(mod.RpcRotator).toBeDefined();
  });

  // ═══════════════════════════════════════════════════════════════════════════════
  // JUPITER SERVICE — CONSTRUCTOR
  // ═══════════════════════════════════════════════════════════════════════════════

  it('JupiterService constructor sets walletAddress from private key', () => {
    expect(service.walletAddress).toBe(mockKeypair.publicKey.toBase58());
  });

  it('JupiterService constructor configures Jito tip and engine URL', () => {
    expect(service['jitoTipLamports']).toBe(1_000);
    expect(service['jitoEngineUrl']).toBe('https://mock-jito.example.com/api/transactions');
  });

  it('JupiterService constructor sets priority fee', () => {
    expect(service['priorityFeeLamports']).toBe(10_000);
  });

  // ═══════════════════════════════════════════════════════════════════════════════
  // getWalletBalance — mocks rpc.exec (does NOT call fetch)
  // ═══════════════════════════════════════════════════════════════════════════════

  describe('getWalletBalance', () => {
    it('returns mocked balance on success', async () => {
      vi.spyOn(service['rpc'], 'exec').mockResolvedValue(1_000_000_000); // 1 SOL in lamports
      const balance = await service.getWalletBalance();
      expect(balance).toBe(1); // returns SOL, not lamports
    });

    it('retries on RPC failure then succeeds', async () => {
      let callCount = 0;
      vi.spyOn(service['rpc'], 'exec').mockImplementation(async () => {
        callCount++;
        if (callCount < 2) throw new Error('RPC_TIMEOUT');
        return 1_000_000_000;
      });
      // Stub markCurrentUnhealthy so the 60s restoration setTimeout doesn't linger
      vi.spyOn(service['rpc'], 'markCurrentUnhealthy').mockImplementation(() => {});
      const balance = await service.getWalletBalance();
      expect(balance).toBe(1);
      expect(callCount).toBe(2);
    });

    it('marks current endpoint unhealthy on persistent failure', async () => {
      vi.spyOn(service['rpc'], 'exec').mockRejectedValue(new Error('RPC_TIMEOUT'));
      const markUnhealthy = vi.spyOn(service['rpc'], 'markCurrentUnhealthy').mockImplementation(() => {});
      try {
        await service.getWalletBalance();
      } catch {
        // expected to throw after all retries + public-endpoint fallbacks
      }
      expect(markUnhealthy).toHaveBeenCalled();
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════════
  // getTokenBalance — mocks rpc.exec (does NOT call fetch)
  // ═══════════════════════════════════════════════════════════════════════════════

  describe('getTokenBalance', () => {
    // USDC mint is a valid base58 pubkey (new PublicKey() throws on non-base58)
    const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTt1sg';

    it('returns token balance as bigint on success', async () => {
      vi.spyOn(service['rpc'], 'exec').mockResolvedValue(BigInt(5_000_000));
      const balance = await service.getTokenBalance(USDC_MINT);
      expect(balance).toBe(BigInt(5_000_000));
    });

    it('retries on RPC failure then succeeds', async () => {
      let callCount = 0;
      vi.spyOn(service['rpc'], 'exec').mockImplementation(async () => {
        callCount++;
        if (callCount < 2) throw new Error('RPC_TIMEOUT');
        return BigInt(3_000_000);
      });
      vi.spyOn(service['rpc'], 'markCurrentUnhealthy').mockImplementation(() => {});
      const balance = await service.getTokenBalance(USDC_MINT);
      expect(balance).toBe(BigInt(3_000_000));
      expect(callCount).toBe(2);
    });

    it('returns 0n on token account not found (sentinel -1)', async () => {
      // getTokenBalance maps the BigInt(-1) sentinel from fetchBalance to BigInt(0)
      vi.spyOn(service['rpc'], 'exec').mockResolvedValue(BigInt(-1));
      const balance = await service.getTokenBalance(USDC_MINT);
      expect(balance).toBe(BigInt(0));
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════════
  // Public method surface
  // ═══════════════════════════════════════════════════════════════════════════════

  describe('public method surface', () => {
    it('service has expected public methods', () => {
      expect(typeof service.getWalletBalance).toBe('function');
      expect(typeof service.getTokenBalance).toBe('function');
      expect(typeof service.buyToken).toBe('function');
      expect(typeof service.sellToken).toBe('function');
      expect(typeof service.preflightQuote).toBe('function');
      expect(typeof service.fetchQuote).toBe('function');
      expect(typeof service.closeTokenAccount).toBe('function');
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════════
  // buyToken — mocks at the method boundary so the real orchestration runs
  // (getWalletBalance, getTokenBalance, fetchQuoteWithRetry, buildAndSendWithRetry)
  // ═══════════════════════════════════════════════════════════════════════════════

  describe('buyToken', () => {
    const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTt1sg';

    it('returns success with txSignature on full fill', async () => {
      vi.spyOn(service, 'getWalletBalance').mockResolvedValue(10);
      vi.spyOn(service, 'getTokenBalance').mockResolvedValue(BigInt(0));
      vi.spyOn(service, 'fetchQuoteWithRetry' as any).mockResolvedValue({
        outAmount: '1000000',
        priceImpactPct: '0.5',
        routePlan: [{ swapInfo: { label: 'raydium' } }],
        _fetchedAt: Date.now(),
      });
      vi.spyOn(service, 'buildAndSendWithRetry' as any).mockResolvedValue({
        signature: 'MOCK_BUY_SIGNATURE_123',
        postSwapBalances: [{ mint: USDC_MINT, amount: BigInt(1_000_000) }],
      });

      const result = await service.buyToken(USDC_MINT, 0.001, 100); // 0.001 SOL, 1% slippage

      expect(result.success).toBe(true);
      expect(result.txSignature).toBe('MOCK_BUY_SIGNATURE_123');
      expect(result.tokenAmountRaw).toBe(BigInt(1_000_000));
      expect(result.priceImpactPct).toBe(0.5);
    });

    it('handles partial fill (<70% of expected outAmount)', async () => {
      vi.spyOn(service, 'getWalletBalance').mockResolvedValue(10);
      vi.spyOn(service, 'getTokenBalance').mockResolvedValue(BigInt(0));
      vi.spyOn(service, 'fetchQuoteWithRetry' as any).mockResolvedValue({
        outAmount: '1000000',
        priceImpactPct: '0.5',
        routePlan: [{ swapInfo: { label: 'raydium' } }],
        _fetchedAt: Date.now(),
      });
      // 500_000 < 70% of 1_000_000 -> partial-fill branch
      vi.spyOn(service, 'buildAndSendWithRetry' as any).mockResolvedValue({
        signature: 'MOCK_PARTIAL_SIG',
        postSwapBalances: [{ mint: USDC_MINT, amount: BigInt(500_000) }],
      });

      const result = await service.buyToken(USDC_MINT, 0.001, 100);

      expect(result.success).toBe(true);
      expect(result.txSignature).toBe('MOCK_PARTIAL_SIG');
      expect(result.error).toContain('Partial fill');
    });

    it('handles quote failure gracefully (success=false, error defined)', async () => {
      vi.spyOn(service, 'getWalletBalance').mockResolvedValue(10);
      vi.spyOn(service, 'fetchQuoteWithRetry' as any).mockRejectedValue(new Error('No route'));

      const result = await service.buyToken(USDC_MINT, 0.001, 100);

      expect(result.success).toBe(false);
      expect(result.txSignature).toBeNull();
      expect(result.error).toBeDefined();
    });

    it('blocks buy when balance is too low', async () => {
      vi.spyOn(service, 'getWalletBalance').mockResolvedValue(0.001);

      const result = await service.buyToken(USDC_MINT, 1, 100);

      expect(result.success).toBe(false);
      expect(result.error).toContain('Balance low');
    });

    it('blocks buy when halted', async () => {
      const runtimeHooks = await import('./runtime-hooks');
      vi.spyOn(runtimeHooks, 'isHalted').mockReturnValue(true);

      const result = await service.buyToken(USDC_MINT, 0.001, 100);

      expect(result.success).toBe(false);
      expect(result.error).toBe('HALTED');
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════════
  // sellToken — mocks at the method boundary so the real orchestration runs
  // ═══════════════════════════════════════════════════════════════════════════════

  describe('sellToken', () => {
    const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTt1sg';

    it('returns success with txSignature on full sell', async () => {
      vi.spyOn(service, 'getTokenBalance').mockResolvedValue(BigInt(1_000_000));
      vi.spyOn(service, 'getWalletBalance')
        .mockResolvedValueOnce(1)   // solBefore
        .mockResolvedValue(2);      // after-sell polls (solAfter)
      vi.spyOn(service, 'fetchQuoteWithRetry' as any).mockResolvedValue({
        outAmount: '500000000', // 0.5 SOL in lamports
        priceImpactPct: '1.0',
        routePlan: [{ swapInfo: { label: 'raydium' } }],
        _fetchedAt: Date.now(),
      });
      vi.spyOn(service, 'buildAndSendWithRetry' as any).mockResolvedValue({
        signature: 'MOCK_SELL_SIGNATURE_456',
        postSwapBalances: [],
      });

      const result = await service.sellToken(USDC_MINT, BigInt(500_000), 100);

      expect(result.success).toBe(true);
      expect(result.txSignature).toBe('MOCK_SELL_SIGNATURE_456');
      expect(result.solReceived).toBeGreaterThan(0);
    });

    it('returns error when no token balance', async () => {
      vi.spyOn(service, 'getTokenBalance').mockResolvedValue(BigInt(0));

      const result = await service.sellToken(USDC_MINT, BigInt(0), 100);

      expect(result.success).toBe(false);
      expect(result.error).toContain('No token balance');
    });

    it('handles quote failure gracefully (success=false, error defined)', async () => {
      vi.spyOn(service, 'getTokenBalance').mockResolvedValue(BigInt(1_000_000));
      vi.spyOn(service, 'fetchQuoteWithRetry' as any).mockRejectedValue(new Error('No route'));

      const result = await service.sellToken(USDC_MINT, BigInt(500_000), 100);

      expect(result.success).toBe(false);
      expect(result.txSignature).toBeNull();
      expect(result.error).toBeDefined();
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════════
  // getLatencyLog / clearLatencyLog — module-level functions
  // ═══════════════════════════════════════════════════════════════════════════════

  describe('latency logging (module-level)', () => {
    it('getLatencyLog returns array', () => {
      const log = getLatencyLog();
      expect(Array.isArray(log)).toBe(true);
    });

    it('clearLatencyLog empties the log', () => {
      clearLatencyLog();
      const log = getLatencyLog();
      expect(log.length).toBe(0);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════════
  // RPC ROTATOR — health checks and failover
  // ═══════════════════════════════════════════════════════════════════════════════

  describe('RpcRotator', () => {
    let rotator: RpcRotator;

    beforeEach(() => {
      rotator = new RpcRotator();
    });

    it('adds endpoints and tracks primary', () => {
      rotator.add('https://rpc1.example.com', 'https://rpc1.example.com?api-key=primary');
      expect(rotator['endpoints'].length).toBeGreaterThan(0);
      expect(rotator['primaryUrl']).toBe('https://rpc1.example.com?api-key=primary');
    });

    it('executes function with connection and retries on timeout', async () => {
      rotator.add('https://rpc1.example.com');
      let callCount = 0;
      const mockFn = async (_c: Connection) => {
        callCount++;
        if (callCount < 3) throw new Error('RPC_TIMEOUT');
        return 'success';
      };
      const result = await rotator.exec('test', mockFn, 1000);
      expect(result).toBe('success');
      expect(callCount).toBe(3);
    });

    it('throws on non-retryable error', async () => {
      rotator.add('https://rpc1.example.com');
      const mockFn = async (_c: Connection) => {
        throw new Error('could not find account');
      };
      await expect(rotator.exec('test', mockFn, 1000)).rejects.toThrow('could not find account');
    });

    it('returns cached connection for same URL', () => {
      rotator.add('https://rpc1.example.com');
      const conn1 = rotator.connection;
      const conn2 = rotator.connection;
      expect(conn1).toBe(conn2);
    });

    it('marks endpoint unhealthy by index', () => {
      rotator.add('https://rpc1.example.com');
      expect(rotator['endpoints'][0].healthy).toBe(true);
      rotator.markUnhealthyByIndex(0);
      expect(rotator['endpoints'][0].healthy).toBe(false);
    });

    it('marks current endpoint unhealthy', () => {
      rotator.add('https://rpc1.example.com');
      rotator['currentIndex'] = 1;
      rotator.markCurrentUnhealthy();
      // Should mark the previous node (index 0) unhealthy
      expect(rotator['endpoints'][0].healthy).toBe(false);
    });
  });
});
