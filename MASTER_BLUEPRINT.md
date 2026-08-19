# MASTER BLUEPRINT: Exact Patch Instructions for F-1, F-7, F-9, S-4, and S-5

This document provides exact, line-by-line instructions to patch bugs **F-1**, **F-7**, **F-9**, **S-4**, and **S-5** across `server/jupiter.ts`, `server/routes.ts`, and `server/storage.ts`.

---

## 1. Bug F-1: Lamport Conversion Float Precision
**Target File**: `server/jupiter.ts`

### Root Cause
In `jupiter.ts` inside `buyToken()`, the conversion from `amountSol` to lamports uses `Math.floor(amountSol * 1e9)`. Due to IEEE-754 floating-point representation (e.g. `0.009 * 1e9 = 8999999.999999998`), `Math.floor` truncates to `8999999` (1 lamport short).

### Patch Instructions
1. Open `server/jupiter.ts`.
2. Locate line `461-462`:
   ```ts
   const lamports = Math.floor(amountSol * 1e9);
   ```
3. Replace with:
   ```ts
   const lamports = Math.round(amountSol * 1e9);
   ```
   Or using `BigInt`:
   ```ts
   const lamports = Number(BigInt(Math.round(amountSol * 1e9)));
   ```
4. Audit all other lamport calculations in `jupiter.ts` (e.g., `preflightQuote`, `fetchQuote`) to ensure `Math.round()` or `BigInt` is consistently used instead of `Math.floor()`.

---

## 2. Bug F-7: Position Manager Serialized Lock Blocking
**Target File**: `server/routes.ts`

### Root Cause
In `routes.ts`, `checkOpenPositions()` uses a top-level boolean `priceCheckLock`. When a trade exit or sell operation inside the loop takes multiple seconds (or retries), `priceCheckLock` stays `true`. Every subsequent 1s tick checks `if (priceCheckLock) return;` and immediately exits without processing any other active position.

### Patch Instructions
1. Open `server/routes.ts`.
2. Locate `checkOpenPositions()` (line ~1540):
   ```ts
   async function checkOpenPositions() {
     if (priceCheckLock) return;
     priceCheckLock = true;
     try { ... }
   ```
3. Replace synchronous in-loop blocking sell execution with non-blocking per-trade lock management:
   - Use `sellingInProgress.add(trade.id)` to lock only the specific trade being sold.
   - Detach the sell/Jupiter execution into a background `Promise` (fire-and-forget or tracked async task).
   - Immediately release `priceCheckLock` at the end of the price-evaluation loop pass without waiting for sell network round-trips.
4. Ensure `sellingInProgress.delete(trade.id)` is called in the `finally` block of the background sell task.

---

## 3. Bug F-9: Paper Exit PnL & Shadow PnL Accounting with Partial TP
**Target File**: `server/routes.ts`

### Root Cause
When a partial TP is executed on a trade:
- `partialLegMap.set(trade.id, { fraction: partialRatio, pnlPct: netPartialPnlPct })` records the partial leg.
- `updateTradeAmount(trade.id, remainingAmount)` updates the trade size in storage.
When the trade closes fully later, `finalPnlPct` is calculated using only the price change of the remaining leg, ignoring the PnL earned on the partial leg.

### Patch Instructions
1. Open `server/routes.ts`.
2. Locate the close handling for paper and shadow trades in `checkOpenPositions()` (around line ~1980):
   ```ts
   const _partialLeg = partialLegMap.get(trade.id);
   const _blendedPaperPnl = _partialLeg
     ? _partialLeg.pnlPct * _partialLeg.fraction + finalPnlPct! * (1 - _partialLeg.fraction)
     : finalPnlPct!;
   partialLegMap.delete(trade.id);
   closeShadowTrade(trade.tokenAddress, currentPrice, _blendedPaperPnl, reason).catch(() => {});
   ```
3. Ensure the stored exit record in `storage.closeTrade` receives `_blendedPaperPnl` (or that cost basis is reconstructed from initial size rather than reduced size) so daily PnL and total trade PnL reflect the full trade lifecycle.

---

## 4. Bug S-4: Async Unawaited Stats Update State Divergence
**Target Files**: `server/routes.ts` & `server/storage.ts`

### Root Cause
In `routes.ts`, `storage.updateBotStats({ walletBalance: ... })` is called with unawaited fire-and-forget `.catch(() => {})`. If an RPC error occurs immediately after, `readLiveWalletBalance()` falls back to `storage.getBotStatus()`, which returns stale data because the DB update hasn't resolved.

### Patch Instructions
1. Open `server/routes.ts`.
2. Locate all critical calls to `storage.updateBotStats` where `walletBalance` or `peakBalance` is updated after balance changes (e.g. lines ~590, ~730, ~1490, ~2120).
3. Change fire-and-forget calls to `await`:
   ```ts
   await storage.updateBotStats({ walletBalance: displayBalance, ... });
   ```
4. In `readLiveWalletBalance()`:
   Ensure `lastGoodLiveBalance` is synchronously updated whenever a balance is fetched or calculated before falling back to `storage.getBotStatus()`.

---

## 5. Bug S-5: Missing Transactional Memory Integrity on Trade Creation
**Target Files**: `server/routes.ts` & `server/storage.ts`

### Root Cause
When `storage.addTrade()` succeeds in `routes.ts`, but an error occurs before `peakPrices.set(trade.id, price)` and `tradeStopPrices.set(...)` are executed, the DB contains an `OPEN` trade. However, `checkOpenPositions()` ignores any trade where `!peakPrices.has(t.id)`:
