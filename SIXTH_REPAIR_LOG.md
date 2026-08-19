# SIXTH REPAIR LOG — Production Hardening

## Phase 1: Critical Math & Concurrency Patches

### F-1 Float Precision (server/jupiter.ts)
- **Fixed**: Replaced `Math.floor(amountSol * LAMPORTS_PER_SOL)` with `Math.round(amountSol * 1e9)` in `buyToken()`.
- **Root cause**: IEEE-754 double-precision floating point arithmetic (e.g. `0.009 * 1e9 = 8999999.999999998`) caused systematic 1-lamport under-funding on buy transactions.
- **Impact**: Prevents cumulative lamport loss across thousands of trades.

### F-9 Paper PnL Math (server/routes.ts)
- **Fixed**: After partial take-profit, `storage.updateTradeAmount()` reduces `trade.amount` to the remaining position size. Exit PnL calculation now recovers the original entry cost from `partialLegMap` so exit PnL% is honest.
- **Root cause**: `(returnSol - sizeSol) / sizeSol * 100` used the post-partial-TP remaining size as cost basis, falsifying the PnL percentage (e.g. a 40% partial sell reduced amount to 60%, making the final exit PnL appear ~1.67x larger than reality).
- **Impact**: Accurate paper PnL reporting, correct circuit breaker daily loss calculations.

### F-7 Async Starvation (server/routes.ts — checkOpenPositions)
- **Fixed**: Converted the blocking `await jupiterService!.sellToken(...)` live sell path into a non-blocking fire-and-forget async closure. `sellingInProgress` Set prevents duplicate sells; all state cleanup (PnL, DB close, memory maps) happens inside the background promise chain.
- **Root cause**: A single slow Jupiter API sell (12+ seconds) held `priceCheckLock`, blocking ALL other open positions from receiving price checks. During market-wide rugs, positions that could have been saved at -5% were instead closed at -50% because they were starved of exit opportunities.
- **Impact**: All positions are now evaluated every price-check cycle regardless of in-flight sells. Exit speed for simultaneously-rugging positions dramatically improved.
