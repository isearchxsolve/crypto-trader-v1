import { describe, it, expect } from "vitest";

/**
 * Baseline Tests for State Divergence S-4 and S-5
 */

describe("S-4: Async Unawaited Stats Update State Divergence", () => {
  it("shows DB balance falling out of sync when updateBotStats is unawaited", async () => {
    let dbStatus = { walletBalance: "0.0300" };
    let lastGoodLiveBalance = 0;

    // Simulates fire-and-forget updateBotStats call
    function fireAndForgetUpdateBotStats(newBal: string) {
      setTimeout(() => {
        dbStatus.walletBalance = newBal;
      }, 50);
    }

    async function readLiveWalletBalance(rpcAvailable: boolean): Promise<number> {
      if (rpcAvailable) {
        const liveBal = 0.0500;
        lastGoodLiveBalance = liveBal;
        fireAndForgetUpdateBotStats(liveBal.toFixed(4)); // Unawaited write
        return liveBal;
      }

      if (lastGoodLiveBalance > 0) return lastGoodLiveBalance;
      
      // Fallback to DB
      return parseFloat(dbStatus.walletBalance);
    }

    // 1. Live RPC call succeeds, triggers unawaited DB update
    await readLiveWalletBalance(true);

    // 2. Cache is lost (e.g. process restart / reset)
    lastGoodLiveBalance = 0;

    // 3. Immediately RPC fails before the unawaited DB update resolved
    const fallbackBal = await readLiveWalletBalance(false);

    // Divergence exposed: DB balance was still "0.0300" instead of "0.0500"
    expect(fallbackBal).toBe(0.0300);
  });
});

describe("S-5: Ghost Trade Creation via Missing Transactional Memory Integrity", () => {
  it("exposes unmonitored ghost trades when DB record exists without in-memory peakPrice mapping", async () => {
    const dbTrades: any[] = [];
    const peakPrices = new Map<number, number>();

    async function simulateOpenTrade(tokenSymbol: string, price: string, failInMemory: boolean) {
      const trade = { id: 42, tokenSymbol, status: "OPEN", price, amount: "0.005" };
      dbTrades.push(trade);

      if (failInMemory) {
        throw new Error("Crash/error before in-memory peakPrices map population");
      }

      peakPrices.set(trade.id, parseFloat(price));
      return trade;
    }

    // Simulate DB insert success followed by failure before peakPrices.set
    try {
      await simulateOpenTrade("GHOST", "1.50", true);
    } catch {
      // Error handled
    }

    const openDbTrades = dbTrades.filter(t => t.status === "OPEN");
    const monitoredTrades = openDbTrades.filter(t => peakPrices.has(t.id));

    // Exposing S-5: Trade exists as OPEN in DB, but monitoredTrades is 0
    expect(openDbTrades.length).toBe(1);
    expect(monitoredTrades.length).toBe(0);
  });
});
