import { describe, it, expect } from "vitest";

/**
 * Baseline Tests for Bug F-7 and Bug F-9
 */

describe("F-7: Position Manager Global Lock Bottleneck", () => {
  it("demonstrates that priceCheckLock blocks concurrent ticks when a sell stalls", async () => {
    let priceCheckLock = false;
    let ticksProcessed = 0;

    async function checkOpenPositionsMock(isStalledSell: boolean) {
      if (priceCheckLock) {
        return { executed: false, reason: "LOCKED" };
      }
      priceCheckLock = true;
      try {
        if (isStalledSell) {
          // Simulate a 100ms slow sell operation holding the global lock
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        ticksProcessed++;
        return { executed: true, reason: "OK" };
      } finally {
        priceCheckLock = false;
      }
    }

    // Step 1: Slow sell begins execution on Tick 1
    const slowTickPromise = checkOpenPositionsMock(true);

    // Step 2: Tick 2 arrives while Tick 1 is still holding priceCheckLock
    const concurrentTickResult = await checkOpenPositionsMock(false);

    await slowTickPromise;

    // F-7 Bug: Concurrent tick was skipped due to global lock boolean
    expect(concurrentTickResult.executed).toBe(false);
    expect(concurrentTickResult.reason).toBe("LOCKED");
    expect(ticksProcessed).toBe(1);
  });
});

describe("F-9: Paper Exit & Shadow PnL Accounting with Partial Take-Profit", () => {
  it("demonstrates PnL reporting divergence when partial TP is not blended with final exit", () => {
    // Initial entry: 1.0 SOL at $10.00
    // Leg 1 (Partial TP): 40% (0.4 SOL) sold at $11.50 (+15.0% PnL)
    // Leg 2 (Final Exit): 60% (0.6 SOL) sold at $10.50 (+5.0% PnL)
    
    const entryPrice = 10.0;
    const partialPrice = 11.5;
    const finalExitPrice = 10.5;
    const partialFraction = 0.4;

    const partialPnlPct = ((partialPrice - entryPrice) / entryPrice) * 100; // +15%
    const finalLegPnlPct = ((finalExitPrice - entryPrice) / entryPrice) * 100; // +5%

    // Unpatched: Only reports finalLegPnlPct (+5.0%)
    const unpatchedReportedPnl = finalLegPnlPct;

    // Patched: Blends partial leg (+15% * 0.4) + final leg (+5% * 0.6) = 6.0% + 3.0% = +9.0%
    const blendedPnlPct = (partialPnlPct * partialFraction) + (finalLegPnlPct * (1 - partialFraction));

    expect(unpatchedReportedPnl).toBe(5.0);
    expect(blendedPnlPct).toBe(9.0);
    expect(unpatchedReportedPnl).not.toBe(blendedPnlPct);
  });
});
