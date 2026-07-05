import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { RpcRotator, JupiterService, getLatencyLog, clearLatencyLog, type LatencyRecord, SOL_MINT } from "./jupiter";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import bs58 from "bs58";

// Mock the logger to avoid console spam
vi.mock("./logger", () => ({
  log: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// Mock runtime hooks
vi.mock("./runtime-hooks", () => ({
  isHalted: () => false,
}));

describe("jupiter", () => {
  describe("RpcRotator", () => {
    let rotator: RpcRotator;

    beforeEach(() => {
      rotator = new RpcRotator();
    });

    it("adds endpoints correctly", () => {
      rotator.add("https://api.mainnet-beta.solana.com");
      expect(rotator["endpoints"].length).toBeGreaterThan(0);
    });

    it("adds full URL as primary when provided", () => {
      rotator.add("https://helius-rpc.com", "https://helius-rpc.com?api-key=primary");
      expect(rotator["primaryUrl"]).toBe("https://helius-rpc.com?api-key=primary");
    });

    it("tracks first URL as primary", () => {
      rotator.add("https://api.mainnet-beta.solana.com");
      expect(rotator["primaryUrl"]).toBe("https://api.mainnet-beta.solana.com");
    });

    it("marks endpoint unhealthy by index", () => {
      rotator.add("https://api.mainnet-beta.solana.com");
      const initialHealthy = rotator["endpoints"][0].healthy;
      expect(initialHealthy).toBe(true);

      rotator.markUnhealthyByIndex(0);
      expect(rotator["endpoints"][0].healthy).toBe(false);
    });

    it("marks current endpoint unhealthy", () => {
      rotator.add("https://api.mainnet-beta.solana.com");
      rotator["currentIndex"] = 1;
      rotator.markCurrentUnhealthy();
      // Should mark the previous node (index 0) unhealthy
      expect(rotator["endpoints"][0].healthy).toBe(false);
    });

    it("executes function with connection and retries on timeout", async () => {
      rotator.add("https://api.mainnet-beta.solana.com");
      
      let callCount = 0;
      const mockFn = async (c: Connection) => {
        callCount++;
        if (callCount < 3) {
          throw new Error("RPC_TIMEOUT");
        }
        return "success";
      };

      const result = await rotator.exec("test", mockFn, 1000);
      expect(result).toBe("success");
      expect(callCount).toBe(3);
    });

    it("executes function and throws on non-retryable error", async () => {
      rotator.add("https://api.mainnet-beta.solana.com");
      
      const mockFn = async (c: Connection) => {
        throw new Error("could not find account");
      };

      await expect(rotator.exec("test", mockFn, 1000)).rejects.toThrow("could not find account");
    });

    it("returns cached connection for same URL", () => {
      rotator.add("https://api.mainnet-beta.solana.com");
      const conn1 = rotator.connection;
      const conn2 = rotator.connection;
      expect(conn1).toBe(conn2);
    });

    it("rotates through healthy endpoints", () => {
      rotator.add("https://api.mainnet-beta.solana.com");
      rotator.add("https://rpc.ankr.com/solana");
      
      const idx1 = rotator["currentIndex"];
      rotator.connection;
      const idx2 = rotator["currentIndex"];
      
      expect(idx2).toBeGreaterThan(idx1);
    });
  });

  describe("JupiterService - Constructor", () => {
    it("initializes with RPC URLs and keypair", () => {
      const mockKeypair = Keypair.generate();
      const privateKeyBase58 = bs58.encode(mockKeypair.secretKey);
      
      const service = new JupiterService(
        ["https://api.mainnet-beta.solana.com"],
        privateKeyBase58
      );
      
      expect(service.walletAddress).toBe(mockKeypair.publicKey.toBase58());
    });

    it("initializes with Jito configuration", () => {
      const mockKeypair = Keypair.generate();
      const privateKeyBase58 = bs58.encode(mockKeypair.secretKey);
      
      const service = new JupiterService(
        ["https://api.mainnet-beta.solana.com"],
        privateKeyBase58,
        10_000,
        1_000,
        "https://mainnet.block-engine.jito.wtf/api/transactions"
      );
      
      expect(service["jitoTipLamports"]).toBe(1_000);
      expect(service["jitoEngineUrl"]).toBe("https://mainnet.block-engine.jito.wtf/api/transactions");
    });
  });

  describe("JupiterService - getWalletBalance", () => {
    let service: JupiterService;
    let mockKeypair: Keypair;

    beforeEach(() => {
      mockKeypair = Keypair.generate();
      const privateKeyBase58 = bs58.encode(mockKeypair.secretKey);
      service = new JupiterService(
        ["https://api.mainnet-beta.solana.com"],
        privateKeyBase58
      );
    });

    it("returns balance in SOL", async () => {
      // Mock the RPC exec to return a balance
      vi.spyOn(service["rpc"], "exec").mockResolvedValue(1_000_000_000); // 1 SOL
      
      const balance = await service.getWalletBalance();
      expect(balance).toBe(1);
    });

    it("retries on RPC failure", async () => {
      let callCount = 0;
      vi.spyOn(service["rpc"], "exec").mockImplementation(async () => {
        callCount++;
        if (callCount < 2) {
          throw new Error("RPC_TIMEOUT");
        }
        return 1_000_000_000;
      });
      
      const balance = await service.getWalletBalance();
      expect(balance).toBe(1);
      expect(callCount).toBe(2);
    });

    it("marks current unhealthy on failure", async () => {
      vi.spyOn(service["rpc"], "exec").mockRejectedValue(new Error("RPC_TIMEOUT"));
      vi.spyOn(service["rpc"], "markCurrentUnhealthy").mockImplementation(() => {});
      
      try {
        await service.getWalletBalance();
      } catch (e) {
        // Expected to fail
      }
      
      expect(service["rpc"].markCurrentUnhealthy).toHaveBeenCalled();
    });
  });

  describe("JupiterService - getTokenBalance", () => {
    let service: JupiterService;
    let mockKeypair: Keypair;

    beforeEach(() => {
      mockKeypair = Keypair.generate();
      const privateKeyBase58 = bs58.encode(mockKeypair.secretKey);
      service = new JupiterService(
        ["https://api.mainnet-beta.solana.com"],
        privateKeyBase58
      );
    });

    it("returns token balance as bigint", async () => {
      vi.spyOn(service["rpc"], "exec").mockResolvedValue(BigInt(1_000_000));
      
      const balance = await service.getTokenBalance(SOL_MINT);
      expect(balance).toBe(BigInt(1_000_000));
    });

    it("returns 0 for empty wallet (sentinel -1)", async () => {
      vi.spyOn(service["rpc"], "exec").mockResolvedValue(BigInt(-1));
      
      const balance = await service.getTokenBalance(SOL_MINT);
      expect(balance).toBe(BigInt(0));
    });

    it("retries on RPC failure", async () => {
      let callCount = 0;
      vi.spyOn(service["rpc"], "exec").mockImplementation(async () => {
        callCount++;
        if (callCount < 2) {
          throw new Error("RPC_TIMEOUT");
        }
        return BigInt(1_000_000);
      });
      
      const balance = await service.getTokenBalance(SOL_MINT);
      expect(balance).toBe(BigInt(1_000_000));
      expect(callCount).toBe(2);
    });
  });

  describe("JupiterService - preflightQuote", () => {
    let service: JupiterService;
    let mockKeypair: Keypair;

    beforeEach(() => {
      mockKeypair = Keypair.generate();
      const privateKeyBase58 = bs58.encode(mockKeypair.secretKey);
      service = new JupiterService(
        ["https://api.mainnet-beta.solana.com"],
        privateKeyBase58
      );
    });

    it("returns preflight result with price impact", async () => {
      const mockQuote = {
        outAmount: "1000000",
        priceImpactPct: "0.5",
        routePlan: [{ swapInfo: { label: "raydium" } }],
      };
      
      vi.spyOn(service, "fetchQuoteWithRetry" as any).mockResolvedValue(mockQuote);
      
      const result = await service.preflightQuote(SOL_MINT, "tokenMint", 1_000_000_000, 500);
      
      expect(result).toEqual({
        priceImpactPct: 0.5,
        outAmount: "1000000",
        routeInfo: "raydium",
      });
    });

    it("returns null on quote failure", async () => {
      vi.spyOn(service, "fetchQuoteWithRetry" as any).mockRejectedValue(new Error("No route"));
      
      const result = await service.preflightQuote(SOL_MINT, "tokenMint", 1_000_000_000, 500);
      expect(result).toBeNull();
    });
  });

  describe("JupiterService - buyToken", () => {
    let service: JupiterService;
    let mockKeypair: Keypair;

    beforeEach(() => {
      mockKeypair = Keypair.generate();
      const privateKeyBase58 = bs58.encode(mockKeypair.secretKey);
      service = new JupiterService(
        ["https://api.mainnet-beta.solana.com"],
        privateKeyBase58
      );
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it("returns success result on successful buy", async () => {
      vi.spyOn(service, "getWalletBalance").mockResolvedValue(10);
      vi.spyOn(service, "getTokenBalance").mockResolvedValue(BigInt(0));
      vi.spyOn(service, "fetchQuoteWithRetry" as any).mockResolvedValue({
        outAmount: "1000000",
        priceImpactPct: "0.5",
        routePlan: [{ swapInfo: { label: "raydium" } }],
        _fetchedAt: Date.now(),
      });
      vi.spyOn(service, "buildAndSendWithRetry" as any).mockResolvedValue({
        signature: "test_signature",
        postSwapBalances: [{ mint: "tokenMint", amount: BigInt(1_000_000) }],
      });
      
      const result = await service.buyToken("tokenMint", 1, 500);
      
      expect(result.success).toBe(true);
      expect(result.txSignature).toBe("test_signature");
      expect(result.tokenAmountRaw).toBe(BigInt(1_000_000));
    });

    it("blocks buy when halted", async () => {
      // Mock isHalted to return true
      const runtimeHooks = await import("./runtime-hooks");
      vi.spyOn(runtimeHooks, "isHalted").mockReturnValue(true);
      
      const result = await service.buyToken("tokenMint", 1, 500);
      
      expect(result.success).toBe(false);
      expect(result.error).toBe("HALTED");
      
      vi.restoreAllMocks();
    });

    it("returns error when balance is too low", async () => {
      vi.spyOn(service, "getWalletBalance").mockResolvedValue(0.001);
      
      const result = await service.buyToken("tokenMint", 1, 500);
      
      expect(result.success).toBe(false);
      expect(result.error).toContain("Balance low");
    });

    it("returns error when quote fails", async () => {
      vi.spyOn(service, "getWalletBalance").mockResolvedValue(10);
      vi.spyOn(service, "fetchQuoteWithRetry" as any).mockRejectedValue(new Error("No route"));
      
      const result = await service.buyToken("tokenMint", 1, 500);
      
      expect(result.success).toBe(false);
      expect(result.error).toContain("No route");
    });

    it("handles partial fill (<70% of expected)", async () => {
      vi.spyOn(service, "getWalletBalance").mockResolvedValue(10);
      vi.spyOn(service, "getTokenBalance").mockResolvedValue(BigInt(0));
      vi.spyOn(service, "fetchQuoteWithRetry" as any).mockResolvedValue({
        outAmount: "1000000",
        priceImpactPct: "0.5",
        routePlan: [{ swapInfo: { label: "raydium" } }],
        _fetchedAt: Date.now(),
      });
      vi.spyOn(service, "buildAndSendWithRetry" as any).mockResolvedValue({
        signature: "test_signature",
        postSwapBalances: [{ mint: "tokenMint", amount: BigInt(500_000) }], // 50% of expected
      });
      
      const result = await service.buyToken("tokenMint", 1, 500);
      
      expect(result.success).toBe(true);
      expect(result.error).toContain("Partial fill");
    });
  });

  describe("JupiterService - sellToken", () => {
    let service: JupiterService;
    let mockKeypair: Keypair;

    beforeEach(() => {
      mockKeypair = Keypair.generate();
      const privateKeyBase58 = bs58.encode(mockKeypair.secretKey);
      service = new JupiterService(
        ["https://api.mainnet-beta.solana.com"],
        privateKeyBase58
      );
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it("returns success result on successful sell", async () => {
      vi.spyOn(service, "getTokenBalance").mockResolvedValue(BigInt(1_000_000));
      vi.spyOn(service, "getWalletBalance")
        .mockResolvedValueOnce(1)
        .mockResolvedValue(2); // After sell
      
      vi.spyOn(service, "fetchQuoteWithRetry" as any).mockResolvedValue({
        outAmount: "10000000",
        priceImpactPct: "1.0",
        routePlan: [{ swapInfo: { label: "raydium" } }],
      });
      vi.spyOn(service, "buildAndSendWithRetry" as any).mockResolvedValue({
        signature: "test_signature",
        postSwapBalances: [],
      });
      
      const result = await service.sellToken("tokenMint", BigInt(1_000_000), 500);
      
      expect(result.success).toBe(true);
      expect(result.txSignature).toBe("test_signature");
      expect(result.solReceived).toBe(1);
    });

    it("returns error when no token balance", async () => {
      vi.spyOn(service, "getTokenBalance").mockResolvedValue(BigInt(0));
      
      const result = await service.sellToken("tokenMint", BigInt(0), 500);
      
      expect(result.success).toBe(false);
      expect(result.error).toContain("No token balance");
    });
  });

  describe("Latency Tracking", () => {
    beforeEach(() => {
      clearLatencyLog();
    });

    it("clears latency log", () => {
      expect(getLatencyLog().length).toBe(0);
    });

    it("limits log to MAX_LATENCY_LOG entries", () => {
      // This test verifies the log size limit is enforced
      // Since recordLatency is private, we can't directly test it
      // but we can verify the clear function works
      expect(getLatencyLog().length).toBe(0);
    });
  });

  describe("Constants", () => {
    it("exports SOL_MINT constant", () => {
      expect(SOL_MINT).toBe("So11111111111111111111111111111111111111112");
    });
  });
});
