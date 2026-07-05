import { vi, describe, it, expect, beforeEach } from 'vitest';

// Mock @solana/web3.js - use vi.hoisted for proper hoisting
const { mockConnectionInstance, mockKeypair } = vi.hoisted(() => {
  const connInstance = {
    getBalance: vi.fn().mockResolvedValue(500000000),
    getLatestBlockhash: vi.fn().mockResolvedValue({ blockhash: 'mock-hash', lastValidBlockHeight: 1000 }),
    sendRawTransaction: vi.fn().mockResolvedValue('mock-tx-signature'),
    confirmTransaction: vi.fn().mockResolvedValue({ value: { err: null } }),
    getParsedTokenAccountsByOwner: vi.fn().mockResolvedValue({
      value: [{
        pubkey: { toBase58: () => 'ATA_TOKEN_A' },
        account: { data: { parsed: { info: { mint: 'MINT_A', tokenAmount: { amount: '500000000' } } } } }
      }]
    })
  };

  const kp = {
    publicKey: { toBase58: () => 'TEST_WALLET' },
    secretKey: new Uint8Array(64)
  };

  return { mockConnectionInstance: connInstance, mockKeypair: kp };
});

vi.mock('@solana/web3.js', () => ({
  Connection: class MockConnection {
    constructor() { return mockConnectionInstance; }
    getBalance = mockConnectionInstance.getBalance;
    getLatestBlockhash = mockConnectionInstance.getLatestBlockhash;
    sendRawTransaction = mockConnectionInstance.sendRawTransaction;
    confirmTransaction = mockConnectionInstance.confirmTransaction;
    getParsedTokenAccountsByOwner = mockConnectionInstance.getParsedTokenAccountsByOwner;
  },
  PublicKey: class MockPublicKey {
    constructor(public val: string) {}
    toBase58() { return this.val; }
  },
  Keypair: {
    fromSecretKey: vi.fn().mockReturnValue(mockKeypair),
    generate: vi.fn().mockReturnValue(mockKeypair)
  },
  VersionedTransaction: {
    deserialize: vi.fn().mockReturnValue({ sign: vi.fn() })
  },
  LAMPORTS_PER_SOL: 1_000_000_000
}));

vi.mock('bs58', () => ({
  default: {
    decode: vi.fn().mockReturnValue(new Uint8Array(64)),
    encode: vi.fn().mockReturnValue('mock-sig')
  }
}));

vi.mock('@solana/spl-token', () => ({
  getAssociatedTokenAddress: vi.fn().mockResolvedValue('mock-ata'),
  getAccount: vi.fn().mockResolvedValue({ amount: BigInt('500000000') }),
  TOKEN_2022_PROGRAM_ID: 'token2022',
  TOKEN_PROGRAM_ID: 'token',
  createCloseAccountInstruction: vi.fn(),
  createBurnInstruction: vi.fn()
}));

// Setup global fetch intercept for Jupiter API endpoints
global.fetch = vi.fn();

import { JupiterService } from './server/jupiter';

describe('JupiterService Public API Verification', () => {
  let service: JupiterService;

  beforeEach(() => {
    vi.clearAllMocks();
    service = new JupiterService(
      ['https://api.mainnet-beta.solana.com'],
      'mockprivatekey'.padEnd(88, 'a'),
      10000,
      0,
      null
    );
  });

  it('should successfully fetch wallet balance through the public API', async () => {
    const balance = await service.getWalletBalance();
    expect(balance).toBeDefined();
    expect(typeof balance).toBe('number');
    expect(balance).toBeGreaterThan(0);
  });

  it('should fetch token balance and return bigint', async () => {
    const balance = await service.getTokenBalance('MINT_A');
    expect(balance).toBeDefined();
    expect(typeof balance).toBe('bigint');
  });
});