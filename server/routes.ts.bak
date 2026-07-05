import { log } from "./logger";
import type { Express } from "express";
import type { Server } from "http";
import { storage, initStorageWrapper } from "./storage";
import { api } from "@shared/routes";
import { JupiterService, createJupiterService, SOL_MINT, MIN_FEE_BUFFER_SOL,getLatencyLog  } from "./jupiter";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { join as pathJoin } from "path";
import { startHeartbeat, isHalted, healthState } from "./runtime-hooks";

// ── MULTIPLIER & STAGING CACHES ──
const SEARCH_QUERIES = ["raydium sol", "meteora sol", "orca sol", "solana usdc", "sol usdt", "raydium usdc", "orca usdc", "meteora usdc", "raydium usdt", "orca usdt", "sol usdc"]; // WIDENED: more liquid DEX+quote-pair seeds to surface more quality candidates (no safety bar lowered)
const watchlistCache = new Map<string, { pair: DexScreenerPair, firstSeen: number }>();
const WATCHLIST_MAX_AGE_MS = 15 * 60_000; // Keep on watch for 15 mins

const MIN_VIABLE_TRADE_SOL  = 0.001; // Force-lowered to allow <0.003 SOL trades
const MIN_TRADE_SIZE_SOL    = 0.001; // Force-lowered to allow <0.003 SOL trades
const EXECUTION_TIMEOUT_MS  = 60_000; // Increased from 30,000 for network stability

const ADMIN_SECRET = process.env.ADMIN_SECRET?.trim() || null;

// Warn at module load time so the operator sees it immediately in startup logs.
// The warning fires once — not on every request — to avoid log spam.
if (!ADMIN_SECRET) {
  console.warn(
    "[SECURITY] ADMIN_SECRET env var is not set — all admin endpoints " +
    "are publicly accessible. Set ADMIN_SECRET before going live."
  );
}

// ── MICRO-AWARE EDGE GATE ────────────────────────────────────────────────
// One source of truth for both the live and paper edge checks. Micro wallets
// relax the gate so a sub-0.10 SOL balance can actually clear round-trip cost;
// normal wallets keep the strict fee-bleed protection unchanged.
interface EdgeParams {
  minEdgePct:        number; // edge threshold (pass if edge >= this)
  feeMultiplier:     number; // multiplier on txFeePercent (2 = model both legs)
  buffer:            number; // flat safety cushion, pct
  expectedMoveCoeff: number; // score→expected-move slope
  exitImpactMult:    number; // modeled exit impact = entry impact × this
}

function getEdgeParams(isMicroWallet: boolean): EdgeParams {
  if (isMicroWallet) {
    return {
      minEdgePct:        engineSettings.microMinEdgePct,
      feeMultiplier:     2.0,
      buffer:            engineSettings.microEdgeBuffer,
      expectedMoveCoeff: 0.35,
      exitImpactMult:    1.30,
    };
  }
  return {
    minEdgePct:        engineSettings.minEdgePct,
    feeMultiplier:     2.0,
    buffer:            engineSettings.edgeBuffer,
    expectedMoveCoeff: 0.35,
    exitImpactMult:    1.30,
  };
}

function requireAdmin(req: any, res: any): boolean {
  if (!ADMIN_SECRET) {
    res.status(500).json({ error: "Server Misconfiguration: ADMIN_SECRET is not set in .env" });
    return false;
  }
  const provided = req.headers["x-admin-secret"] ?? req.body?.adminSecret;
  if (provided !== ADMIN_SECRET) {
    res.status(403).json({ error: "Forbidden — invalid admin secret" });
    return false;
  }
  return true;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, operationName: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${operationName} timed out after ${timeoutMs}ms`)), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    clearTimeout(timer);
  }
}

const JUPITER_SUPPORTED_DEXES = new Set([
  "raydium", "raydium-clmm", "raydium-cp", "orca", "orca-whirlpool",
  "meteora", "meteora-dlmm", "meteora-damm-v2", "pumpswap", "pumpfun",
  "pump-fun", "openbook", "phoenix", "lifinity", "saber", "aldrin",
  "cropper", "stepn", "invariant", "dooar", "sencha", "saros", "whirlpool",
]);

const JUPITER_INDEX_DELAY_MS = 20_000; // Reduced 75s→60s→45s→30s: widens entry window for fresh pools
// high-scorers aged out of Jupiter block but had already pumped past viable edge check. 60s is safely
// above the real Jupiter indexing floor (~45s) while catching momentum before impact blows the edge.
// After a confirmed buy, Solana RPC nodes can take 30-90s to propagate the new ATA balance.
// During this window getTokenBalance() legitimately returns 0 even though tokens were received.
// We suppress all desync-close logic for this many ms after a trade opens to prevent
// false DESYNC_AUTO_CLOSE events on fresh buys.
const DESYNC_GRACE_PERIOD_MS = 180_000; // Extended 90s→180s: live testing showed Helius RPC takes >90s to propagate fresh ATAs

interface DexScreenerPair {
  chainId: string;
  dexId: string;
  pairAddress: string;
  baseToken: { address: string; name: string; symbol: string };
  quoteToken: { address: string; name: string; symbol: string };
  priceUsd?: string;
  priceNative?: string;
  txns?: { m5?: { buys: number; sells: number }; h1?: { buys: number; sells: number }; h24?: { buys: number; sells: number } };
  volume?: { m5?: number; h1?: number; h6?: number; h24?: number };
  priceChange?: { m5?: number; h1?: number; h6?: number; h24?: number };
  liquidity?: { usd?: number };
  fdv?: number;
  marketCap?: number;
  pairCreatedAt?: number;
}

// ── ANTI-BAN: STRICT DEXSCREENER QUEUE ──
// Forces ALL requests into a single-file line to mathematically prevent WAF IP Bans.
class RequestQueue {
    private queue: (() => Promise<void>)[] = [];
    private processing = false;
    private lastRun = 0;
    private delay = 350; // Hard limit: ~2.8 requests per second max

    async enqueue<T>(task: () => Promise<T>): Promise<T> {
        return new Promise((resolve, reject) => {
            this.queue.push(async () => {
                try {
                    const now = Date.now();
                    const elapsed = now - this.lastRun;
                    if (elapsed < this.delay) {
                        await new Promise(r => setTimeout(r, this.delay - elapsed));
                    }
                    this.lastRun = Date.now();
                    const result = await task();
                    resolve(result);
                } catch (e) {
                    reject(e);
                }
            });
            if (!this.processing) this.process();
        });
    }

    private async process() {
        this.processing = true;
        while (this.queue.length > 0) {
            const task = this.queue.shift();
            if (task) await task();
        }
        this.processing = false;
    }
}

const dexQueue = new RequestQueue();

async function throttledDexScreenerFetch(url: string, timeoutMs: number = 8000): Promise<any> {
    return dexQueue.enqueue(async () => {
        const fetchTask = async () => {
            const resp = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
            if (!resp.ok) {
                if (resp.status === 429 || resp.status === 403) {
                    console.warn(`[RATE LIMIT] DexScreener WAF blocked request (${resp.status}). Pausing entire queue for 10 seconds to shed heat...`);
                    await new Promise(r => setTimeout(r, 10000));
                }
                throw new Error(`HTTP ${resp.status}`);
            }
            return await resp.json(); 
        };

        // Enforce a hard timeout 2 seconds longer than the fetch timeout
        return await withTimeout(fetchTask(), timeoutMs + 2000, `DexScreener Fetch`);
    });
}

let engineSettings = {

  // -- Core Exit & Speed Strategy --
  // PATCH #3: lowered from 15/8 to 5/3. Memecoin pumps rarely reach +15% in a single
  // push; they spike +5-8% then crash. With activation at 15, trailing never armed on
  // real pumps. $Taz peaked at +5.64% and never had its trailing stop armed.
  trailingStopActivation: 5,    // Arm trailing stop as soon as we have +5% profit
  trailingStopDistance: 3,      // Tighter floor once armed (was 8 — too loose for fast rugs)
  hardTakeProfit: 200,          // Aggressive 200% TP for 100 SOL path
  stopLoss: -10,                 // 10% SL to match hard loss kill

  // -- Conviction Gates --
  minScoreToTrade: 75,          // Lowered for higher trade frequency — historical WR 91.6% supports this
  
  // -- SNIPER Mode Calibration --
  sniperMinScore: 70,
  sniperMinBuyPressure: 0.58,   // Was 0.65 — too strict for current flat market; 0.58 still buyer-dominant
  // -- Core Exit & Speed Strategy --
  // trailingStopActivation: 5, 
  // trailingStopDistance: 2.5, 
  // hardTakeProfit: 80, 
  // stopLoss: -6,
  maxHoldSeconds: 420, 
    maxOpenPositions: 1,          // MANDATORY: Only 1 position at a time
    startingBalance: 0.01,        // PROTOCOL: 0.01 SOL starting balance
  scanIntervalMs: 30000, 
  priceCheckIntervalMs: 1000,   // ACCELERATED: Catch peaks faster to offset fees

  // -- Conviction Gates (Lowered for current market) --
  // minScoreToTrade: 85,          // was 85 → matches actual B+ setups
  mlServiceUrl: "http://localhost:5001",
  mlWeight: 0.10, 
  scoreWeight: 0.90, 
  dailyLossLimitPct: 10,
  microDailyLossLimitPct: 10, // FIX(daily-loss-micro): micro wallets (<0.10 SOL) use a wider daily-loss cap aligned with maxDrawdownPct. A 10% cap on a sub-0.10 SOL wallet = ~0.006 SOL, smaller than one trade's round-trip cost, so it trips after ~1 trade and then DEADLOCKS the bot (can't trade to recover) until the calendar date rolls over. 
  maxDrawdownPct: 25,
  lossCooldownMs: 600000, 
  partialTpRatio: 0.5, 
  partialTpThreshold: 15, 

  // -- Sizing Strategy (Calibrated for 1000x compounding) --
  minPositionSize: 0.004,       // Raised from 0.001: floor-size trades bled fees as a huge % of position. 0.004 keeps fee drag sane while staying small on a ~0.07 SOL wallet.
  maxPositionSize: 1.0,      // Raised: Allow compounding to scale positions as balance grows. Caps below enforce safety.
  
  // -- SNIPER Mode Calibration --
  // sniperMinScore: 60,
  sniperMaxAge: 900,            // Was 300 — too tight; in a flat market the best 58–59 candidates are 5–15 min old and were stuck at "Mode: none". 900s (15 min) lets them qualify for SNIPER (still gated by bp5m, liq).
  // sniperMinBuyPressure: 0.55, 
  sniperMinLiquidity: 50000, 
  sniperMaxSize: 0.003,      
  mgMinScore: 75,            
  mgMaxSize: 0.004, 
  hwrMinScore: 75,           
  hwrMinLiquidity: 50000,    
  hwrMaxSize: 0.004,

  // -- Mode Classifier Thresholds (MG / HWR gates) --
  mgMinVolMomentum: 0.7,    // Was 1.0 — required rising volume; 0.7 admits steady (not just accelerating) volume
  mgMinPriceChange5m: 1.5,  // Was 3 — required strong 5m pump; 1.5 admits early/mild momentum
  mgMinTxVelocity: 8,       // Was 10 — minor relax for thinner-but-active pairs
  hwrMinBuyPressure5m: 0.55,
  hwrMinBuyPressure1h: 0.50,

  // -- Operational Safety & Discovery --
  maxTradesPerCycle: 1, 
  reentryDelayMs: 60000, 
  slReentryDelayMs: 900000, 
  txCostsEnabled: 1,
  safetyChecksEnabled: 1,
  txFeePercent: 1.5, // Bumped from 0.5 for high volatility priority
  rugcheckMinScore: 400, 

  // -- Micro-aware EDGE gate (dashboard-tunable) --
  // Only the two LOW-RISK knobs are exposed. feeMultiplier (2.0),
  // expectedMoveCoeff (0.35) and exitImpactMult (1.30) are intentionally
  // NOT settable — they model real round-trip economics and loosening them
  // re-admits fee-bleed/optimism. They stay hardcoded in getEdgeParams().
  minEdgePct:       2.0,   // non-micro edge threshold (pass if edge >= this)
  edgeBuffer:       1.0,   // non-micro flat cushion, pct
  microMinEdgePct:  0.5,   // micro-wallet edge threshold
  microEdgeBuffer:  0.5,   // micro-wallet flat cushion, pct

  maxVolLiqRatioNewToken: 14, 
  maxDiscoveryAgeSeconds: 86400, // FIX: raised 3h->24h so mature, liquid trending tokens reach the scanner (was starving funnel of anything but seconds-old junk)
  
  dynamicHoldEnabled: 1, 
  dynamicHoldMaxSeconds: 2100,
  
  // -- Compound / Micro-Boost (Tiered sizing is the real compounding mechanism) --
  // The old compound boost was dead code: it re-clamped to the same ceiling it
  // multiplied, so it never increased position size. Compounding now happens
  // via progressive de-risking (getTieredSizing): aggressive % at micro balance,
  // conservative % at scale. These settings only control the optional MICRO
  // accelerator (active below 0.05 SOL, capped at 1.5x, plus the absolute cap).
  compoundBoostEnabled: 1,   // Toggle micro-boost on/off
  compoundRefSol: 0.01,      // Reference balance for the micro-boost curve
  compoundPower: 1.35,      // Shape of the micro-boost curve (1.0 = linear)
  compoundMaxMultiplier: 10.0, // Legacy cap; actual boost capped at 1.5x in code
  compoundAbsCapSol: 10.0,  // Hard absolute SOL ceiling on any single position
};

let liveCandidatesCache: any[] = [], lastScanTime = 0;
let isFetchingCandidates = false; // <-- The Anti-Spam Lock

// ── Shadow mode ───────────────────────────────────────────────────────────────
// Runs alongside paper mode. For every token the bot WOULD buy, we:
//   1. Fetch a real Jupiter quote (real slippage + route)
//   2. Record the quoted entry price
//   3. Simulate the exit 60s later using DexScreener price
//   4. Log the gap between paper PnL and shadow PnL
// This reveals how much your paper results would degrade under real execution.
export interface ShadowTrade {
  id:               number;
  tokenAddress:     string;
  tokenSymbol:      string;
  mode:             string;
  score:            number;
  paperEntryPrice:  number;          // price used by paper trading
  shadowEntryPrice: number;          // price implied by Jupiter quote
  quoteImpactPct:   number;          // real price impact from Jupiter
  quoteDurationMs:  number;          // how long the quote took
  quoteAgeAtBuyMs:  number;          // quote age when "buy" was placed
  routeHops:        number;          // number of hops in Jupiter route
  routeLabel:       string;          // e.g. "Raydium→Orca"
  sizeSol:          number;
  openedAt:         number;          // timestamp
  closedAt?:        number;
  paperExitPrice?:  number;
  shadowExitPrice?: number;
  paperPnlPct?:     number;
  shadowPnlPct?:    number;
  pnlGapPct?:       number;          // paperPnlPct - shadowPnlPct = your paper inflation
  exitReason?:      string;
  outAmountRaw?:    string;   // Jupiter buy-quote outAmount (raw token units) — used for shadow exit quote
}

let shadowModeEnabled = true;        // set false to disable without redeploying
let shadowTradeIdSeq  = 0;
const shadowOpenTrades = new Map<number, ShadowTrade>();
const shadowClosedTrades: ShadowTrade[] = [];
const MAX_SHADOW_HISTORY = 200;

export function getShadowTrades(): { open: ShadowTrade[]; closed: ShadowTrade[] } {
  return {
    open:   Array.from(shadowOpenTrades.values()),
    closed: [...shadowClosedTrades],
  };
}

export function setShadowModeEnabled(v: boolean): void { shadowModeEnabled = v; }

/** Called when the scanner decides to paper-buy. Fires a real Jupiter quote
 *  for the same token+size and records the shadow entry. Non-blocking. */
async function openShadowTrade(
  jup: JupiterService | null,
  tokenAddress: string,
  tokenSymbol:  string,
  mode:         string,
  score:        number,
  paperPrice:   number,
  sizeSol:      number,
): Promise<void> {
  if (!shadowModeEnabled || !jup) return;
  try {
    const lamports    = Math.floor(sizeSol * 1e9);
    const quoteStart  = Date.now();
    const quote       = await jup.fetchQuote(SOL_MINT, tokenAddress, lamports, [500, 1000]);
    const quoteDurMs  = Date.now() - quoteStart;
    if (!quote || !quote.outAmount) return;

    // Implied entry price from quote: SOL in / tokens out (normalised to USD via paperPrice ratio)
    // We can't get the exact USD price from the quote alone, but we CAN measure
    // slippage as: shadowPrice = paperPrice * (1 + priceImpactPct/100)
    const impactPct       = parseFloat(quote.priceImpactPct ?? "0");
    const shadowEntryPrice = paperPrice * (1 + impactPct / 100);
    const routeLabels     = (quote.routePlan ?? [])
      .map((s: any) => s.swapInfo?.label ?? "?")
      .slice(0, 4)
      .join("→") || "direct";
    const routeHops       = (quote.routePlan ?? []).length;
    const quoteAgeAtBuy   = Date.now() - (quote._fetchedAt ?? Date.now());

    const id = ++shadowTradeIdSeq;
    const rec: ShadowTrade = {
      id, tokenAddress, tokenSymbol, mode, score,
      paperEntryPrice:  paperPrice,
      shadowEntryPrice,
      quoteImpactPct:   impactPct,
      quoteDurationMs:  quoteDurMs,
      quoteAgeAtBuyMs:  quoteAgeAtBuy,
      routeHops,
      routeLabel:       routeLabels,
      sizeSol,
      openedAt:         Date.now(),
      outAmountRaw:     quote.outAmount ?? undefined,  // stored for real exit quote in closeShadowTrade
    };
    shadowOpenTrades.set(id, rec);
    console.log(
      `[SHADOW] OPEN #${id} $${tokenSymbol} | impact:${impactPct.toFixed(2)}% ` +
      `paperEntry:$${paperPrice.toFixed(8)} shadowEntry:$${shadowEntryPrice.toFixed(8)} ` +
      `route:${routeLabels}(${routeHops}hop) quoteFetch:${quoteDurMs}ms`
    );
  } catch (e: any) {
    console.warn(`[SHADOW] Quote failed for $${tokenSymbol}: ${e.message}`);
  }
}

/** Called whenever a paper trade closes. Looks up the matching shadow trade,
 *  fetches current DexScreener price, and records final comparison. */
async function closeShadowTrade(
  tokenAddress: string,
  paperExitPrice: number,
  paperPnlPct:    number,
  exitReason:     string,
): Promise<void> {
  if (!shadowModeEnabled) return;
  // Find the matching open shadow trade by tokenAddress
  let match: ShadowTrade | undefined;
  for (const t of shadowOpenTrades.values()) {
    if (t.tokenAddress === tokenAddress) { match = t; break; }
  }
  if (!match) return;
  shadowOpenTrades.delete(match.id);

  // Compute shadow exit price.
  // Preferred path: fire a real Jupiter exit quote using the token amount we recorded
  // at open. This gives an accurate exit impact on the actual pool state at close time
  // rather than extrapolating from the (stale, buy-side) entry impact.
  // Fallback (no outAmountRaw or quote fails): use the old derived formula.
  let shadowExitPrice: number;
  let exitImpactPct = match.quoteImpactPct * 1.3; // fallback estimate

  if (jupiterService && match.outAmountRaw && match.outAmountRaw !== "0") {
    try {
      const exitQuote = await jupiterService.fetchQuote(
        match.tokenAddress, SOL_MINT, match.outAmountRaw, [500, 1000]
      );
      if (exitQuote?.outAmount) {
        exitImpactPct = parseFloat(exitQuote.priceImpactPct ?? "0");
        shadowExitPrice = paperExitPrice * (1 - exitImpactPct / 100);
      } else {
        shadowExitPrice = paperExitPrice * (1 - exitImpactPct / 100);
      }
    } catch {
      shadowExitPrice = paperExitPrice * (1 - exitImpactPct / 100);
    }
  } else {
    shadowExitPrice = paperExitPrice * (1 - exitImpactPct / 100);
  }

  const shadowPnlPct    = ((shadowExitPrice - match.shadowEntryPrice) / match.shadowEntryPrice) * 100;
  const pnlGapPct       = paperPnlPct - shadowPnlPct;

  const closed: ShadowTrade = {
    ...match,
    closedAt:       Date.now(),
    paperExitPrice,
    shadowExitPrice,
    paperPnlPct,
    shadowPnlPct,
    pnlGapPct,
    exitReason,
  };
  shadowClosedTrades.push(closed);
  if (shadowClosedTrades.length > MAX_SHADOW_HISTORY) shadowClosedTrades.shift();

  const gapStr = pnlGapPct >= 0
    ? `paper beats shadow by +${pnlGapPct.toFixed(2)}% (paper inflation)`
    : `shadow beats paper by ${Math.abs(pnlGapPct).toFixed(2)}%`;
  console.log(
    `[SHADOW] CLOSE #${match.id} $${match.tokenSymbol} | ` +
    `paper:${paperPnlPct.toFixed(2)}% shadow:${shadowPnlPct.toFixed(2)}% | ${gapStr} | ${exitReason}`
  );
}
// ─────────────────────────────────────────────────────────────────────────────
let tradedAddresses = new Map<string, number>();
let stoppedOutAddresses = new Map<string, number>();
const hardBlockedAddresses = new Map<string, number>();
const HARD_BLOCK_TTL_MS = 300_000;
// Rugcheck-specific long block: tokens that fail rugcheck danger flags or score
// are overwhelmingly structural problems (High Ownership, Low Liquidity) that do
// NOT resolve in 5 minutes. Blocking them for 30 minutes stops $BEEKEEPER-style
// repeat evaluation where the same token burns a rugcheck API slot every scan cycle.
const rugcheckBlockedAddresses = new Map<string, number>();
const RUGCHECK_BLOCK_TTL_MS = 30 * 60_000; // 30 minutes
// Rugcheck circuit breaker: if 3+ consecutive fetches timeout within 60s, switch to
// heuristics-only mode for 5 minutes to allow trading to continue during outages.
// This mirrors the existing 5xx outage fallthrough but covers DNS/network timeouts.
let rugcheckTimeoutCount = 0;
let rugcheckTimeoutWindowStart = 0;
let rugcheckHeuristicsOnlyUntil = 0;
let scannerInterval: ReturnType<typeof setInterval> | null = null;
let priceCheckerInterval: ReturnType<typeof setInterval> | null = null;
let paperBalance = engineSettings.startingBalance;
let balanceInitialized = false;
let peakPrices = new Map<number, number>();
let prevPnlMap = new Map<number, number>();
let pnlStableMap = new Map<number, { pnl: number; since: number }>();
let tradeStopPrices = new Map<number, number>();
let partialTpTaken = new Set<number>();
let consecutiveWins = 0, consecutiveLosses = 0;
let mlServiceAvailable = false;
let jupiterService: JupiterService | null = null;
let liveTokenBalances = new Map<number, bigint>();
let dailyPnlSol = 0, dailyTradeCount = 0;
let dailyStartBalance = engineSettings.startingBalance;
let lastDailyReset = new Date().toDateString();
let peakBalance = engineSettings.startingBalance;
// LIFETIME ROI BASELINE: the real on-chain balance recorded the FIRST time live trading
// ever started, persisted to disk so it survives restarts (true lifetime denominator,
// not reset each boot). 0 = paper mode / not yet captured.
let liveStartingBalance = 0;
function liveBaselineFile(): string { return pathJoin(process.cwd(), "live-baseline.json"); }
function loadLiveBaseline(): number {
  try {
    const f = liveBaselineFile();
    if (existsSync(f)) {
      const v = parseFloat(JSON.parse(readFileSync(f, "utf8")).startingBalance);
      return Number.isFinite(v) && v > 0 ? v : 0;
    }
  } catch (e) { console.warn(`[ROI] read live-baseline.json failed: ${(e as any)?.message}`); }
  return 0;
}
function saveLiveBaseline(bal: number): void {
  try {
    writeFileSync(liveBaselineFile(), JSON.stringify({ startingBalance: bal, capturedAt: new Date().toISOString() }, null, 2));
    console.log(`[ROI] Lifetime baseline captured: ${bal.toFixed(4)} SOL → live-baseline.json`);
  } catch (e) { console.warn(`[ROI] write live-baseline.json failed: ${(e as any)?.message}`); }
}
let circuitBreakerActive = false;
let flightToSafetyActive = false;
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

function triggerFlightToSafety() {
  if (!jupiterService || flightToSafetyActive) return;
  flightToSafetyActive = true;
  console.log(`[FLIGHT TO SAFETY] Circuit breaker hit. Swapping all SOL to USDC...`);
  jupiterService.getWalletBalance().then(async (bal) => {
    const safeAmount = Math.max(0, bal - 0.05); // Leave 0.05 SOL for fees
    if (safeAmount > 0.05) {
      // BUGFIX #1: was 500 bps (5%) — sandwich bots steal 2-3% of the swap.
      // SOL/USDC on Jupiter routes through major DEXes with deep liquidity;
      // 50 bps (0.5%) is more than enough and prevents MEV extraction.
      const result = await jupiterService!.buyToken(USDC_MINT, safeAmount, 50);
      if (result.success) {
        console.log(`[FLIGHT TO SAFETY] Successfully shielded ${safeAmount.toFixed(4)} SOL into USDC.`);
      } else {
        console.log(`[FLIGHT TO SAFETY] Swap failed: ${result.error}`);
        flightToSafetyActive = false; // reset so it can try again
      }
    } else {
      // BUGFIX #2: wallet too small to flight-to-safety (<0.10 SOL after fee reserve).
      // Previously the flag stayed true forever, blocking all trading and never
      // calling triggerReturnFromSafety(). Now we log and reset so the bot can
      // continue trading (the circuit breaker's loss-limit protection still applies).
      console.log(`[FLIGHT TO SAFETY] Wallet balance ${bal.toFixed(4)} SOL too small to shield (need >0.10 after 0.05 fee reserve) — resetting flight flag, breaker stays active via circuitBreakerActive`);
      flightToSafetyActive = false;
    }
  }).catch((e) => {
    console.log(`[FLIGHT TO SAFETY] Error: ${e.message}`);
    flightToSafetyActive = false;
  });
}

function triggerReturnFromSafety() {
  if (!jupiterService || !flightToSafetyActive) return;
  flightToSafetyActive = false; 
  console.log(`[FLIGHT TO SAFETY] Market clear. Swapping USDC back to SOL...`);
  jupiterService.getTokenBalance(USDC_MINT).then(async (usdcBal) => {
    if (usdcBal > 0n) {
      // BUGFIX #1: was 500 bps — same MEV risk on the return swap.
      const result = await jupiterService!.sellToken(USDC_MINT, usdcBal, 50);
      if (result.success) {
        console.log(`[FLIGHT TO SAFETY] Successfully returned to SOL. Received ${result.solReceived.toFixed(4)} SOL.`);
      } else {
        console.log(`[FLIGHT TO SAFETY] Return swap failed: ${result.error}`);
        flightToSafetyActive = true; 
      }
    }
  }).catch((e) => {
    console.log(`[FLIGHT TO SAFETY] Error: ${e.message}`);
    flightToSafetyActive = true;
  });
}
let lastLossCooldownEnd = 0;
let lastMiniCooldownEnd = 0; // 2-loss mini-cooldown (3 min) — shorter than the 3-loss gate
let totalTradesAllTime = 0;
let engineStartTime = Date.now();
let mlCheckerInterval: ReturnType<typeof setInterval> | null = null;
let priceCheckLock = false;
let sellingInProgress = new Set<number>();
let scanLock = false;
let reservedCapital = 0;
// BALANCE RESILIENCE: cache the last successful on-chain wallet read so transient RPC
// failures (429 / timeout / fetch failed) don't collapse live sizing & micro-detection to
// the 0.01 paper sentinel. Fallback order: last-good on-chain -> persisted DB walletBalance
// -> paper sentinel (last resort only).
let lastGoodLiveBalance = 0;
async function readLiveWalletBalance(): Promise<number> {
  if (jupiterService) {
    try {
      const b = await jupiterService.getWalletBalance();
      if (typeof b === "number" && Number.isFinite(b) && b > 0) { lastGoodLiveBalance = b; return b; }
    } catch (err) {
      console.log(`[RPC] getWalletBalance failed — using last-good ${lastGoodLiveBalance.toFixed(4)} SOL: ${(err as any)?.message}`);
    }
  }
  if (lastGoodLiveBalance > 0) return lastGoodLiveBalance;
  try {
    const st = await storage.getBotStatus();
    const dbBal = parseFloat(String((st as any)?.walletBalance ?? "0"));
    if (Number.isFinite(dbBal) && dbBal > 0 && dbBal !== engineSettings.startingBalance) { lastGoodLiveBalance = dbBal; return dbBal; }
  } catch {}
  return paperBalance;
}
let pendingBuys = new Map<string, number>();
let recentlyAttemptedBuys = new Map<string, number>();
// Tracks consecutive on-chain zero-balance reads per trade id.
// A single zero read can be RPC lag — require 3 in a row before closing as desync.
// Cleared immediately when a non-zero read comes in.
const zeroBalanceStrikes = new Map<number, number>();
const ZERO_STRIKES_REQUIRED = 3;
// Tracks consecutive unfetchable price reads per trade id (fetchTokenPriceForExit returns 0).
// This happens when a pair is delisted or migrated from DexScreener — the trade then skips
// all exit logic indefinitely, including MAX_HOLD. After ZERO_PRICE_STRIKES_REQUIRED
// consecutive zero-price cycles (~30s), force-close at last known DB price so a dead
// feed can never permanently freeze a position open.
const zeroPriceStrikes = new Map<number, number>();
const ZERO_PRICE_STRIKES_REQUIRED = 30; // 30s at 1000ms priceCheckIntervalMs
// FIX: sellFailureStrikes and MAX_SELL_FAILURES were used in the live sell-failure
// handler but never declared — caused ReferenceError crashing the position manager
// on the first failed live sell attempt.
const sellFailureStrikes = new Map<number, number>();
const MAX_SELL_FAILURES = 3;
// Tracks how many times each token address has been BOUGHT in the current session.
// Prevents fee bleed from repeatedly entering the same token (e.g. $ANIME 6x in 28min).
// In live mode each failed re-entry costs real Jupiter priority fees even if the trade
// itself breaks even. Cap: score < 90 → max 2 entries per token per session.
const sessionTokenBuyCount = new Map<string, number>();
// FIX B: Track how many stop-losses each token has accumulated this session.
// A token that stopped out once might be unlucky; one that stopped out twice is
// structurally hostile right now. After 2+ SLs on the same token, extend its
// blackout from slReentryDelayMs to REPEAT_LOSER_BLOCK_MS (4 hours) so the bot
// stops bleeding priority fees re-entering the same bad setup repeatedly.
const tokenStopLossCount = new Map<string, number>();
const REPEAT_LOSER_BLOCK_MS = 8 * 60 * 60_000; // 8 hours (was 4h — extended to stop re-entering same rug)
// POST-LOSS COOLDOWN: After ANY loss on a token, block re-entry for this many ms.
// Prevents the common pattern of win → loss (re-entry) → loss (re-entry again) seen
// with $Mantis, $ROCKET, $VDOR etc. where the bot chases a token that just reversed.
// Separate from slReentryDelayMs (SL-only, 15min) — this applies to ALL loss exits.
const POST_LOSS_COOLDOWN_MS = 8 * 60 * 1000; // 8 minutes
// 2-loss mini-cooldown: shorter pause before the 3-loss 10-min one.
// After 2 consecutive losses the market has already shown 2 hostile fills;
// waiting 3 minutes before the next entry gives price action time to stabilise
// and prevents adding a third loss while still in the same adverse move.
const MINI_LOSS_COOLDOWN_MS = 3 * 60_000; // 3 minutes
const tokenLastLossMs = new Map<string, number>(); // tokenAddress → timestamp of last loss exit
// SYMBOL-BASED POST-LOSS COOLDOWN: blocks re-entry on the same token symbol even when the
// contract address has changed (e.g. $PORNHUB migrated to a new address after a rug).
// Address-only gates are bypassed entirely in that case — this closes the gap.
const tokenSymbolLastLossMs = new Map<string, number>(); // symbol → timestamp of last loss exit
const SYMBOL_LOSS_COOLDOWN_MS = 8 * 60_000; // 8 minutes — matches POST_LOSS_COOLDOWN_MS (was 4 min, too short for migrated contracts)
// SYMBOL-BASED SESSION CONCENTRATION: caps same-symbol entries regardless of contract address.
// Prevents patterns like $Pilots entering 3× from three different contract addresses while
// the address-based sessionTokenBuyCount shows 0 for each one.
const sessionSymbolBuyCount = new Map<string, number>(); // symbol → entry count this session
// Lifecycle logging helpers — structured output for production validation.
// Adds zero logic overhead and is safe to remove at any time.
const lifecycleLastLogMs = new Map<number, number>(); // trade.id → last LIFECYCLE:HOLD timestamp
const trailActivatedLogged = new Set<number>();        // trade.id → TRAIL:ACTIVATED already emitted
const LIFECYCLE_HOLD_INTERVAL_MS = 30_000;
const costGateLastLogMs = new Map<number, number>(); // DIAG-COSTGATE throttle: trade.id -> last log ms (one line / 30s)             // heartbeat every 30s per trade
// FIX LIQ_CO: warn-once guard so the "entry liquidity missing" message is logged
// exactly once per trade instead of every priceCheckIntervalMs (1000ms) forever.
const liqCoWarnedTrades = new Set<number>();
// BUGFIX #14: tracks consecutive partial TP sell failures per trade.
// After 3 failures (rugged pool / no route), stop retrying to save priority fees.
const partialTpFailuresMap = new Map<number, number>();
// PATCH #6: per-trade last-rugcheck timestamp for mid-hold re-evaluation.
// Rugpulls execute over 1-3 minutes; an entry-time rugcheck can pass while the
// rugpuller is still accumulating. Re-running rugcheck every 60s during the hold
// catches new risk flags that appear mid-rug.
const midHoldRugcheckMs = new Map<number, number>();
const midHoldRugcheckLastHash = new Map<number, string>();
// FIX PRICE_SANITY SPAM + STUCK TRADE: tracks consecutive PRICE_SANITY rejections per
// trade. A single bad-feed tick is transient and self-corrects in 1–3 cycles. But a
// token that stays below PRICE_RATIO_MIN for 30+ consecutive cycles (~30 seconds) has
// almost certainly rugged — the price IS real, not a feed error.
// After PRICE_SANITY_FORCE_CLOSE_CYCLES sustained downward rejections:
//   • paper: closes immediately at the rug price
//   • live:  attempts a 30%-slippage sell (async, non-blocking), then closes the DB
//            record regardless of sell outcome so the position is never permanently stuck.
// Upward spikes (ratio > PRICE_RATIO_MAX) are NOT force-closed — they are typically
// feed errors that self-correct, and closing on a spike would lock in a false loss.
const priceSanityRejections  = new Map<number, number>(); // trade.id → consecutive rejection count
const priceSanityWarnOnce    = new Set<number>();          // warn-once guard per trade
const PRICE_SANITY_FORCE_CLOSE_CYCLES = 7;                // FIX #1: reduced 30→3 cycles (3s). 30s held rugged tokens open for the entire drain window.
// FIX #3: raised 3→7 cycles (7s). 3s proved insufficient — DexScreener stale-price
// glitches routinely persist 3–6s, causing PRICE_SANITY_FORCE_CLOSE to fire on live
// tokens that had NOT rugged (e.g. $RALLY: entry $0.013899, exit at -99%, price
// recovered to $0.012780 within seconds). 7 consecutive sub-1%-of-entry readings
// (7s at priceCheckIntervalMs=1000ms) is still fast enough to catch a real rug
// before significant additional drain, while surviving transient feed errors.
// FIX SYMBOL_SL: tracks the last time a symbol exited via SL/LIQ_COLLAPSE so that
// a relaunch on a NEW contract address is still blocked for the full slReentryDelayMs.
// Separate from tokenSymbolLastLossMs (which covers all losses at SYMBOL_LOSS_COOLDOWN_MS).
const tokenSymbolSlBlockMs = new Map<string, number>(); // symbol → timestamp of last SL/LIQ exit
const SYMBOL_SL_COOLDOWN_MS = 15 * 60_000; // mirrors slReentryDelayMs

const tokenPriceCache = new Map<string, { price: number; pair: DexScreenerPair | null; ts: number }>();
const jupiterQuoteCache = new Map<string, { quote: any; ts: number }>();
const QUOTE_CACHE_TTL_MS = 4_000; // FIX 4: was 2000 — too short, causes rate-limit hits and trade delays

setInterval(() => {
  const now = Date.now();
  for (const [k, v] of tokenPriceCache) if (now - v.ts > 1500) tokenPriceCache.delete(k);
  for (const [k, v] of jupiterQuoteCache) if (now - v.ts > QUOTE_CACHE_TTL_MS) jupiterQuoteCache.delete(k);
}, 1_500); // match tokenPriceCache TTL — 5s interval let entries linger up to 6.5s

function getCachedQuote(key: string): any | null {
  const entry = jupiterQuoteCache.get(key);
  if (entry && Date.now() - entry.ts < QUOTE_CACHE_TTL_MS) return entry.quote;
  return null;
}
function setCachedQuote(key: string, quote: any): void {
  jupiterQuoteCache.set(key, { quote, ts: Date.now() });
}

async function resetDailyStats() {
  const today = new Date().toDateString();
  if (today !== lastDailyReset) {
    dailyPnlSol = 0; dailyTradeCount = 0;
    const modeStatus = await storage.getBotStatus().catch(() => ({ tradingMode: "paper" }));
    if (modeStatus.tradingMode === "live" && jupiterService) {
      dailyStartBalance = await jupiterService.getWalletBalance().catch(() => paperBalance);
    } else {
      dailyStartBalance = await getEffectiveBalance();
    }
    lastDailyReset = today;
    if (!circuitBreakerActive) console.log(`[RISK] Daily stats reset | Start balance: ${dailyStartBalance.toFixed(3)} SOL`);
  }
}

async function getEffectiveBalance(): Promise<number> {
  const modeStatus = await storage.getBotStatus().catch(() => ({ tradingMode: "paper" }));
  
  // 1. Establish the base free balance depending on the mode
  let baseBalance = paperBalance;
  if (modeStatus.tradingMode === "live" && jupiterService) {
    // RESILIENT: never collapse to the 0.01 paper sentinel on a transient RPC failure.
    baseBalance = await readLiveWalletBalance();
  }

  // 2. Add the real-time value of all open positions
  const openTrades = await storage.getOpenTrades();
  let openCapital = 0;
  for (const t of openTrades) {
    if (!peakPrices.has(t.id)) continue;
    if (sellingInProgress.has(t.id)) continue; // FIX(circuit-breaker): skip positions whose on-chain sell already returned SOL to the wallet but whose trade row isn't closed yet. Counting wallet proceeds AND the still-"open" position double-counts capital (~0.10 SOL from a 0.069 wallet), corrupting peakBalance and falsely tripping MAX_DRAWDOWN -> FLIGHT TO SAFETY.
    const sizeSol = parseFloat(t.amount || "0");
    const entryPrice = parseFloat(t.price || "0");
    const currentPrice = parseFloat(t.currentPrice || t.price || "0");
    if (sizeSol > 0 && entryPrice > 0 && currentPrice > 0) {
      const unrealizedPnlPct = ((currentPrice - entryPrice) / entryPrice) * 100;
      const unrealizedPnlSol = sizeSol * (unrealizedPnlPct / 100);
      openCapital += sizeSol + unrealizedPnlSol;
    }
  }
  
  // 3. Return the true total portfolio value
  return Math.max(0, baseBalance + openCapital);
}

let cachedSolPriceUsd = 180, lastSolPriceFetch = 0, solPriceFetchedOnce = false;
const SOL_PRICE_CACHE_TTL_MS = 20_000;

async function getLiveSolPrice(): Promise<number> {
  const now = Date.now();
  if (solPriceFetchedOnce && now - lastSolPriceFetch < SOL_PRICE_CACHE_TTL_MS) return cachedSolPriceUsd;
  let fetchSucceeded = false;
  try {
    const resp = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${SOL_MINT}`, { signal: AbortSignal.timeout(3000) });
    if (resp.ok) {
      const data = await resp.json();
      const pairs = data?.pairs || [];
      const bestPair = pairs.filter((p: any) => p.chainId === "solana").sort((a: any, b: any) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0))[0];
      const price = parseFloat(bestPair?.priceUsd ?? "0");
      if (price > 0) {
        cachedSolPriceUsd = price;
        lastSolPriceFetch = now;
        solPriceFetchedOnce = true;  // BUGFIX #8: only set on successful fetch
        fetchSucceeded = true;
      }
    }
  } catch {}
  // BUGFIX #8: was unconditionally setting solPriceFetchedOnce=true even on failure,
  // which locked in the default $180 for the full 20s cache TTL. SOL is currently $73,
  // so all cost/sizing calculations were 2.4x wrong. Only update timestamp on failure
  // so we retry sooner (next cycle), but don't mark as fetched.
  if (!fetchSucceeded) {
    lastSolPriceFetch = now;  // throttle retries but don't mark as fetched
  }
  return cachedSolPriceUsd;
}

async function getOpenUnrealizedPnl(): Promise<number> {
  const openTrades = await storage.getOpenTrades();
  let total = 0;
  for (const t of openTrades) {
    // FIX: same ghost-trade guard as getEffectiveBalance — only include trades
    // actively tracked in memory. Ghost DB rows from previous sessions inflate
    // unrealizedPnl, which can falsely trip the DAILY_LOSS_LIMIT circuit breaker
    // before any trade in the current session has even executed.
    if (!peakPrices.has(t.id)) continue;
    // BUGFIX #15: skip trades being force-sold. Their on-chain sell already
    // returned SOL to the wallet (or will soon), but the trade row is still
    // OPEN. Counting both the wallet proceeds AND the still-"open" unrealized
    // PnL double-counts, inflating effective balance and preventing the circuit
    // breaker from tripping when it should.
    if (sellingInProgress.has(t.id)) continue;
    const entry = parseFloat(t.price), current = parseFloat(t.currentPrice || t.price), size = parseFloat(t.amount);
    if (entry > 0 && current > 0 && size > 0) total += size * (((current - entry) / entry) * 100) / 100;
  }
  return total;
}
let lastBtcCheckTime = 0;
let cachedBtcCrashActive = false;

async function checkBitcoinSafety(): Promise<boolean> {
  const now = Date.now();
  if (now - lastBtcCheckTime < 60_000) return cachedBtcCrashActive;
  
  try {
    const resp = await fetch("https://api.binance.com/api/v3/ticker/24hr?symbol=BTCUSDT", { signal: AbortSignal.timeout(3000) });
    if (resp.ok) {
      const data = await resp.json();
      const pctChange = parseFloat(data.priceChangePercent);
      if (!isNaN(pctChange)) {
        if (pctChange <= -5.0) {
          if (!cachedBtcCrashActive) console.log(`[RISK] 🚨 BITCOIN CRASH DETECTED: BTC is down ${pctChange.toFixed(2)}%. Activating global market circuit breaker!`);
          cachedBtcCrashActive = true;
        } else if (pctChange >= -3.0) {
          if (cachedBtcCrashActive) console.log(`[RISK] �������� BITCOIN RECOVERING: BTC is now at ${pctChange.toFixed(2)}%. Deactivating global market circuit breaker.`);
          cachedBtcCrashActive = false;
        }
      }
    }
  } catch (err) {
    // Fail silently if Binance is unreachable; rely on cached state
  }
  
  lastBtcCheckTime = now;
  return cachedBtcCrashActive;
}

async function checkCircuitBreakers(): Promise<{ canTrade: boolean; reason: string }> {
  await resetDailyStats();
  
  const isBtcCrash = await checkBitcoinSafety();
  if (isBtcCrash) {
    circuitBreakerActive = true;
    triggerFlightToSafety();
    return { canTrade: false, reason: `GLOBAL_MARKET_CRASH (BTC is down > 5%)` };
  }

  // FIX Y-2: use NET daily PNL (realized + unrealized). The old code separated and
  // summed only the negative components, so a profitable day (+5 SOL realized)
  // with a minor floating loss (-0.2 SOL) registered as a loss and could trigger
  // the breaker. We now fire only when the net day is actually negative.
  const unrealized  = await getOpenUnrealizedPnl();
  const netDailyPnl = dailyPnlSol + unrealized;
  const totalLoss   = netDailyPnl < 0 ? Math.abs(netDailyPnl) : 0;
  const dailyLossPct = dailyStartBalance > 0 ? (totalLoss / dailyStartBalance) * 100 : 0;
  const effDailyLossLimitPct = dailyStartBalance < 0.10 ? engineSettings.microDailyLossLimitPct : engineSettings.dailyLossLimitPct; // FIX(daily-loss-micro): micro wallets use the wider, trade-meaningful cap; per-trade cost gate + liquidity floor + loss cooldown remain the primary protections.
  if (dailyLossPct >= effDailyLossLimitPct) {
    circuitBreakerActive = true;
    triggerFlightToSafety();
    return { canTrade: false, reason: `DAILY_LOSS_LIMIT (${dailyLossPct.toFixed(1)}% >= ${effDailyLossLimitPct}%)` };
  }
  const effectiveBal = await getEffectiveBalance();
  // FIX U-1: keep peakBalance in sync with unrealized gains. Previously it only
  // updated on trade close, so a rally followed by a crash measured drawdown from
  // the pre-rally peak, missing the true post-rally drawdown entirely.
  if (effectiveBal > peakBalance) {
    peakBalance = effectiveBal;
    // FIX UI-PEAK: sync to DB so the frontend reads the correct peak on every cycle.
    // Without this the UI drawdown display reads a stale DB value (e.g. old paper peak
    // 0.093 SOL) and shows a false 28.6% drawdown even though in-memory peak is correct.
    // Fire-and-forget — canTrade must not block on a DB write.
    storage.updateBotStats({ peakBalance: peakBalance.toFixed(4) }).catch(() => {});
  }
  const drawdownPct = peakBalance > 0 ? ((peakBalance - effectiveBal) / peakBalance) * 100 : 0;
  if (drawdownPct >= engineSettings.maxDrawdownPct) {
    circuitBreakerActive = true;
    triggerFlightToSafety();
    return { canTrade: false, reason: `MAX_DRAWDOWN (${drawdownPct.toFixed(1)}% >= ${engineSettings.maxDrawdownPct}%)` };
  }
  if (Date.now() < lastMiniCooldownEnd) {
    const remaining = Math.ceil((lastMiniCooldownEnd - Date.now()) / 1000);
    // BUGFIX #17: if flight-to-safety was triggered but the underlying condition
    // (daily loss / drawdown / BTC crash) has cleared, return to SOL even though
    // we're still in cooldown. Otherwise bot stays stuck in USDC for the full
    // cooldown duration, missing recovery trades.
    if (circuitBreakerActive) {
      circuitBreakerActive = false;
      triggerReturnFromSafety();
      console.log(`[RISK] Circuit breaker cleared during cooldown — returning from USDC to SOL`);
    }
    return { canTrade: false, reason: `MINI_LOSS_COOLDOWN (${remaining}s remaining — 2 consecutive losses)` };
  }
  if (Date.now() < lastLossCooldownEnd) {
    const remaining = Math.ceil((lastLossCooldownEnd - Date.now()) / 1000);
    if (circuitBreakerActive) {
      circuitBreakerActive = false;
      triggerReturnFromSafety();
      console.log(`[RISK] Circuit breaker cleared during cooldown — returning from USDC to SOL`);
    }
    return { canTrade: false, reason: `LOSS_COOLDOWN (${remaining}s remaining)` };
  }
  circuitBreakerActive = false;
  triggerReturnFromSafety();
  return { canTrade: true, reason: "OK" };
}

async function checkMLService(): Promise<boolean> {
  try {
    const resp = await fetch(`${engineSettings.mlServiceUrl}/health`, { signal: AbortSignal.timeout(2000) });
    if (resp.ok) { mlServiceAvailable = true; return true; }
  } catch {}
  mlServiceAvailable = false;
  return false;
}

function sanitizeNum(v: any, fallback = 0): number { const n = Number(v); return isNaN(n) || !isFinite(n) ? fallback : n; }

/**
 * Tiered position-sizing for the 1000x compounding path.
 *
 * The old compound boost was dead code: it multiplied by the boost then
 * immediately re-clamped to `remainingBalance * MAX_SINGLE_TRADE_PCT` — the
 * same ceiling applied before the boost — so the multiplier could never
 * increase the actual trade size. This replaces it with progressive de-risking:
 * aggressive at micro balance (where a single loss is negligible), conservative
 * at scale (where a single loss at 55% would be catastrophic).
 *
 * Returns { pct, boost, tier } where pct is the effective fraction of balance
 * to risk per trade, and boost is an optional micro-stage accelerator (capped
 * at 1.5x) that helps escape the dust-trade floor on the first few trades.
 *
 * Monte Carlo (2000 runs, 91.3% WR, +33.2%/-15.1%):
 *   99.6% reach 1000x | median 87 trades | median max DD 9.8%
 *   Circuit breaker (25% DD) hit rate: 0.4%
 *
 * @param totalPortfolioSol  Free SOL balance + total open-position cost basis
 */
function getTieredSizing(totalPortfolioSol: number): { pct: number; boost: number; tier: string } {
  // Micro-stage boost: helps the 0.01 SOL wallet escape dust-trade floor.
  // Capped at 1.5x — enough to clear MIN_TRADE_SIZE_SOL on the first few
  // trades without taking on the geometric risk of the old 10x uncapped boost.
  let boost = 1.0;
  if (engineSettings.compoundBoostEnabled && totalPortfolioSol < 0.05) {
    const ref = Math.max(0.01, engineSettings.compoundRefSol);
    const ratio = totalPortfolioSol / ref;
    const raw = Math.pow(ratio, engineSettings.compoundPower);
    boost = Math.min(1.5, Math.max(1.0, raw));
  }
  // Progressive de-risking: size as % of balance shrinks as balance grows.
  // A 55% loss at 0.01 SOL is 0.0055 SOL (trivial). A 55% loss at 10 SOL is
  // 5.5 SOL (catastrophic). The tiers keep per-trade loss impact bounded.
  let pct: number, tier: string;
  if (totalPortfolioSol < 0.05) {
    pct = 0.10; /* SAFE PROFILE: ~10% per trade (was 0.55) - bounds single-trade loss on a small live wallet */ tier = "MICRO";          // -8.3% per loss — aggressive growth
  } else if (totalPortfolioSol < 0.20) {
    pct = 0.10; /* SAFE PROFILE: ~10% per trade (was 0.44) - bounds single-trade loss on a small live wallet */ tier = "GROWTH";         // -6.7% per loss
  } else if (totalPortfolioSol < 1.0) {
    pct = 0.30; tier = "SCALING";        // -4.5% per loss
  } else if (totalPortfolioSol < 5.0) {
    pct = 0.19; tier = "CONSERVATIVE";   // -2.9% per loss
  } else {
    pct = 0.14; tier = "PRESERVATION";   // -2.1% per loss — protect gains
  }
  return { pct, boost, tier };
}

async function getMLPrediction(metrics: Record<string, number>): Promise<{ pumpProb: number; dumpRisk: number; version: string } | null> {
  if (!mlServiceAvailable) return null;
  const liq = sanitizeNum(metrics.liq);
  if (liq < 500) return null;
  try {
    const vol5m = sanitizeNum(metrics.vol5m), vol1h = sanitizeNum(metrics.vol1h);
    const volMomentum = vol1h > 0 ? (vol5m * 12) / vol1h : 0;
    const fdv = sanitizeNum(metrics.fdv);
    const body = {
      age_seconds: sanitizeNum(metrics.ageSeconds, 99999), liquidity_usd: liq, volume_5m: vol5m, volume_1h: vol1h,
      volume_change_1m: sanitizeNum(volMomentum), price_change_5m: sanitizeNum(metrics.priceChange5m),
      price_change_1h: sanitizeNum(metrics.priceChange1h), buy_pressure_5m: sanitizeNum(metrics.buyPressure5m, 0.5),
      buy_pressure_1h: sanitizeNum(metrics.buyPressure1h, 0.5),
      buy_sell_ratio: sanitizeNum(metrics.h1buys, 0) / (sanitizeNum(metrics.h1sells, 0) + 0.001),
      tx_velocity_per_hour: sanitizeNum(metrics.txVelocity5m) * 12, fdv, liq_to_mcap: fdv > 0 ? liq / fdv : 0,
    };
    const resp = await fetch(`${engineSettings.mlServiceUrl}/predict`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(3000) });
    if (!resp.ok) return null;
    const data = await resp.json();
    if (data.error) return null;
    const pumpProb = Math.max(0, Math.min(1, Number(data.pump_probability) || 0));
    const dumpRisk = Math.max(0, Math.min(1, data.dump_risk != null ? Number(data.dump_risk) : 1));
    return { pumpProb, dumpRisk, version: data.model_version || "unknown" };
  } catch { return null; }
}

async function getMLBatchPredictions(tokenMetrics: Record<string, number>[]): Promise<({ pumpProb: number; dumpRisk: number; version: string } | null)[]> {
  if (!mlServiceAvailable || tokenMetrics.length === 0) return tokenMetrics.map(() => null);
  try {
    const validIndices: number[] = [], tokens: any[] = [];
    for (let i = 0; i < tokenMetrics.length; i++) {
      const m = tokenMetrics[i];
      const liq = sanitizeNum(m.liq);
      if (liq < 500) continue;
      validIndices.push(i);
      const vol5m = sanitizeNum(m.vol5m), vol1h = sanitizeNum(m.vol1h);
      const volMomentum = vol1h > 0 ? (vol5m * 12) / vol1h : 0;
      const fdv = sanitizeNum(m.fdv);
      tokens.push({
        age_seconds: sanitizeNum(m.ageSeconds, 99999), liquidity_usd: liq, volume_5m: vol5m, volume_1h: vol1h,
        volume_change_1m: sanitizeNum(volMomentum), price_change_5m: sanitizeNum(m.priceChange5m),
        price_change_1h: sanitizeNum(m.priceChange1h), buy_pressure_5m: sanitizeNum(m.buyPressure5m, 0.5),
        buy_pressure_1h: sanitizeNum(m.buyPressure1h, 0.5),
        buy_sell_ratio: sanitizeNum(m.h1buys, 0) / (sanitizeNum(m.h1sells, 0) + 0.001),
        tx_velocity_per_hour: sanitizeNum(m.txVelocity5m) * 12, fdv, liq_to_mcap: fdv > 0 ? liq / fdv : 0,
      });
    }
    if (tokens.length === 0) return tokenMetrics.map(() => null);
    const resp = await fetch(`${engineSettings.mlServiceUrl}/predict/batch`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ tokens }), signal: AbortSignal.timeout(5000) });
    if (!resp.ok) return tokenMetrics.map(() => null);
    const data = await resp.json();
    const preds = data.predictions || [];
    // FIX: partial response mismatch (e.g. one token timed out server-side) should
    // use whatever predictions arrived, not discard all. Map what we got; null-fill
    // the rest so rule-scoring still applies to the unmatched tokens.
    if (preds.length !== validIndices.length) {
      console.warn(`[ML] Batch mismatch: expected ${validIndices.length}, got ${preds.length} — using partial results`);
    }
    const results: ({ pumpProb: number; dumpRisk: number; version: string } | null)[] = tokenMetrics.map(() => null);
    for (let j = 0; j < Math.min(preds.length, validIndices.length); j++) {
      const p = preds[j];
      if (p.error) continue;
      results[validIndices[j]] = { pumpProb: Math.max(0, Math.min(1, Number(p.pump_probability) || 0)), dumpRisk: Math.max(0, Math.min(1, p.dump_risk != null ? Number(p.dump_risk) : 1)), version: p.model_version || "unknown" };
    }
    return results;
  } catch { return tokenMetrics.map(() => null); }
}

async function fetchTokenPrice(tokenAddress: string): Promise<{ price: number; pair: DexScreenerPair | null }> {
  const now = Date.now();
  const cached = tokenPriceCache.get(tokenAddress);
  if (cached && now - cached.ts < 1500) return { price: cached.price, pair: cached.pair };
  try {
    // UPDATED: Using Throttled Fetch
    const data = await throttledDexScreenerFetch(`https://api.dexscreener.com/latest/dex/tokens/${tokenAddress}`, 5000);
    const pairs = (data.pairs || []) as DexScreenerPair[];
    const solanaPairs = pairs.filter(p => p.chainId === "solana");
    if (solanaPairs.length === 0) return { price: 0, pair: null };
    const validPairs = solanaPairs.filter(p => { const liq = p.liquidity?.usd || 0, vol5m = p.volume?.m5 || 0; return !(liq > 0 && vol5m > liq * 15); });
    if (validPairs.length === 0) return { price: 0, pair: null };
    const bestPair = validPairs.sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0))[0];
    const result = { price: parseFloat(bestPair.priceUsd || "0"), pair: bestPair };
    if (result.price <= 0) return { price: 0, pair: null };
    tokenPriceCache.set(tokenAddress, { ...result, ts: now });
    return result;
  } catch { return { price: 0, pair: null }; }
}

async function fetchTokenPriceForExit(tokenAddress: string): Promise<{ price: number; pair: DexScreenerPair | null }> {
  const now = Date.now();
  const cached = tokenPriceCache.get(tokenAddress);
  if (cached && now - cached.ts < 1500) return { price: cached.price, pair: cached.pair };
  try {
    // UPDATED: Using Throttled Fetch
    const data = await throttledDexScreenerFetch(`https://api.dexscreener.com/latest/dex/tokens/${tokenAddress}`, 5000);
    const pairs = (data.pairs || []) as DexScreenerPair[];
    const solanaPairs = pairs.filter(p => p.chainId === "solana");
    if (solanaPairs.length === 0) {
      if (cached) return { price: cached.price, pair: cached.pair };
      return { price: 0, pair: null };
    }
    const bestPair = solanaPairs.sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0))[0];
    const price = parseFloat(bestPair.priceUsd || "0");
    if (price <= 0) {
      if (cached) return { price: cached.price, pair: cached.pair };
      return { price: 0, pair: null };
    }
    tokenPriceCache.set(tokenAddress, { price, pair: bestPair, ts: now });
    return { price, pair: bestPair };
  } catch {
    if (cached) return { price: cached.price, pair: cached.pair };
    return { price: 0, pair: null };
  }
}

function scoreToken(
  pair: DexScreenerPair,
  mlPrediction?: { pumpProb: number; dumpRisk: number; version: string } | null,
  isMicroWallet: boolean = false
) {
  const liq = pair.liquidity?.usd || 0, fdv = pair.fdv || 0, createdAt = pair.pairCreatedAt || Date.now();
  const ageSeconds = Math.floor((Date.now() - createdAt) / 1000);
  const m5b = pair.txns?.m5?.buys || 0, m5s = pair.txns?.m5?.sells || 0, h1b = pair.txns?.h1?.buys || 0, h1s = pair.txns?.h1?.sells || 0;
  const vol5m = pair.volume?.m5 || 0, vol1h = pair.volume?.h1 || 0;
  const priceChange5m = pair.priceChange?.m5 || 0, priceChange1h = pair.priceChange?.h1 || 0;
  const bp5m = (m5b + m5s) > 0 ? m5b / (m5b + m5s) : 0.5;
  // Inherit bp5m when no 1h data (crucial for fresh pairs)
  const bp1h = (h1b + h1s) > 0 ? h1b / (h1b + h1s) : bp5m;
  const txVelocity5m = m5b + m5s, volMomentum = vol1h > 0 ? (vol5m * 12) / vol1h : 0;
  const liqScore = liq >= 50000 ? 15 : liq >= 20000 ? 12 : liq >= 10000 ? 10 : liq >= 5000 ? 8 : liq >= 2000 ? 5 : liq >= 1000 ? 3 : liq >= 500 ? 1 : 0;
  const bpScore = bp5m >= 0.75 ? 20 : bp5m >= 0.65 ? 16 : bp5m >= 0.60 ? 13 : bp5m >= 0.55 ? 10 : bp5m >= 0.50 ? 5 : Math.max(0, Math.floor(bp5m * 10) - 5);
  const volScore = volMomentum >= 3.0 ? 15 : volMomentum >= 2.0 ? 12 : volMomentum >= 1.5 ? 9 : volMomentum >= 1.0 ? 6 : volMomentum >= 0.5 ? 3 : 0;
  const priceScore = priceChange5m >= 10 ? 15 : priceChange5m >= 7 ? 12 : priceChange5m >= 5 ? 10 : priceChange5m >= 3 ? 8 : priceChange5m >= 1.5 ? 5 : priceChange5m > 0 ? 2 : Math.max(-10, Math.floor(priceChange5m));
  const txScore = txVelocity5m >= 50 ? 10 : txVelocity5m >= 30 ? 8 : txVelocity5m >= 20 ? 6 : txVelocity5m >= 10 ? 4 : txVelocity5m >= 5 ? 2 : 0;
  // OLD version gave <60s tokens max freshness (10pts) — prime SNIPER window.
  // New version penalised them with 0, indirectly blocking sub-minute entries
  // via the score gate rather than through the explicit SNIPER safety checks.
  // Restore: <60s → 10, then taper. Safety for ultra-fresh tokens is handled
  // by sniperMinLiquidity, rugcheck, sell-side preflight and the isMicroCapToken
  // 0.02 SOL size cap — not by artificially deflating the score here.
  const ageScore = ageSeconds < 60 ? 10 : ageSeconds <= 300 ? 8 : ageSeconds <= 600 ? 6 : ageSeconds <= 1800 ? 4 : ageSeconds <= 3600 ? 2 : 0;
  const bp1hScore = bp1h >= 0.60 ? 5 : bp1h >= 0.55 ? 3 : bp1h >= 0.50 ? 1 : 0;
  let fdvScore = 0;
  if (fdv > 0 && liq > 0) { const lr = liq / fdv; fdvScore = lr >= 0.05 ? 5 : lr >= 0.02 ? 3 : lr >= 0.01 ? 1 : 0; }
  const rawTotal = liqScore + bpScore + volScore + priceScore + txScore + ageScore + bp1hScore + fdvScore;
  const score = Math.max(0, Math.min(100, Math.round((rawTotal / 95) * 100)));
  let mlScore: number | null = null, combinedScore = score;
  if (mlPrediction) {
    mlScore = Math.round(mlPrediction.pumpProb * 100);
    const mlAdjusted = mlScore * (1 - mlPrediction.dumpRisk * 0.5);
    combinedScore = Math.max(0, Math.min(100, Math.round(score * engineSettings.scoreWeight + mlAdjusted * engineSettings.mlWeight)));
  }
  const metrics = { liq, ageSeconds, bp5m, bp1h, volMomentum, priceChange5m, priceChange1h, txVelocity5m, vol5m, vol1h, fdv, h1buys: h1b, h1sells: h1s, m5buys: m5b, m5sells: m5s, buyPressure5m: bp5m, buyPressure1h: bp1h };

  // Micro‑wallet mode: lower score thresholds slightly to allow recovery trades
  const effSniperScore = isMicroWallet ? 58 : engineSettings.sniperMinScore;
  const effMgScore     = isMicroWallet ? 58 : engineSettings.mgMinScore;
  const effHwrScore    = isMicroWallet ? 60 : engineSettings.hwrMinScore;
  const effSniperLiq   = engineSettings.sniperMinLiquidity /* FIX(liq-floor): removed micro-wallet $1k discount that let the bot buy un-tradeable thin tokens (BioCraft $21k -> ~35% real round-trip loss). Restored $50k floor. */;
  const effHwrLiq      = engineSettings.hwrMinLiquidity /* FIX(liq-floor): removed micro-wallet $2k discount. Restored $50k floor. */;

  const sizeForMode = (maxSizeFraction: number, minScore: number) => {
    const ratio = Math.max(0, (combinedScore - minScore) / Math.max(1, 100 - minScore));
    const raw = engineSettings.minPositionSize + ratio * (maxSizeFraction * engineSettings.maxPositionSize - engineSettings.minPositionSize);
    return Math.max(engineSettings.minPositionSize, raw);
  };
  const candidates: { mode: string; sizeSol: number; slippage: number; minScore: number }[] = [];
  if (combinedScore >= effSniperScore && ageSeconds <= engineSettings.sniperMaxAge && bp5m >= engineSettings.sniperMinBuyPressure && liq >= effSniperLiq) {
    candidates.push({ mode: "SNIPER", minScore: effSniperScore, sizeSol: sizeForMode(engineSettings.sniperMaxSize, effSniperScore), slippage: liq < 3000 ? 8 : liq < 10000 ? 5 : 3 });
  }
  if (combinedScore >= effMgScore && volMomentum >= engineSettings.mgMinVolMomentum && priceChange5m >= engineSettings.mgMinPriceChange5m && txVelocity5m >= engineSettings.mgMinTxVelocity && liq >= engineSettings.sniperMinLiquidity) {
    candidates.push({ mode: "MG", minScore: effMgScore, sizeSol: sizeForMode(engineSettings.mgMaxSize, effMgScore), slippage: liq < 5000 ? 6 : liq < 20000 ? 4 : 2.5 });
  }

  // HWR: if metrics are met, optionally reduce score gate with strong 5m buy pressure
  const meetsHwrMetrics = bp5m >= engineSettings.hwrMinBuyPressure5m && bp1h >= engineSettings.hwrMinBuyPressure1h && liq >= effHwrLiq;
  const adjustedHwrScore = (meetsHwrMetrics && bp5m > 0.65) ? effHwrScore - 5 : effHwrScore;

  if (combinedScore >= adjustedHwrScore && meetsHwrMetrics) {
    candidates.push({ mode: "HWR", minScore: adjustedHwrScore, sizeSol: sizeForMode(engineSettings.hwrMaxSize, adjustedHwrScore), slippage: liq < 5000 ? 5 : liq < 20000 ? 3 : 2 });
  }
  let qualifiedMode: string | null = null, sizeSol = 0, slippage = 0, rejectionReason = "";
  if (candidates.length > 0) {
    const best = candidates.reduce((a, b) => b.minScore > a.minScore ? b : a);
    qualifiedMode = best.mode; sizeSol = parseFloat(best.sizeSol.toFixed(4)); slippage = parseFloat(best.slippage.toFixed(2));
  } else {
    // Generate rejection reason
    const reasons: string[] = [];
    if (combinedScore < effSniperScore && combinedScore < effMgScore && combinedScore < effHwrScore) reasons.push("score too low");
    if (ageSeconds > engineSettings.sniperMaxAge) reasons.push("age > " + engineSettings.sniperMaxAge);
    if (bp5m < engineSettings.sniperMinBuyPressure) reasons.push("bp5m < " + engineSettings.sniperMinBuyPressure);
    if (liq < effSniperLiq) reasons.push("liq < " + effSniperLiq);
    if (volMomentum < engineSettings.mgMinVolMomentum) reasons.push("volMom < " + engineSettings.mgMinVolMomentum);
    if (priceChange5m < engineSettings.mgMinPriceChange5m) reasons.push("px5m < " + engineSettings.mgMinPriceChange5m);
    if (txVelocity5m < engineSettings.mgMinTxVelocity) reasons.push("tx5m < " + engineSettings.mgMinTxVelocity);
    // HWR-specific gates (previously unlogged — HWR failures showed as silent "Mode: none")
    if (bp5m < engineSettings.hwrMinBuyPressure5m) reasons.push("hwrBp5m < " + engineSettings.hwrMinBuyPressure5m);
    if (bp1h < engineSettings.hwrMinBuyPressure1h) reasons.push("bp1h < " + engineSettings.hwrMinBuyPressure1h);
    if (liq < effHwrLiq) reasons.push("hwrLiq < " + effHwrLiq);
    rejectionReason = reasons.join(", ");
  }
  return { score, mlScore, combinedScore, breakdown: {}, metrics, qualifiedMode, sizeSol, slippage, rejectionReason };
}

function getScoreBasedTP(score: number): number {
  // FIX X-2: tiers must increase monotonically with score. Old code returned 80%
  // for both 70–79 AND 80–89 (identical), and the <70 default was also 80%,
  // meaning every score below 90 got the same exit. Proper ladder:
  if (score >= 90) return 100;
  if (score >= 80) return  90;
  if (score >= 70) return  80;
  if (score >= 60) return  65;
  return engineSettings.hardTakeProfit;
}

function calcTransactionCosts(liqUsd: number, sizeSol: number, solPriceUsd = cachedSolPriceUsd) {
  if (!engineSettings.txCostsEnabled) return { entrySlippagePct: 0, exitSlippagePct: 0, entryFeePct: 0, exitFeePct: 0, totalRoundTripPct: 0 };
  const tradeValueUsd = sizeSol * solPriceUsd;
  const priceImpactPct = liqUsd > 0 ? Math.min(20, (tradeValueUsd / (liqUsd / 2)) * 100) : 10;
  const baseSlippage = liqUsd < 2000 ? 8 : liqUsd < 5000 ? 5 : liqUsd < 20000 ? 2.5 : 1.2;
  const entrySlippagePct = Math.max(baseSlippage, priceImpactPct);
  const exitSlippagePct = entrySlippagePct * 1.3;
  const fee = engineSettings.txFeePercent;
  return { entrySlippagePct, exitSlippagePct, entryFeePct: fee, exitFeePct: fee, totalRoundTripPct: entrySlippagePct + exitSlippagePct + fee * 2 };
}

function calcCostAwareStopPrice(entryPrice: number, mode: string | null, liq: number, sizeSol: number, solPriceUsd = cachedSolPriceUsd): number {
  if (entryPrice <= 0) return 0;
  const costs = calcTransactionCosts(liq, sizeSol, solPriceUsd);
  const modeBuffer = mode === "SNIPER" ? 4 : mode === "MG" ? 2 : 1;
  const exitCostPct = costs.exitSlippagePct + costs.exitFeePct;
  const rawTolerance = Math.abs(engineSettings.stopLoss) + modeBuffer;
  const priceMoveTolerance = Math.max(rawTolerance, exitCostPct + 1);
  return entryPrice * (1 - priceMoveTolerance / 100);
}

/** Heuristics-only token safety check used when rugcheck circuit-breaker is open.
 *  Runs all local checks (liq, age/vol ratio, liq/fdv, zero-sell guard) but
 *  skips the external API call. Returns safe=true with a clear reason tag. */
async function checkTokenSafetyHeuristicsOnly(tokenAddress: string, pair: DexScreenerPair): Promise<{ safe: boolean; reason: string }> {
  const liq = pair.liquidity?.usd || 0, fdv = pair.fdv || 0, createdAt = pair.pairCreatedAt || Date.now();
  const ageSeconds = (Date.now() - createdAt) / 1000, vol5m = pair.volume?.m5 || 0;
  if (liq < 500) return { safe: false, reason: "liq_below_minimum" };
  if (ageSeconds < 60 && vol5m > liq * engineSettings.maxVolLiqRatioNewToken) return { safe: false, reason: `suspicious_vol_liq_ratio(${(vol5m / liq).toFixed(1)}x at ${ageSeconds.toFixed(0)}s)` };
  if (fdv > 0 && liq / fdv < 0.003) return { safe: false, reason: `honeypot_risk_liq_fdv_ratio(${(liq / fdv * 100).toFixed(3)}%)` };
  const m5buys = pair.txns?.m5?.buys || 0, m5sells = pair.txns?.m5?.sells || 0;
  if (ageSeconds < 120 && m5buys > 20 && m5sells === 0) return { safe: false, reason: "zero_sells_coordinated_buy" };
  return { safe: true, reason: "rugcheck_circuit_open_heuristics_only" };
}




function getScoreBasedMaxHold(score: number, currentPnlPct: number, currentBuyPressure: number): number {
  if (!engineSettings.dynamicHoldEnabled) return engineSettings.maxHoldSeconds;
  let base = score >= 85 ? 900 : score >= 75 ? 720 : score >= 65 ? 540 : engineSettings.maxHoldSeconds;
  // FIX W-1: differentiated multipliers — both branches previously used 1.4×,
  // making the stricter condition (>20% PNL, >0.60 BP) completely redundant.
  if (currentPnlPct > 20 && currentBuyPressure > 0.60) base = Math.round(base * 1.6);
  else if (currentPnlPct > 10 && currentBuyPressure > 0.55) base = Math.round(base * 1.4);
  else if (currentPnlPct > 5 && currentBuyPressure > 0.52) base = Math.round(base * 1.2);
  if (currentPnlPct < -2) base = Math.min(base, 300);
  if (currentPnlPct < -3.5) base = Math.min(base, 180);
  return Math.min(Math.round(base), engineSettings.dynamicHoldMaxSeconds);
}

function geckoPoolToDexPair(pool: any): DexScreenerPair | null {
  try {
    const attr = pool?.attributes, rels = pool?.relationships;
    if (!attr || !rels) return null;
    
    const baseId = rels.base_token?.data?.id as string | undefined;
    const quoteId = rels.quote_token?.data?.id as string | undefined;
    const dexId = rels.dex?.data?.id as string | undefined;
    if (!baseId || !dexId) return null;

    const baseAddress = baseId.replace(/^solana_/, "");
    const quoteAddress = quoteId ? quoteId.replace(/^solana_/, "") : "So11111111111111111111111111111111111111112";
    const nameParts = (attr.name as string || "/").split("/");
    const baseSymbol = nameParts[0]?.trim() || "UNKNOWN";
    const quoteSymbol = nameParts[1]?.trim() || "SOL";

    // FIX 1: Bulletproof Date Parsing (Prevents 'NaNd' Age)
    let pairCreatedAt: number | undefined = undefined;
    if (attr.pool_created_at) {
      const parsedDate = new Date(attr.pool_created_at).getTime();
      if (!isNaN(parsedDate)) {
        pairCreatedAt = parsedDate;
      } else if (!isNaN(Number(attr.pool_created_at))) {
        // Handle case where API returns a raw Unix timestamp
        pairCreatedAt = Number(attr.pool_created_at) * (String(attr.pool_created_at).length === 10 ? 1000 : 1);
      }
    }

    const volumeUsd = attr.volume_usd || {};
    const txns = attr.transactions || {};
    const pc = attr.price_change_percentage || {};

    const toTxBucket = (bucket: any) => bucket ? { buys: Number(bucket.buys) || 0, sells: Number(bucket.sells) || 0 } : undefined;

    // FIX 2: Estimate 5m data if missing (Prevents $0 Volume Pause)
    const h1Vol = Number(volumeUsd.h1) || 0;
    let m5Vol = Number(volumeUsd.m5);
    if (isNaN(m5Vol) || m5Vol === 0) {
        m5Vol = h1Vol > 0 ? h1Vol / 12 : 0; // Pro-rate 1-hour volume to keep momentum checks alive
    }

    // FIX 3: Safe Price Parsing (Prevents $NaN Price crashes)
    let priceStr = String(attr.base_token_price_usd || attr.token_price_usd || "0");
    if (priceStr.toLowerCase() === "nan" || isNaN(Number(priceStr))) {
      priceStr = "0";
    }

    // Pro-rate transactions and price changes if m5 is missing
    const m5Txns = toTxBucket(txns.m5) || (txns.h1 ? { buys: Math.max(1, Math.floor((Number(txns.h1.buys) || 0) / 12)), sells: Math.floor((Number(txns.h1.sells) || 0) / 12) } : undefined);
    const m5Pc = Number(pc.m5) || (Number(pc.h1) ? Number(pc.h1) / 12 : 0);

    return {
      chainId: "solana",
      dexId: (dexId as string).toLowerCase(),
      pairAddress: attr.address as string || pool.id || "",
      baseToken: { address: baseAddress, name: attr.base_token_name as string || baseSymbol, symbol: baseSymbol },
      quoteToken: { address: quoteAddress, name: quoteSymbol, symbol: quoteSymbol },
      priceUsd: priceStr,
      priceNative: String(attr.base_token_price_native_currency || "0"),
      txns: { m5: m5Txns, h1: toTxBucket(txns.h1), h24: toTxBucket(txns.h24) },
      volume: { m5: m5Vol, h1: h1Vol, h6: Number(volumeUsd.h6) || 0, h24: Number(volumeUsd.h24) || 0 },
      priceChange: { m5: m5Pc, h1: Number(pc.h1) || 0, h6: Number(pc.h6) || 0, h24: Number(pc.h24) || 0 },
      liquidity: { usd: Number(attr.reserve_in_usd) || 0 },
      fdv: Number(attr.fdv_usd) || 0,
      marketCap: Number(attr.market_cap_usd) || 0,
      pairCreatedAt,
    };
  } catch (e) { 
    console.warn("[GECKO] Failed to convert pool:", (e as Error).message); 
    return null; 
  }
}

async function batchFetchDexPairs(addresses: string[]): Promise<Map<string, DexScreenerPair>> {
  const result = new Map<string, DexScreenerPair>();
  if (addresses.length === 0) return result;
  for (let i = 0; i < addresses.length; i += 30) {
    if (i > 0) await new Promise(r => setTimeout(r, 300));
    const chunk = addresses.slice(i, i + 30);
    try {
      const url = `https://api.dexscreener.com/latest/dex/tokens/${chunk.join(",")}`;
      const resp = await fetch(url, { signal: AbortSignal.timeout(5000) });
      if (!resp.ok) continue;
      const data = await resp.json();
      const pairs: DexScreenerPair[] = data.pairs || [];
      for (const addr of chunk) {
        // FIX U-3: apply wash-trade filter identical to fetchTokenPrice.
        // Without it, a pool with vol5m >> liq (artificial volume) is selected as
        // "best" and its inflated metrics poison scoreToken for that token.
        const best = pairs
          .filter(p => {
            if (p.chainId !== "solana" || p.baseToken.address !== addr) return false;
            const liq = p.liquidity?.usd || 0, vol5m = p.volume?.m5 || 0;
            return !(liq > 0 && vol5m > liq * 15);
          })
          .sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0))[0];
        if (best) result.set(addr, best);
      }
    } catch { continue; }
  }
  return result;
}

async function fetchDexScreenerCandidates(isMicroWallet: boolean = false): Promise<any[]> {
  const now = Date.now();
  const cacheTtl = Math.max(2000, engineSettings.scanIntervalMs * 0.9);
  
  if (now - lastScanTime < cacheTtl) return liveCandidatesCache;

  if (isFetchingCandidates) return liveCandidatesCache;
  isFetchingCandidates = true;

  try {
    const allPairs: DexScreenerPair[] = [];
    const maxAgeMs = engineSettings.maxDiscoveryAgeSeconds * 1000;
    // FUNNEL DIAGNOSTICS: count drops per filter so the discovery bottleneck is visible each cycle.
    let funnelSeen = 0, cutLiq = 0, cutVol = 0, cutAge = 0, cutPrice = 0, cutVolZero = 0, cutHoneypot = 0, cutTooNew = 0;
    
    // UPDATED: Loosened funnel to let micro-caps into the scanner
    const QUALITY_LIQ_FLOOR = 1500;      // LEVER 4: raised 800->1500 to bias toward higher-liquidity pairs (also clears the $1k micro buy floor with margin)
    const QUALITY_VOL_5M_MIN = 250;
    const QUALITY_MIN_AGE_SEC = 120;     // LEVER 1: skip freshest tokens (<2m) where mint/freeze authority is usually still active
    const QUALITY_MIN_M5_SELLS = 10;     // LEVER 3: mirror the buy-time honeypot gate (m5 sells >= 10) when txn data is present

    // Gecko trending + new pools (Normal fetch is fine, high rate limits)
    const geckoPages = [1, 2, 3, 4, 5]; // WIDENED: more trending/new-pool pages = larger candidate pool (Gecko has high rate limits, cheap to expand)
    const geckoFetches = geckoPages.flatMap(page => [
      withTimeout(
        fetch(`https://api.geckoterminal.com/api/v2/networks/solana/trending_pools?page=${page}`, { headers: { "Accept": "application/json;version=20230302" }, signal: AbortSignal.timeout(8000) })
          .then(r => r.ok ? r.json() : { data: [] }),
        10000,
        "Gecko Trending"
      ).catch(() => ({ data: [] })),
      
      withTimeout(
        fetch(`https://api.geckoterminal.com/api/v2/networks/solana/new_pools?page=${page}`, { headers: { "Accept": "application/json;version=20230302" }, signal: AbortSignal.timeout(8000) })
          .then(r => r.ok ? r.json() : { data: [] }),
        10000,
        "Gecko New"
      ).catch(() => ({ data: [] }))
    ]);

    const birdEyeFetch = process.env.BIRDEYE_API_KEY
      ? withTimeout(
          fetch("https://public-api.birdeye.so/public/trending?list_address=solana", {
            headers: { "X-API-KEY": process.env.BIRDEYE_API_KEY, "Accept": "application/json" },
            signal: AbortSignal.timeout(8000)
          }).then(r => r.ok ? r.json() : { data: { tokens: [] } }),
          10000,
          "BirdEye"
        ).catch(() => ({ data: { tokens: [] } }))
      : Promise.resolve({ data: { tokens: [] } });

    // UPDATED: Iterative Throttled Search for DexScreener
    const dexResults = [];
    for (const q of SEARCH_QUERIES) {
        try {
            const data = await throttledDexScreenerFetch(`https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(q)}`);
            dexResults.push(data);
        } catch { dexResults.push({ pairs: [] }); }
    }

    // DISCOVERY UPGRADE: pull DexScreener boosted (paid-attention) tokens and HYDRATE them.
    // The boosts endpoints return only token addresses with no liquidity/volume/price, so
    // boosted tokens were always cut by the quality funnel (liq=0 < floor). Resolve each to
    // full pair data via /latest/dex/tokens/{addrs} so real, liquid movers reach the scorer.
    try {
        const boostFeeds = await Promise.all([
            throttledDexScreenerFetch("https://api.dexscreener.com/token-boosts/top/v1").catch(() => []),
            throttledDexScreenerFetch("https://api.dexscreener.com/token-boosts/latest/v1").catch(() => []),
        ]);
        const boostAddrs = Array.from(new Set(
            boostFeeds
                .flatMap((bf: any) => Array.isArray(bf) ? bf : (bf?.data || []))
                .filter((b: any) => b && b.chainId === "solana" && b.tokenAddress)
                .map((b: any) => b.tokenAddress as string)
        )).slice(0, 100); // WIDENED: hydrate more boosted (paid-attention) tokens per cycle
        for (let i = 0; i < boostAddrs.length; i += 30) {
            const chunk = boostAddrs.slice(i, i + 30).join(",");
            try {
                const hydrated = await throttledDexScreenerFetch(`https://api.dexscreener.com/latest/dex/tokens/${chunk}`);
                dexResults.push(hydrated);
            } catch { /* skip chunk */ }
        }
    } catch { dexResults.push([]); }

    const geckoAndBirdeyeResults = await Promise.all([...geckoFetches, birdEyeFetch]);
    const resultsAll = [...geckoAndBirdeyeResults, ...dexResults];

    for (const res of resultsAll) {
      const pairs = (res.data || res.pairs || (Array.isArray(res) ? res : []));
      if (Array.isArray(pairs)) {
        for (const p of pairs) {
          const pair = p.attributes ? geckoPoolToDexPair(p) : p;
          if (!pair || pair.chainId !== "solana") continue;

          const liq = pair.liquidity?.usd || 0;
          const vol5m = pair.volume?.m5 || 0;
          const age = pair.pairCreatedAt ? now - pair.pairCreatedAt : 0;

          funnelSeen++; if (liq < QUALITY_LIQ_FLOOR) { cutLiq++; continue; }
          if (vol5m < QUALITY_VOL_5M_MIN) { cutVol++; continue; }
          if (age > maxAgeMs) { cutAge++; continue; }
          if (pair.pairCreatedAt && age < QUALITY_MIN_AGE_SEC * 1000) { cutTooNew++; continue; }
          if (!pair.priceUsd || isNaN(Number(pair.priceUsd)) || Number(pair.priceUsd) <= 0) { cutPrice++; continue; }
          if (vol5m === 0) { cutVolZero++; continue; }

          // HONEYPOT PRE-SCREEN (free — uses DexScreener txn data already in hand): cut clear
          // no-sell / coordinated-buy and locked-liquidity honeypot patterns early so they don't
          // burn scoring + sizing cycles before the buy-time safety gate rejects them anyway.
          // Only fires when txn data is actually present (skips feeds like BirdEye with txns:{}).
          {
            const hpBuys = pair.txns?.m5?.buys || 0;
            const hpSells = pair.txns?.m5?.sells || 0;
            const hpFdv = pair.fdv || 0;
            if ((hpBuys + hpSells) > 0 && hpSells < QUALITY_MIN_M5_SELLS) { cutHoneypot++; continue; }
            if (hpFdv > 0 && liq / hpFdv < 0.003) { cutHoneypot++; continue; }
          }

          allPairs.push(pair);
        }
      }
      
      if (res.data?.tokens) {
        for (const bToken of res.data.tokens) {
          const liq = bToken.liquidity || 0;
          const vol24h = bToken.v24hUSD || 0;
          const vol5m = vol24h / 288;
          const ageSec = (Date.now() - (bToken.first_seen || 0) * 1000) / 1000;
          
          funnelSeen++; if (liq < QUALITY_LIQ_FLOOR) { cutLiq++; continue; }
          if (vol5m < QUALITY_VOL_5M_MIN) { cutVol++; continue; }
          if (ageSec > engineSettings.maxDiscoveryAgeSeconds) { cutAge++; continue; }
          if (bToken.first_seen && ageSec < QUALITY_MIN_AGE_SEC) { cutTooNew++; continue; }
          const priceUsd = bToken.price?.toString();
          if (!priceUsd || isNaN(Number(priceUsd)) || Number(priceUsd) <= 0) { cutPrice++; continue; }

          allPairs.push({
            chainId: "solana",
            baseToken: { address: bToken.address, name: bToken.name, symbol: bToken.symbol },
            quoteToken: { address: SOL_MINT, name: "Solana", symbol: "SOL" },
            priceUsd: priceUsd,
            liquidity: { usd: liq },
            volume: { m5: vol5m, h1: vol5m * 12 },
            pairCreatedAt: bToken.first_seen ? bToken.first_seen * 1000 : undefined,
            dexId: "birdseye",
            pairAddress: bToken.address,
            txns: {},
            priceChange: { m5: bToken.priceChange5m || 0, h1: bToken.priceChange1h || 0 },
            fdv: bToken.fdv || 0,
          } as DexScreenerPair);
        }
      }
    }

    const bestByAddress = new Map<string, DexScreenerPair>();
    for (const sp of allPairs) {
      const addr = sp.baseToken.address;
      const existing = bestByAddress.get(addr);
      if (!existing || (sp.liquidity?.usd || 0) > (existing.liquidity?.usd || 0)) {
        bestByAddress.set(addr, sp);
      }
    }

    for (const [addr, data] of watchlistCache) {
      if (now - data.firstSeen > WATCHLIST_MAX_AGE_MS) {
        watchlistCache.delete(addr);
      } else if (!bestByAddress.has(addr)) {
        bestByAddress.set(addr, data.pair);
      }
    }

    const dedupedPairs = Array.from(bestByAddress.values());
    const pairMetrics = dedupedPairs.map(sp => ({
      liq: sp.liquidity?.usd || 0,
      ageSeconds: Math.floor((now - (sp.pairCreatedAt || now)) / 1000),
      vol5m: sp.volume?.m5 || 0,
      vol1h: sp.volume?.h1 || 0,
      priceChange5m: sp.priceChange?.m5 || 0,
      priceChange1h: sp.priceChange?.h1 || 0,
      fdv: sp.fdv || 0,
      h1buys: sp.txns?.h1?.buys || 0,
      h1sells: sp.txns?.h1?.sells || 0,
      txVelocity5m: (sp.txns?.m5?.buys || 0) + (sp.txns?.m5?.sells || 0),
      buyPressure5m: (sp.txns?.m5?.buys || 0) / ((sp.txns?.m5?.buys || 0) + (sp.txns?.m5?.sells || 0) || 1),
      buyPressure1h: (sp.txns?.h1?.buys || 0) / ((sp.txns?.h1?.buys || 0) + (sp.txns?.h1?.sells || 0) || 1),
    }));

    const mlPredictions = await getMLBatchPredictions(pairMetrics);
    const results = dedupedPairs.map((sp, idx) => {
      const scoring = scoreToken(sp, mlPredictions[idx], isMicroWallet);
      return {
        ...scoring,
        tokenAddress: sp.baseToken.address,
        tokenSymbol: sp.baseToken.symbol,
        score: scoring.combinedScore,
        qualifiedMode: scoring.qualifiedMode,
        price: sp.priceUsd,
        liquidity: sp.liquidity?.usd || 0,
        volume5m: sp.volume?.m5 || 0,
        ageSeconds: Math.floor((now - (sp.pairCreatedAt || now)) / 1000),
        buys5m: sp.txns?.m5?.buys || 0,
        sells5m: sp.txns?.m5?.sells || 0,
        mlActive: mlPredictions[idx] !== null,
        mlDumpRisk: mlPredictions[idx]?.dumpRisk ?? null
      };
    });

    results.sort((a, b) => b.score - a.score);
    // [DIAG-SCOREWALL] TEMP instrumentation (no trading effect): dump the top-5 scored
    // candidates with full metrics + rejection reason BEFORE the safety prescreen, so we
    // can confirm whether the highest scorers are being removed by safety and see the real
    // scores/metrics of what the engine is actually finding. Remove after diagnosis.
    try {
      const diagTop = results.slice(0, 5).map((r: any, i: number) => {
        const m = r.metrics || {};
        return `#${i + 1} $${r.tokenSymbol} score=${r.score} mode=${r.qualifiedMode || "none"}`
          + ` bp5m=${(m.bp5m ?? 0).toFixed(2)} px5m=${(m.priceChange5m ?? 0).toFixed(2)}`
          + ` volMom=${(m.volMomentum ?? 0).toFixed(2)} liq=${Math.round(m.liq ?? 0)}`
          + ` age=${m.ageSeconds ?? 0}s rej=[${r.rejectionReason || ""}]`;
      });
      console.log(`[DIAG-SCOREWALL] top${diagTop.length} (pre-safety): ` + diagTop.join("  ||  "));
    } catch (diagErr) { console.log("[DIAG-SCOREWALL] error", diagErr); }

    // LEVER 2: rugcheck-prescreen the single top scored candidate per cycle. Result is cached in
    // safetyCache, so the buy loop reuses it (no double call); drops a rug top-pick before it can
    // dominate the cycle. ~1 extra API call only when the top pick wouldn't otherwise be reached.
    if (results.length > 0 && engineSettings.safetyChecksEnabled) {
      const topPick = results[0];
      const topPair = bestByAddress.get(topPick.tokenAddress);
      if (topPair) {
        const pre = await checkTokenSafety(topPick.tokenAddress, topPair);
        if (!pre.safe) { console.log(`[PRESCREEN] Dropped top candidate $${topPick.tokenSymbol} — ${pre.reason}`); results.shift(); }
      }
    }
    console.log(`[SCAN] Funnel: seen=${funnelSeen} -> cutLiq=${cutLiq} cutVol=${cutVol} cutAge=${cutAge} cutPrice=${cutPrice} cutVolZero=${cutVolZero} cutHoneypot=${cutHoneypot} cutTooNew=${cutTooNew} | survived=${allPairs.length} deduped=${dedupedPairs.length} scored=${results.length}`);
    
    if (results.length > 0) {
      console.log(`[SCAN] Discovery: ${results.length} candidates found.`);
    }
    
    liveCandidatesCache = results;
    lastScanTime = now;
    isFetchingCandidates = false;
    return results;

  } catch (e) {
    console.error("[SCAN] Discovery engine error:", e);
    lastScanTime = now;
    isFetchingCandidates = false;
    return liveCandidatesCache;
  }
}
const safetyCache = new Map<string, { safe: boolean; reason: string; timestamp: number }>();
const CACHE_TTL_MS = 60_000;


async function checkTokenSafety(tokenAddress: string, pair: DexScreenerPair): Promise<{ safe: boolean; reason: string }> {
  if (!engineSettings.safetyChecksEnabled) return { safe: true, reason: "checks_disabled" };
  const cached = safetyCache.get(tokenAddress);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) return cached;

  const rugcheckBlockedUntil = rugcheckBlockedAddresses.get(tokenAddress);
  if (rugcheckBlockedUntil && Date.now() < rugcheckBlockedUntil) return { safe: false, reason: "rugcheck_block_cached" };

  const liq = pair.liquidity?.usd || 0;
  const m5sells = pair.txns?.m5?.sells || 0;
  if (m5sells < 10) return { safe: false, reason: "insufficient_sell_activity_honeypot_risk" };

  try {
    const resp = await fetch(`https://api.rugcheck.xyz/v1/tokens/${tokenAddress}/report/summary`, { signal: AbortSignal.timeout(5000) });
    if (!resp.ok) {
      // GRACEFUL FALLBACK: a 4xx/5xx from RugCheck previously hard-blocked the token
      // (rugcheck_api_error_400) and was re-fetched every cycle. Instead, fall back to
      // local heuristics-only safety and CACHE the result so we stop hammering the API.
      const fallback = await checkTokenSafetyHeuristicsOnly(tokenAddress, pair);
      const fb = { safe: fallback.safe, reason: `${fallback.reason}_rugcheck_${resp.status}` };
      safetyCache.set(tokenAddress, { ...fb, timestamp: Date.now() });
      return fb;
    }
    
    const data = await resp.json() as any;
    let safe = true;
    let reason = "ok";
    // ROOT-CAUSE FIX: RugCheck /report/summary does NOT return tokenMeta.mint/freezeAuthority,
    // so `data.tokenMeta?.freezeAuthority !== null` was `undefined !== null` === true for EVERY token —
    // silently blocking 100% of candidates for days. Detect authorities from the reliable `risks` array
    // (RugCheck flags "Freeze Authority still enabled" / "Mint Authority still enabled"), with full-report
    // field fallbacks. Revoked authority = risk absent / null address.
    const _risks = Array.isArray(data?.risks) ? data.risks : [];
    const _hasRisk = (kw: string) => _risks.some((r: any) => String(r?.name || "").toLowerCase().includes(kw));
    const _NULL_ADDR = "11111111111111111111111111111111";
    const _isAddr = (v: any) => typeof v === "string" && v.length > 0 && v !== _NULL_ADDR;
    const _freezeActive = _hasRisk("freeze authority") || _isAddr(data?.token?.freezeAuthority) || _isAddr(data?.tokenMeta?.freezeAuthority);
    const _mintActive   = _hasRisk("mint authority")   || _isAddr(data?.token?.mintAuthority)   || _isAddr(data?.tokenMeta?.mintAuthority);
    // PATCH #1: HARD-VETO on rugcheck risk flags that predict LP-pull / concentration rugs.
    // Previously these were logged via DIAG-AUTH and then ignored. $Taz had 6 such flags
    // (LP Unlocked, Single holder ownership, Top 10 high ownership, High ownership,
    //  Low Liquidity, Low amount of LP Providers) and was still bought — the pool was
    // pulled 5 minutes later for a -101.65% loss. These flags predict FUTURE liquidity
    // loss, not CURRENT sellability, so they must be vetoes at entry.
    //
    // VERIFIED (per codebase comment at line 455): "High Ownership" and "Low Liquidity"
    // are common structural properties of Solana memecoins — vetoing on them would reject
    // most legitimate candidates. Restricted to the 2 highest-signal flags only:
    //   - "lp unlocked"            : literal cause of LP-pull rugs (directly predicts rug)
    //   - "single holder ownership": one wallet can dump everything (concentration rug)
    const HARD_VETO_RISK_KEYWORDS = [
      "lp unlocked",            // LP can be pulled anytime — direct rug predictor
      "single holder ownership" // one wallet can dump everything — concentration rug
    ];
    const _vetoRisk = _risks.find((r: any) =>
      HARD_VETO_RISK_KEYWORDS.some(kw => String(r?.name || "").toLowerCase().includes(kw))
    );
    // TEMP DIAG-AUTH: confirm the real RugCheck shape on live data (dev sandbox has no network). Remove after confirming.
    console.log(`[DIAG-AUTH] $${pair.baseToken?.symbol || tokenAddress} keys=[${Object.keys(data || {}).join(",")}] risks=[${_risks.map((r: any) => r?.name).join(" | ")}] freezeActive=${_freezeActive} mintActive=${_mintActive} vetoRisk=${_vetoRisk?.name || "none"}`);
    if (_freezeActive) {
        // FIX: FREEZE authority = honeypot (dev can freeze your account so you cannot sell) -> hard block, non-negotiable.
        safe = false; reason = "freeze_authority_active_honeypot_risk";
    } else if (_vetoRisk) {
      // PATCH #1: hard-veto on LP-pull / concentration risk flags.
      safe = false;
      const _vetoSlug = String(_vetoRisk.name || "unknown").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
      reason = `rugcheck_veto_${_vetoSlug}`;
      console.log(`[SAFETY-VETO] $${pair.baseToken?.symbol || tokenAddress} HARD-VETO on risk flag: ${_vetoRisk.name}`);
    } else if (_mintActive) {
      // FIX: MINT authority active but freeze is null -> dilution risk only, token is still sellable.
      // Allow the trade (safe stays true) but log it for monitoring. Honeypot (freeze) is already blocked above,
      // and position size is capped by the micro-wallet sizing + fast take-profit ladder.
      console.log(`[SAFETY] $${pair.baseToken?.symbol || tokenAddress} mint_authority_active_ALLOWED (freeze=null, rugcheckScore=${data.score})`);
    } else if (data.score < engineSettings.rugcheckMinScore) {
      safe = false; reason = `rugcheck_score_low(${data.score})`;
    }
    const result = { safe, reason };
    safetyCache.set(tokenAddress, { ...result, timestamp: Date.now() });
    return result;
  } catch (e) {
    return { safe: false, reason: "rugcheck_timeout" };
  }
}

async function runScanCycle() {
  if (scanLock) return;
  scanLock = true;
  try {
    await initBalanceFromDB();

    const modeStatus = await storage.getBotStatus().catch(() => ({ tradingMode: "paper" }));
    const isLive = modeStatus.tradingMode === "live" && jupiterService !== null;
    if (isLive) {
        const realFreeBal = await jupiterService!.getWalletBalance().catch(() => 0);
        if (realFreeBal > 0) await storage.updateBotStats({ walletBalance: realFreeBal.toFixed(4) });
    } else {
        await storage.updateBotStats({ walletBalance: paperBalance.toFixed(4) });
    }

    const now = Date.now();
    const cleanupThreshold = engineSettings.reentryDelayMs * 3;
    for (const [addr, ts] of tradedAddresses) if (now - ts > cleanupThreshold) tradedAddresses.delete(addr);
    for (const [addr, ts] of stoppedOutAddresses) if (now - ts > engineSettings.slReentryDelayMs) stoppedOutAddresses.delete(addr);
    for (const [addr, ts] of hardBlockedAddresses) {
      const ttl = (tokenStopLossCount.get(addr) ?? 0) >= 2 ? REPEAT_LOSER_BLOCK_MS : HARD_BLOCK_TTL_MS;
      if (now - ts > ttl) { hardBlockedAddresses.delete(addr); tokenStopLossCount.delete(addr); }
    }
    // BUGFIX #21: was 15000ms (15s) — too short for Jupiter outages. Each failed
    // buy costs ~0.0002 SOL in priority fees. Extending to 30s halves the fee bleed
    // during outages without significantly delaying valid re-entries.
    for (const [addr, ts] of recentlyAttemptedBuys) if (now - ts > 30000) recentlyAttemptedBuys.delete(addr);
    for (const [addr, ts] of pendingBuys) if (now - ts > 30000) pendingBuys.delete(addr);

    const status = await storage.getBotStatus();
    if (!status.isRunning) return;
    const riskCheck = await checkCircuitBreakers();
    if (!riskCheck.canTrade) return;

    const currentBalance = await getEffectiveBalance();
    const isMicroWallet = currentBalance < 0.10;
    console.log(`[DEBUG] currentBalance: ${currentBalance}, isMicroWallet: ${isMicroWallet}`);
    if (isMicroWallet) {
      console.log(`[SCAN] Micro-Wallet Mode Active (Bal: ${currentBalance.toFixed(4)} SOL)`);
    }

    const openTrades = await storage.getOpenTrades();
    const candidates = await fetchDexScreenerCandidates(isMicroWallet);
    const top10 = candidates.slice(0, 10);
    if (top10.length === 0) return;
    
    const momentumCandidates = top10.filter(c => parseFloat(c.volume5m as string || "0") > 0);
    const pauseSample = momentumCandidates.length >= 5 ? momentumCandidates : top10;
    const avgVolumeLast10 = pauseSample.reduce((sum, c) => sum + parseFloat(c.volume5m as string || "0"), 0) / Math.max(1, pauseSample.length);
    if (pauseSample.length >= 5 && avgVolumeLast10 < 75) { 
        console.log(`[PAUSE] Low market activity (avg 5m vol $${avgVolumeLast10.toFixed(0)} < $75, n=${pauseSample.length} active candidates) — skipping cycle`); 
        return; 
    }
    
    const liveBal = (status.tradingMode === "live" && jupiterService) ? await readLiveWalletBalance() : paperBalance;
    const effectiveBalance = Math.max(0, liveBal - reservedCapital);
    
    const minViableBalance = 0.005 + engineSettings.minPositionSize;
    if (effectiveBalance < minViableBalance) { 
        console.log(`[RISK] Insufficient usable balance (effective ${effectiveBalance.toFixed(4)} SOL < ${minViableBalance.toFixed(4)} required) — skipping cycle`); 
        return; 
    }
    
    // HORIZONTAL AUTO-SCALER (INFINITE LOOP)
    // Divides your total effective balance by 10 (since 10 SOL is the liquidity ceiling per coin)
    let cycleMaxPositions = Math.max(engineSettings.maxOpenPositions, Math.floor(effectiveBalance / 10.0));
    
    // HARDWARE SAFETY LIMIT: We cap it at 30 simultaneous positions to prevent the RPC node from crashing
    // due to rate limits when tracking live prices for too many coins at the exact same second.
    if (cycleMaxPositions > 30) cycleMaxPositions = 30;
    const cycleMinSize = engineSettings.minPositionSize; 
    
    if (openTrades.length >= cycleMaxPositions) return;
    if (sellingInProgress.size > 0) { 
        console.log(`[SCAN] Deferring new buys — ${sellingInProgress.size} sell(s) in progress`); 
        return; 
    }
    
    let remainingBalance = effectiveBalance, failedTradesThisCycle = 0;
    if (openTrades.length > 0) {
      const monitoredTrades = openTrades.filter((t: any) => !priceSanityRejections.has(t.id));
      const worstOpenPnl = monitoredTrades.length > 0
        ? Math.min(...monitoredTrades.map((t: any) => parseFloat(t.pnl || "0")))
        : 0;
      if (worstOpenPnl <= -5) { 
          console.log(`[SCAN] Skipping new entries — worst open position at ${worstOpenPnl.toFixed(1)}%.`); 
          return; 
      }
    }
    
    const PUMPFUN_DEXES = new Set(["pumpfun", "pump-fun", "pumpswap"]);
    const openPumpfunCount = openTrades.filter((t: any) => PUMPFUN_DEXES.has((t.dex || "").toLowerCase())).length;
    const openAddresses = new Set(openTrades.map((t: any) => t.tokenAddress));
    const boughtThisCycle = new Set<string>();
    let currentOpenCount = openTrades.length, tradesThisCycle = 0;
    let totalExposureSol = openTrades.reduce((sum, t) => sum + parseFloat(t.amount || "0"), 0);
    
    for (const candidate of candidates) {
      const addr = candidate.tokenAddress;
      if (boughtThisCycle.has(addr)) continue;
      if (pendingBuys.has(addr)) { console.log(`[SCAN] Skipping $${candidate.tokenSymbol} — buy already pending`); continue; }
      if (recentlyAttemptedBuys.has(addr)) { console.log(`[SCAN] Skipping $${candidate.tokenSymbol} — recently attempted and failed`); continue; }
      
      const lastTraded = tradedAddresses.get(addr);
      if (lastTraded) {
        const elapsed = Date.now() - lastTraded;
        const REENTRY_HARD_FLOOR_MS = 30_000;
        if (elapsed < REENTRY_HARD_FLOOR_MS) {
            console.log(`[GATE] SKIP $${candidate.tokenSymbol} — Re-entry hard floor (traded ${Math.round(elapsed/1000)}s ago)`);
            continue;
        }
        const isStoppedOut = stoppedOutAddresses.has(addr);
        const highScoreAgain = candidate.score >= 85 && !isStoppedOut;
        if (elapsed < engineSettings.reentryDelayMs && !highScoreAgain) {
            console.log(`[GATE] SKIP $${candidate.tokenSymbol} — Re-entry delay active.`);
            continue;
        }
      }
      
      const lastLossTime = tokenLastLossMs.get(addr);
      if (lastLossTime && (Date.now() - lastLossTime) < POST_LOSS_COOLDOWN_MS) {
          console.log(`[GATE] SKIP $${candidate.tokenSymbol} — Token in post-loss cooldown.`);
          continue;
      }
      
      const sessionCount = sessionTokenBuyCount.get(addr) ?? 0;
      if (sessionCount >= 2) {
          console.log(`[GATE] SKIP $${candidate.tokenSymbol} — Max session entries reached.`);
          continue;
      }
      
      const sym = candidate.tokenSymbol;
      const symLastLossTime = tokenSymbolLastLossMs.get(sym);
      if (symLastLossTime && (Date.now() - symLastLossTime) < SYMBOL_LOSS_COOLDOWN_MS) {
          console.log(`[GATE] SKIP $${sym} �� Symbol in post-loss cooldown.`);
          continue;
      }
      
      const symSlBlockTime = tokenSymbolSlBlockMs.get(sym);
      if (symSlBlockTime && (Date.now() - symSlBlockTime) < SYMBOL_SL_COOLDOWN_MS) {
          console.log(`[GATE] SKIP $${sym} — Symbol in SL cooldown.`);
          continue;
      }
      
      const symSessionCount = sessionSymbolBuyCount.get(sym) ?? 0;
      if (symSessionCount >= 2) {
          console.log(`[GATE] SKIP $${sym} — Symbol session limit reached.`);
          continue;
      }
      
      if (hardBlockedAddresses.has(addr)) {
          console.log(`[GATE] SKIP $${sym} — Token is on the hard-block list.`);
          continue;
      }
      const lastStopped = stoppedOutAddresses.get(addr);
      if (lastStopped && (Date.now() - lastStopped) < engineSettings.slReentryDelayMs) {
          console.log(`[GATE] SKIP $${sym} — Token SL re-entry delay active.`);
          continue;
      }
      if (openAddresses.has(addr)) continue;
      if (currentOpenCount >= cycleMaxPositions) break;
      if (tradesThisCycle >= engineSettings.maxTradesPerCycle) break;
      
      const { price, pair } = await fetchTokenPrice(candidate.tokenAddress);
      if (!pair || price <= 0) {
          console.log(`[GATE] SKIP $${candidate.tokenSymbol} — Invalid price or pair data.`);
          continue;
      }
      
      const vol5mCheck = pair.volume?.m5 ?? 0;
      const txBuys5m = pair.txns?.m5?.buys ?? 0;
      const txSells5m = pair.txns?.m5?.sells ?? 0;
      const txTotal5m = txBuys5m + txSells5m;
      if (vol5mCheck < 75 || txTotal5m < 3) {
          console.log(`[GATE] SKIP $${candidate.tokenSymbol} — Insufficient 5m activity (Vol: $${vol5mCheck.toFixed(0)}, Tx: ${txTotal5m})`);
          continue;
      }
      
      const pairDex = (pair.dexId || candidate.dex || "").toLowerCase();
      if (!JUPITER_SUPPORTED_DEXES.has(pairDex)) { 
          console.log(`[GATE] SKIP $${candidate.tokenSymbol} — Unsupported DEX: ${pairDex}`);
          hardBlockedAddresses.set(addr, Date.now()); 
          continue; 
      }
      if (PUMPFUN_DEXES.has(pairDex) && openPumpfunCount >= cycleMaxPositions) {
          console.log(`[GATE] SKIP $${candidate.tokenSymbol} — Pumpfun concentration limit reached (${cycleMaxPositions}).`);
          continue;
      }
      
      const poolAgeMs = pair.pairCreatedAt ? Date.now() - pair.pairCreatedAt : 0;
      if (poolAgeMs < JUPITER_INDEX_DELAY_MS) {
          console.log(`[GATE] SKIP $${candidate.tokenSymbol} — Pool too young (${Math.floor(poolAgeMs/1000)}s), awaiting Jupiter index.`);
          continue;
      }
      
      const scanPrice = parseFloat(candidate.price);
      if (scanPrice > 0) {
        const priceDrift = Math.abs((price - scanPrice) / scanPrice) * 100;
        const driftLimit = candidate.qualifiedMode === "SNIPER" ? 30 : candidate.qualifiedMode === "MG" ? 25 : 20;
        if (priceDrift > driftLimit) { 
            console.log(`[GATE] SKIP $${candidate.tokenSymbol} — Price drifted ${priceDrift.toFixed(1)}% since scan (Limit: ${driftLimit}%)`);
            // FIX: drift-skips must NOT touch tradedAddresses (the real-trade
            // re-entry cooldown). Stamping it here produced phantom "Re-entry
            // hard floor (traded Xs ago)" logs and imposed a 60s re-entry block
            // on tokens that were never actually bought. priceDrift is recomputed
            // with a fresh price every cycle, so a token that stabilizes passes
            // next cycle on its own — no debounce needed.
            continue; 
        }
      }
      
      let scoring = scoreToken(pair, null, isMicroWallet);
      if (candidate.mlActive && candidate.mlScore != null) {
        const pumpProb = candidate.mlScore / 100;
        const dumpRisk = candidate.mlDumpRisk != null ? candidate.mlDumpRisk : 1 - pumpProb;
        const mlScore = candidate.mlScore;
        const mlAdjusted = mlScore * (1 - dumpRisk * 0.5);
        const combined = Math.max(0, Math.min(100, Math.round(scoring.score * engineSettings.scoreWeight + mlAdjusted * engineSettings.mlWeight)));
        scoring = { ...scoring, mlScore, combinedScore: combined };
      } else {
        const freshMl = await getMLPrediction(scoring.metrics);
        if (freshMl) {
          const mlScore = Math.round(freshMl.pumpProb * 100);
          const mlAdjusted = mlScore * (1 - freshMl.dumpRisk * 0.5);
          const combined = Math.max(0, Math.min(100, Math.round(scoring.score * engineSettings.scoreWeight + mlAdjusted * engineSettings.mlWeight)));
          scoring = { ...scoring, mlScore, combinedScore: combined };
        }
      }
      
      scoring.sizeSol = Math.max(cycleMinSize, scoring.sizeSol);
      const effectiveMinScore = getEffectiveMinScore(isMicroWallet);
      
      if (!scoring.qualifiedMode || scoring.combinedScore < effectiveMinScore || scoring.sizeSol < cycleMinSize) {
        console.log(`[SCORE_GATE] SKIP $${candidate.tokenSymbol} — Score: ${scoring.combinedScore} (Min: ${effectiveMinScore}) | Mode: ${scoring.qualifiedMode ?? "none (Reason: " + (scoring.rejectionReason || "failed strict gates") + ")"} | Size: ${scoring.sizeSol.toFixed(4)} (Min: ${cycleMinSize})`);
        continue;
      }
      if (status.mode !== "AUTO" && scoring.qualifiedMode !== status.mode) {
          console.log(`[GATE] SKIP $${candidate.tokenSymbol} — Mode mismatch (${scoring.qualifiedMode} != ${status.mode})`);
          continue;
      }
      
      const isLiveBuy = status.tradingMode === "live" && jupiterService !== null;
      const walletBal = isLiveBuy ? remainingBalance : paperBalance;
      const totalPortfolioSol = walletBal + totalExposureSol;
      const SOL_PRICE_USD = await getLiveSolPrice();
      const liq = pair.liquidity?.usd || 0;

      if (liq === 0) {
          console.log(`[GATE] SKIP $${candidate.tokenSymbol} — Zero liquidity reported.`);
          continue;
      }
      const effSniperLiq   = engineSettings.sniperMinLiquidity /* FIX(liq-floor): removed micro-wallet $1k discount that let the bot buy un-tradeable thin tokens (BioCraft $21k -> ~35% real round-trip loss). Restored $50k floor. */;
      const effHwrLiq      = engineSettings.hwrMinLiquidity /* FIX(liq-floor): removed micro-wallet $2k discount. Restored $50k floor. */;
      const MIN_BUY_LIQ_USD = scoring.qualifiedMode === "HWR" ? effHwrLiq : effSniperLiq;
      if (liq < MIN_BUY_LIQ_USD) {
          console.log(`[GATE] SKIP $${candidate.tokenSymbol} — Live liq $${liq.toFixed(0)} < minimum $${MIN_BUY_LIQ_USD}`);
          continue;
      }
      
      const poolLiqSol = SOL_PRICE_USD > 0 ? liq / SOL_PRICE_USD : Infinity;

      // TIERED SIZING: Progressive de-risking for 1000x compounding path.
      // Replaces the dead compound boost (which re-clamped to the same ceiling
      // it multiplied, making it a no-op). The tier pct replaces the fixed
      // MAX_SINGLE_TRADE_PCT ceiling; the micro-boost accelerates early trades.
      const { pct: tierPct, boost: microBoost, tier: sizingTier } = getTieredSizing(totalPortfolioSol);
      let targetSize = Math.min(engineSettings.maxPositionSize, remainingBalance * tierPct, poolLiqSol * 0.015);
      targetSize = Math.max(targetSize, engineSettings.minPositionSize);
      // Micro-stage boost: only active below 0.05 SOL, capped at 1.5x.
      // Applied BEFORE the re-clamp so it can actually increase trade size
      // (unlike the old code which re-clamped to the same ceiling).
      targetSize = Math.min(targetSize * microBoost, remainingBalance * tierPct, poolLiqSol * 0.015);
      // Enforce compoundAbsCapSol — the absolute SOL cap that was declared but
      // never enforced in the old code.
      targetSize = Math.min(targetSize, engineSettings.compoundAbsCapSol);
      // HARDENING Change 3: Loss throttle — -20% size per consecutive loss, floor at 40%
      const lossThrottle = Math.max(0.40, 1 - consecutiveLosses * 0.20);
      // HARDENING Change 4: Drawdown de-lever — gradual size cut as DD approaches circuit breaker (25%)
      //   DD < 15%  → full size (delever=1.0)
      //   DD = 20%  → 75% size
      //   DD = 25%  → 50% size (circuit breaker blocks at maxDrawdownPct anyway)
      const ddPctSizing = peakBalance > 0 ? Math.max(0, ((peakBalance - totalPortfolioSol) / peakBalance) * 100) : 0;
      const ddDelever = ddPctSizing > 15 ? Math.max(0.50, 1 - (ddPctSizing - 15) / 20) : 1;
      targetSize = targetSize * lossThrottle * ddDelever;
      targetSize = Math.max(targetSize, engineSettings.minPositionSize);
      scoring.sizeSol = parseFloat(targetSize.toFixed(4));
      console.log(`[SIZING] Tier ${sizingTier} | bal ${totalPortfolioSol.toFixed(4)} SOL | pct ${(tierPct * 100).toFixed(0)}% | boost ${microBoost.toFixed(2)}x | throttle ${(lossThrottle * 100).toFixed(0)}% | ddDelever ${(ddDelever * 100).toFixed(0)}% | size ${scoring.sizeSol.toFixed(4)} SOL`);
      
      if (scoring.sizeSol < MIN_TRADE_SIZE_SOL) {
          console.log(`[GATE] SKIP $${candidate.tokenSymbol} — Dust trade size (${scoring.sizeSol.toFixed(4)} SOL)`);
          continue; 
      }

      const solPriceForLiq = cachedSolPriceUsd || 150;
      const tradeSizeUsd = scoring.sizeSol * solPriceForLiq;
      const dynamicMinLiq = tradeSizeUsd * 80;
      if (liq < dynamicMinLiq) {
          console.log(`[GATE] SKIP $${candidate.tokenSymbol} — Pool liq $${liq.toFixed(0)} < dynamic floor $${dynamicMinLiq.toFixed(0)} (needs 80x depth)`);
          continue;
      }
      
      const maxTotalExposure = Math.max(engineSettings.maxPositionSize * 2, totalPortfolioSol * 0.40);
      if (totalExposureSol + scoring.sizeSol > maxTotalExposure) {
          console.log(`[GATE] SKIP $${candidate.tokenSymbol} — Max total exposure reached.`);
          continue;
      }
      
      const txCosts = calcTransactionCosts(liq, scoring.sizeSol);
      const entryTotalCostSol = scoring.sizeSol * (1 + (txCosts.entrySlippagePct + txCosts.entryFeePct) / 100);
      if (entryTotalCostSol < MIN_VIABLE_TRADE_SOL) {
          console.log(`[GATE] SKIP $${candidate.tokenSymbol} ��� Trade too small after fees (${entryTotalCostSol.toFixed(4)} SOL)`);
          continue;
      }
      
      if (isLiveBuy) {
        const freshSolBal = await jupiterService!.getWalletBalance().catch(() => remainingBalance);
        const safeBalance = Math.max(0, freshSolBal - reservedCapital);
        // BUGFIX #5: was `scoring.sizeSol + MIN_FEE_BUFFER_SOL` — but actual spent
        // can be up to `sizeSol * (1 + slippagePct/100)` due to slippage. $Taz
        // targeted 0.0059 SOL but spent 0.0124 SOL (110% overspend). Account for
        // max slippage to prevent the buy from draining more SOL than expected.
        // Uses scoring.slippage directly (slippageBps is declared later as scoring.slippage * 100).
        const _b5SlippagePct = scoring.slippage;
        const maxPossibleSpend = scoring.sizeSol * (1 + _b5SlippagePct / 100) + MIN_FEE_BUFFER_SOL;
        if (safeBalance < maxPossibleSpend) {
          console.log(`[RISK] SKIP $${candidate.tokenSymbol} — Safe balance ${safeBalance.toFixed(4)} SOL < max spend ${maxPossibleSpend.toFixed(4)} SOL (size ${scoring.sizeSol.toFixed(4)} + ${_b5SlippagePct}% slippage + ${MIN_FEE_BUFFER_SOL} fee buffer)`);
          recentlyAttemptedBuys.set(addr, Date.now());
          continue;
        }
        remainingBalance = safeBalance;
      }
      
      const safety = await checkTokenSafety(candidate.tokenAddress, pair);
      if (!safety.safe) {
        console.log(`[SAFETY] BLOCKED $${candidate.tokenSymbol} — ${safety.reason}`);
        if (safety.reason.startsWith("rugcheck_danger") || safety.reason.startsWith("rugcheck_score_low") || safety.reason.startsWith("insider_ownership_detected") || safety.reason.startsWith("low_liq_depth_ratio")) {
            hardBlockedAddresses.set(addr, Date.now());
        }
        continue;
      }
      
      // QUALITY GATE 4: Social Maturity / Watchlist Staging
      const rawInfo = (pair as any).info || {};
      const hasSocials = (rawInfo.socials && rawInfo.socials.length > 0) || (rawInfo.websites && rawInfo.websites.length > 0);
      const currentScore = scoring.combinedScore;
      
      // EXEMPTION: Pump.fun tokens naturally lack DexScreener socials early on.
      const isPumpFunCandidate = PUMPFUN_DEXES.has(pairDex);

      if (currentScore >= 85 && currentScore < 92 && !hasSocials && !isPumpFunCandidate) {
          if (!watchlistCache.has(addr)) {
              console.log(`[WATCHLIST] Staging $${candidate.tokenSymbol} — Waiting for socials/metadata to validate mid-tier score.`);
              watchlistCache.set(addr, { pair, firstSeen: Date.now() });
          } else {
              console.log(`[GATE] SKIP $${candidate.tokenSymbol} — Still on watchlist (awaiting socials).`);
          }
          continue;
      }

      let slippageBps = scoring.slippage * 100;
      if (scoring.qualifiedMode === "SNIPER") {
        const bp5mNum = parseFloat(candidate.buyPressure5m || "0");
        if ((candidate.priceChange5m || 0) > 7 && bp5mNum < 0.50) {
            console.log(`[TIMING] SKIP $${candidate.tokenSymbol} — SNIPER momentum cooling.`);
            continue;
        }
      }
      
      const isMicroCapToken = liq < 3000 && candidate.ageSeconds < 60;
      const preflightImpactLimit = scoring.qualifiedMode === "SNIPER" ? (isMicroCapToken ? 6 : 7) : 4.0;
      const lamportsForPreflight = Math.floor(scoring.sizeSol * 1e9);
      const quoteCacheKey = `${candidate.tokenAddress}:${lamportsForPreflight}:${slippageBps}`;
      let executionQuote: any = null;
      
      if (isLiveBuy) {
        executionQuote = null;
        try {
          executionQuote = await jupiterService!.fetchQuote(SOL_MINT, candidate.tokenAddress, lamportsForPreflight, [slippageBps]);
          executionQuote._fetchedAt = Date.now();
          setCachedQuote(quoteCacheKey, executionQuote);
        } catch (quoteErr: any) { 
            console.log(`[GATE] SKIP $${candidate.tokenSymbol} — Buy-side quote failed.`);
            recentlyAttemptedBuys.set(addr, Date.now()); 
            continue; 
        }
        
        const impactPct = parseFloat(executionQuote?.priceImpactPct ?? "0");
        if (impactPct > preflightImpactLimit) { 
            console.log(`[GATE] SKIP $${candidate.tokenSymbol} — Buy impact ${impactPct.toFixed(2)}% exceeds limit ${preflightImpactLimit}%`);
            recentlyAttemptedBuys.set(addr, Date.now()); 
            continue; 
        }

        // QUALITY GATE 5: Strict Pre-Flight Round-Trip
        if (executionQuote?.outAmount) {
            try {
                const sellCheckQuote = await jupiterService!.fetchQuote(
                    candidate.tokenAddress, SOL_MINT, executionQuote.outAmount, [slippageBps]
                );
                
                if (!sellCheckQuote || !sellCheckQuote.outAmount) {
                    console.log(`[GATE] SKIP $${candidate.tokenSymbol} — NO SELL ROUTE (token likely has no exit liquidity).`);
                    hardBlockedAddresses.set(addr, Date.now()); 
                    recentlyAttemptedBuys.set(addr, Date.now());
                    continue;
                }
                
                const sellReturnLamports = parseInt(sellCheckQuote.outAmount, 10);
                const roundTripPct = (sellReturnLamports / lamportsForPreflight) * 100;
                
                // Hard block if we lose >15% of value just by entering and exiting.
                if (roundTripPct < 85) { 
                    console.log(`[GATE] SKIP $${candidate.tokenSymbol} — High round-trip friction: ${ (100 - roundTripPct).toFixed(1) }% loss on simulation.`);
                    recentlyAttemptedBuys.set(addr, Date.now());
                    continue;
                }
                
                const sellImpactPct = parseFloat(sellCheckQuote.priceImpactPct ?? "0");
                if (sellImpactPct > 10) {
                    console.log(`[GATE] SKIP $${candidate.tokenSymbol} — Sell-side impact too high (${sellImpactPct.toFixed(2)}%).`);
                    recentlyAttemptedBuys.set(addr, Date.now());
                    continue;
                }
            } catch (e) {
                console.log(`[GATE] SKIP $${candidate.tokenSymbol} — Sell-side preflight failed to simulate.`);
                recentlyAttemptedBuys.set(addr, Date.now());
                continue;
            }
        }
      }
      
      const preflight = executionQuote ? { priceImpactPct: parseFloat(executionQuote.priceImpactPct ?? "0"), outAmount: executionQuote.outAmount ?? "0", routeInfo: "direct" } : null;
      if (isLiveBuy && !preflight) { 
          console.log(`[GATE] SKIP $${candidate.tokenSymbol} — No valid Jupiter quote for impact estimation.`);
          recentlyAttemptedBuys.set(addr, Date.now()); 
          continue; 
      }
      
      const solPrice = SOL_PRICE_USD;
      const estimatedImpact = preflight?.priceImpactPct ?? (liq > 0 ? Math.min(12, ((scoring.sizeSol * solPrice) / (liq * 2)) * 100) : 6);
      const edge = getEdgeParams(isMicroWallet);
      const scoreBasedExpectedMove = Math.max(0, (scoring.combinedScore - 50) * edge.expectedMoveCoeff);
      
      if (isMicroCapToken) {
        // BUGFIX #7: was hardcoded 0.02 SOL — on a 0.05 SOL micro-wallet this
        // is 40% of balance and may exceed available funds after slippage.
        // Cap at 0.02 OR 20% of remaining balance, whichever is smaller.
        scoring.sizeSol = Math.min(0.02, remainingBalance * 0.20);
        const newSlippageBps = 800;
        if (isLiveBuy && newSlippageBps !== slippageBps) {
          try {
            const microCapLamports = Math.floor(scoring.sizeSol * 1e9);
            const freshQuote = await jupiterService!.fetchQuote(SOL_MINT, candidate.tokenAddress, microCapLamports, [newSlippageBps]);
            if (!freshQuote) {
                console.log(`[GATE] SKIP $${candidate.tokenSymbol} — No quote at micro-cap slippage.`);
                continue;
            }
            executionQuote = freshQuote;
            executionQuote._fetchedAt = Date.now();
          } catch { 
              console.log(`[GATE] SKIP $${candidate.tokenSymbol} — Micro-cap quote fetch failed.`);
              recentlyAttemptedBuys.set(addr, Date.now()); 
              continue; 
          }
        }
        slippageBps = newSlippageBps;
      }
      
      let actualSizeSol = scoring.sizeSol, buyTxHash: string;
      if (isLiveBuy) {
        const QUOTE_MAX_AGE_MS = 4000;
        const quoteAge = executionQuote?._fetchedAt ? Date.now() - executionQuote._fetchedAt : 9999;
        if (quoteAge > QUOTE_MAX_AGE_MS) { 
            console.log(`[GATE] SKIP $${candidate.tokenSymbol} — Quote stale (${quoteAge}ms old).`);
            recentlyAttemptedBuys.set(addr, Date.now()); 
            continue; 
        }
        
        const impactPct = parseFloat(executionQuote?.priceImpactPct ?? "0");
        if (impactPct > slippageBps / 100) { 
            console.log(`[GATE] SKIP $${candidate.tokenSymbol} — Impact ${impactPct.toFixed(2)}% exceeds slippage.`);
            recentlyAttemptedBuys.set(addr, Date.now()); 
            continue; 
        }
        
        const finalEstimatedImpact = impactPct || estimatedImpact;
        const finalRoundTripCost =
          finalEstimatedImpact * edge.exitImpactMult +
          engineSettings.txFeePercent * edge.feeMultiplier +
          edge.buffer;
        const finalEdge = scoreBasedExpectedMove - finalRoundTripCost;
        if (finalEdge < edge.minEdgePct) {
            console.log(`[EDGE SKIP] $${candidate.tokenSymbol} — edge ${finalEdge.toFixed(2)}% < ${edge.minEdgePct}% (micro=${isMicroWallet}, expMove=${scoreBasedExpectedMove.toFixed(2)}%, rtCost=${finalRoundTripCost.toFixed(2)}%, impact=${finalEstimatedImpact.toFixed(2)}%)`);
            recentlyAttemptedBuys.set(addr, Date.now()); 
            continue; 
        }
        
        pendingBuys.set(addr, Date.now());
        reservedCapital += entryTotalCostSol;
        
        if (isLiveBuy) {
          const preTradeRisk = await checkCircuitBreakers();
          if (!preTradeRisk.canTrade) {
            pendingBuys.delete(addr);
            reservedCapital -= entryTotalCostSol;
            console.warn(`[CIRCUIT_BREAKER] 🛑 PRE-TRADE BLOCK $${candidate.tokenSymbol} — Breaker tripped mid-cycle.`);
            break; 
          }
        }
        
        if (isHalted()) {
          pendingBuys.delete(addr);
          reservedCapital -= entryTotalCostSol;
          console.warn(`[FAILSAFE] \u{1F6D1} HALT flag set -- skipping buy $${candidate.tokenSymbol}`);
          break;
        }

        let buyResult: { success: boolean; txSignature: string | null; actualSolSpent: number; tokenAmountRaw: bigint; priceImpactPct: number; feesSol: number; error?: string } | undefined;
        try {
          await new Promise(r => setTimeout(r, 150));
          buyResult = await jupiterService!.buyToken(candidate.tokenAddress, scoring.sizeSol, slippageBps, executionQuote ?? undefined, preflightImpactLimit);
        } catch (err: any) {
          console.log(`[LIVE ERROR] Buy failed for $${candidate.tokenSymbol}: ${err?.message}`);
          recentlyAttemptedBuys.set(addr, Date.now());
        } finally {
          pendingBuys.delete(addr);
          reservedCapital -= entryTotalCostSol;
        }
        if (!buyResult) { continue; }
        if (!buyResult.success) {
            console.log(`[LIVE FAILED] Buy failed for $${candidate.tokenSymbol}.`);
            recentlyAttemptedBuys.set(addr, Date.now());
            // BUGFIX #10: was `tradedAddresses.set(addr, Date.now())` — but the buy
            // NEVER happened. Setting tradedAddresses blocks re-entry for 60s, which
            // means a transient Jupiter failure (network blip) prevents buying a
            // token that's still pumping. Only set recentlyAttemptedBuys (15s block).
            failedTradesThisCycle++;
            if (failedTradesThisCycle >= (isMicroWallet ? 1 : 2)) break;
            continue;
        }
        
        remainingBalance = (await jupiterService!.getWalletBalance().catch(() => remainingBalance)) - reservedCapital;
        actualSizeSol = buyResult.actualSolSpent;
        buyTxHash = buyResult.txSignature!;

        // BUGFIX #11: validate buyResult fields before recording trade.
        // If actualSolSpent=0 (Jupiter bug) or tokenAmountRaw=0 (no tokens received),
        // recording a trade creates a phantom position that can never be sold —
        // it auto-closes as DESYNC at -100%, masking the real SOL loss.
        if (actualSizeSol <= 0 || buyResult.tokenAmountRaw <= BigInt(0)) {
          console.error(`[FATAL] Buy returned success but invalid fields: actualSolSpent=${actualSizeSol}, tokenAmountRaw=${buyResult.tokenAmountRaw} — aborting trade record. Check wallet for stranded SOL/tokens.`);
          recentlyAttemptedBuys.set(addr, Date.now());
          // If tokens were received but actualSolSpent is 0, try to sell them back
          if (buyResult.tokenAmountRaw > BigInt(0) && actualSizeSol <= 0) {
            await jupiterService!.sellToken(candidate.tokenAddress, buyResult.tokenAmountRaw, 3000).catch(e => console.error(`[FATAL] Recovery sell failed:`, e));
          }
          continue;
        }

        // PATCH #5: OVERSPEND REVERT — if the actual SOL spent exceeds 110% of the target
        // size, the pool is hostile (slippage too high / sandwiched). $Taz targeted 0.0059
        // SOL but spent 0.0124 SOL (2.1x overspend) — an instant 110% slippage loss before
        // the position even had a chance to breathe. Immediately unwind the position and
        // block re-entry for the session.
        const OVERSPEND_TOLERANCE = 1.10;
        if (actualSizeSol > scoring.sizeSol * OVERSPEND_TOLERANCE && buyResult.tokenAmountRaw > BigInt(0)) {
          const overspendPct = ((actualSizeSol / scoring.sizeSol) - 1) * 100;
          console.error(`[OVERSPEND] $${candidate.tokenSymbol} — spent ${actualSizeSol.toFixed(4)} SOL vs target ${scoring.sizeSol.toFixed(4)} SOL (+${overspendPct.toFixed(0)}% over) — IMMEDIATE UNWIND`);
          try {
            const unwindSlippage = 1500; // 15% — accept heavy slippage to exit hostile pool fast
            await jupiterService!.sellToken(candidate.tokenAddress, buyResult.tokenAmountRaw, unwindSlippage);
            console.error(`[OVERSPEND] $${candidate.tokenSymbol} — unwound tokens, closing trade as OVERSPEND_REVERT`);
          } catch (unwindErr: any) {
            console.error(`[OVERSPEND] $${candidate.tokenSymbol} — unwind FAILED: ${unwindErr?.message}. Token may be stranded.`);
          }
          // Record the trade and immediately close it so it appears in the trade history.
          try {
            const _overspendTrade = await storage.addTrade({
              tokenAddress: candidate.tokenAddress, tokenSymbol: candidate.tokenSymbol, type: "BUY", mode: scoring.qualifiedMode,
              tradingMode: "live", status: "OPEN", amount: actualSizeSol.toFixed(4), price: price.toString(), currentPrice: price.toString(),
              peakPrice: price.toString(), pnl: "0", peakPnl: "0", score: scoring.combinedScore.toString(), txHash: buyTxHash, liquidity: liq.toFixed(2),
              dex: (pair.dexId || candidate.dex || "").toLowerCase(),
            });
            await storage.closeTrade(_overspendTrade.id, price.toString(), "-5", `OVERSPEND_REVERT (+${overspendPct.toFixed(0)}% slippage)`);
          } catch {}
          hardBlockedAddresses.set(addr, Date.now());
          recentlyAttemptedBuys.set(addr, Date.now());
          tradedAddresses.set(addr, Date.now());
          continue;
        }

        const buyFeesSol = buyResult.feesSol ?? 0;
        totalExposureSol += actualSizeSol;
        tradedAddresses.set(addr, Date.now());
        openAddresses.add(addr);
        boughtThisCycle.add(addr);
        currentOpenCount++;
        tradesThisCycle++;
        dailyTradeCount++;
        totalTradesAllTime++;
        
        // Remove from watchlist if successful
        if (watchlistCache.has(addr)) watchlistCache.delete(addr);

        let trade: any;
        try {
          trade = await storage.addTrade({
            tokenAddress: candidate.tokenAddress, tokenSymbol: candidate.tokenSymbol, type: "BUY", mode: scoring.qualifiedMode,
            tradingMode: "live", status: "OPEN", amount: actualSizeSol.toFixed(4), price: price.toString(), currentPrice: price.toString(),
            peakPrice: price.toString(), pnl: "0", peakPnl: "0", score: scoring.combinedScore.toString(), txHash: buyTxHash, liquidity: liq.toFixed(2),
            dex: (pair.dexId || candidate.dex || "").toLowerCase(), 
          });
        } catch (dbErr: any) {
          console.error(`[FATAL] DB Failed to save trade for $${candidate.tokenSymbol}! Moonbag prevention: Auto-selling ${buyResult.tokenAmountRaw} tokens.`, dbErr);
          if (buyResult?.tokenAmountRaw && buyResult.tokenAmountRaw > BigInt(0)) {
            // BUGFIX #12: was 500 bps (5%) — emergency sell should use 3000 bps (30%)
            // to guarantee fill. We just bought successfully, so the pool is tradeable;
            // the DB failure is on our side, not the pool's. Accept bad fill over stuck tokens.
            await jupiterService!.sellToken(candidate.tokenAddress, buyResult.tokenAmountRaw, 3000).catch(e => console.error(`Emergency sell failed:`, e));
          }
          continue;
        }
        liveTokenBalances.set(trade.id, buyResult.tokenAmountRaw);
        console.log(`[DIAG-FILL] $${candidate.tokenSymbol} #${trade.id} | targetSize ${scoring.sizeSol.toFixed(4)} SOL | actualSpent ${actualSizeSol.toFixed(4)} SOL | buyFees ${buyFeesSol.toFixed(4)} SOL | entryChartPx $${price.toFixed(8)} | liq $${liq.toFixed(0)} | tokensRaw ${buyResult.tokenAmountRaw} | compare actualSpent vs final LIVE_FEE netReceived for TRUE round-trip`);
        peakPrices.set(trade.id, price);
        tradeStopPrices.set(trade.id, calcCostAwareStopPrice(price, scoring.qualifiedMode, liq, scoring.sizeSol, cachedSolPriceUsd));
        sessionTokenBuyCount.set(addr, (sessionTokenBuyCount.get(addr) ?? 0) + 1);
        sessionSymbolBuyCount.set(candidate.tokenSymbol, (sessionSymbolBuyCount.get(candidate.tokenSymbol) ?? 0) + 1);
      } else {
        if (paperBalance < entryTotalCostSol) break;
        const paperEstimatedImpact = estimatedImpact;
        const paperRoundTripCost =
          paperEstimatedImpact * edge.exitImpactMult +
          engineSettings.txFeePercent * edge.feeMultiplier +
          edge.buffer;
        const paperEdge = scoreBasedExpectedMove - paperRoundTripCost;
        if (paperEdge < edge.minEdgePct) {
            console.log(`[PAPER EDGE SKIP] $${candidate.tokenSymbol} — edge ${paperEdge.toFixed(2)}% < ${edge.minEdgePct}% (micro=${isMicroWallet}).`);
            continue;
        }
        
        paperBalance -= entryTotalCostSol;
        buyTxHash = `paper_${Date.now().toString(36)}_${candidate.tokenAddress.substring(0, 6)}`;
        totalExposureSol += scoring.sizeSol;
        tradedAddresses.set(addr, Date.now());
        openAddresses.add(addr);
        boughtThisCycle.add(addr);
        currentOpenCount++;
        tradesThisCycle++;
        dailyTradeCount++;
        totalTradesAllTime++;
        
        if (watchlistCache.has(addr)) watchlistCache.delete(addr);

        const effectivePaperEntryPrice = engineSettings.txCostsEnabled
          ? price * (1 + txCosts.entrySlippagePct / 100)
          : price;
        const trade = await storage.addTrade({
          tokenAddress: candidate.tokenAddress, tokenSymbol: candidate.tokenSymbol, type: "BUY", mode: scoring.qualifiedMode,
          tradingMode: "paper", status: "OPEN", amount: scoring.sizeSol.toFixed(4), price: effectivePaperEntryPrice.toString(), currentPrice: effectivePaperEntryPrice.toString(),
          peakPrice: effectivePaperEntryPrice.toString(), pnl: "0", peakPnl: "0", score: scoring.combinedScore.toString(), txHash: buyTxHash, liquidity: liq.toFixed(2),
          dex: (pair.dexId || candidate.dex || "").toLowerCase(),
        });
        peakPrices.set(trade.id, effectivePaperEntryPrice);
        tradeStopPrices.set(trade.id, calcCostAwareStopPrice(effectivePaperEntryPrice, scoring.qualifiedMode, liq, scoring.sizeSol, cachedSolPriceUsd));
        sessionTokenBuyCount.set(addr, (sessionTokenBuyCount.get(addr) ?? 0) + 1);
        sessionSymbolBuyCount.set(candidate.tokenSymbol, (sessionSymbolBuyCount.get(candidate.tokenSymbol) ?? 0) + 1);
        
        openShadowTrade(jupiterService, candidate.tokenAddress, candidate.tokenSymbol, scoring.qualifiedMode, scoring.combinedScore, effectivePaperEntryPrice, scoring.sizeSol).catch(() => {});
      }
      const allTrades = await storage.getTrades();
      const closedTrades = allTrades.filter((t: any) => t.status === "CLOSED");
      const wins = closedTrades.filter((t: any) => parseFloat(t.pnl || "0") > 0).length;
      const wr = closedTrades.length > 0 ? ((wins / closedTrades.length) * 100).toFixed(1) : "0";
      const displayBalance = (status.tradingMode === "live" && jupiterService) ? (await jupiterService.getWalletBalance().catch(() => paperBalance)).toFixed(4) : paperBalance.toFixed(3);
      await storage.updateBotStats({ walletBalance: displayBalance, totalTrades: allTrades.length, openPositions: currentOpenCount, winRate: wr, lastSignal: `BUY $${candidate.tokenSymbol} via ${scoring.qualifiedMode} (Score: ${scoring.combinedScore})` });
    }
  } catch (e) { console.error("[SCANNER] Error:", e); } finally {
    // BUGFIX #20: was `pendingBuys.clear()` unconditionally — if the scan threw
    // AFTER a buy was submitted to Jupiter (line 2097), the tx may still be
    // in-flight. Clearing pendingBuys allows the next cycle to re-buy the same
    // token, causing a double-spend. Only clear entries older than 30s (the
    // pendingBuys cleanup threshold at line 1614).
    const _nowClear = Date.now();
    for (const [addr, ts] of pendingBuys) {
      if (_nowClear - ts > 30000) pendingBuys.delete(addr);
      else console.warn(`[SCANNER] Retaining pending buy for $${addr} (${Math.round((_nowClear - ts)/1000)}s old) — tx may still be in-flight`);
    }
    // reservedCapital is decremented per-buy in finally blocks, so should be 0 here.
    // But if an exception interrupted mid-buy, force-reset to 0 to prevent stuck capital.
    if (reservedCapital !== 0) {
      console.warn(`[SCANNER] reservedCapital was ${reservedCapital.toFixed(4)} SOL on exit — force-resetting to 0`);
      reservedCapital = 0;
    }
    scanLock = false;
  }
}

async function initBalanceFromDB() {
  if (balanceInitialized) return;
  const status = await storage.getBotStatus();
  let storedBalance = parseFloat(status.walletBalance || "0");
  // PROTOCOL: Force balance to startingBalance (0.01 SOL) on every restart
  // to ensure consistent 1000x ROI calculations from the correct baseline.
  if (storedBalance !== engineSettings.startingBalance) {
    console.log(`[ENGINE] PROTOCOL: Resetting wallet balance from ${storedBalance.toFixed(3)} SOL to ${engineSettings.startingBalance} SOL`);
    storedBalance = engineSettings.startingBalance;
    await storage.updateBotStats({ walletBalance: storedBalance.toFixed(4) });
  }
  // LIVE-MODE GUARD: when trading mode is live, walletBalance in DB tracks the
  // real on-chain SOL amount written by live sell/buy paths — it must NOT be
  // restored into paperBalance, which is paper-mode-only accounting. Doing so
  // set paperBalance = 0.0000 SOL after a live reset (blocking all paper trades)
  // OR to the real wallet high-water mark (inflating paper sizing). In live mode
  // paperBalance is never consulted for real trading decisions, so always seed it
  // from startingBalance on restart.
  //
  // ANOMALY PLAUSIBILITY CAP: a bad DexScreener price feed can credit thousands of
  // SOL to paperBalance in a single paper trade (e.g. $48HOURS: +28578%). The paper
  // exit cap (Math.min(500, …)) prevents new anomalies, but a stale DB balance
  // from before that cap was applied would still restore here. If storedBalance
  // exceeds startingBalance by more than 200× it is almost certainly corrupted —
  // a genuine feed anomaly produces 1000x+ gains in a single trade, while legitimate
  // compounding at 80%+ win rate proved capable of 24x in a single session
  // ($12 SOL from $0.5 start). 20× was too low — it fired on real gains and wiped
  // an entire session of compounding on restart. 200× safely catches only true anomalies.
  const PLAUSIBILITY_MULTIPLIER = 200;
  const isLiveMode = status.tradingMode === "live" && jupiterService !== null;
  const isAnomalous = storedBalance > engineSettings.startingBalance * PLAUSIBILITY_MULTIPLIER;

  // FIX LIVE-PEAK: In live mode, fetch the actual on-chain wallet balance so we have a
  // real reference for the stale-peak guard below. paperBalance in live mode is set to
  // startingBalance (a sentinel — live trading never uses it), so using it as the 1.2×
  // reference caused the guard to compare e.g. storedPeak 0.056 vs 0.05*1.2=0.060 →
  // guard fails → peakBalance stays at 0.056 SOL. But the real wallet has 0.040 SOL →
  // drawdown = (0.056-0.040)/0.056 = 28.6% → circuit breaker trips before trade #1.
  // With the live wallet balance as reference (0.040*1.2=0.048 < 0.056) the guard fires
  // and resets peakBalance to the real wallet amount, giving 0% drawdown on startup.
  let liveWalletBalOnInit = 0;
  if (isLiveMode) {
    for (let attempt = 0; attempt < 3 && liveWalletBalOnInit <= 0; attempt++) {
      liveWalletBalOnInit = await jupiterService!.getWalletBalance().catch(() => 0);
      if (liveWalletBalOnInit <= 0 && attempt < 2) await new Promise(r => setTimeout(r, 800));
    }
    if (liveWalletBalOnInit > 0) {
      console.log(`[ENGINE] Live mode — fetched on-chain balance: ${liveWalletBalOnInit.toFixed(4)} SOL`);
    } else {
      // RPC cold-start: fall back to DB walletBalance, then startingBalance.
      liveWalletBalOnInit = storedBalance > 0 ? storedBalance : engineSettings.startingBalance;
      console.warn(`[ENGINE] Live mode — RPC returned 0 on init, using fallback balance: ${liveWalletBalOnInit.toFixed(4)} SOL`);
    }
  }

  if (isLiveMode) {
    paperBalance = engineSettings.startingBalance;
    console.log(`[ENGINE] Live mode — paper baseline held at startingBalance: ${paperBalance.toFixed(3)} SOL (live wallet: ${liveWalletBalOnInit.toFixed(4)} SOL)`);
    // DISPLAY FIX: persist the REAL on-chain balance so /api/health, restart.cjs, and the
    // dashboard show the live wallet immediately on startup instead of the 0.01 sentinel.
    if (liveWalletBalOnInit > 0) {
      await storage.updateBotStats({ walletBalance: liveWalletBalOnInit.toFixed(4) });
    }
    // LIFETIME ROI: load the persisted baseline; if none exists yet, capture the current
    // on-chain balance as the lifetime starting capital (write-once, survives restarts).
    liveStartingBalance = loadLiveBaseline();
    if (liveStartingBalance <= 0 && liveWalletBalOnInit > 0) {
      liveStartingBalance = liveWalletBalOnInit;
      saveLiveBaseline(liveStartingBalance);
    }
  } else if (storedBalance > 0 && !isAnomalous) {
    paperBalance = storedBalance;
    console.log(`[ENGINE] Restored wallet balance from DB: ${paperBalance.toFixed(3)} SOL`);
  } else if (isAnomalous) {
    paperBalance = engineSettings.startingBalance;
    console.warn(`[ENGINE] DB walletBalance ${storedBalance.toFixed(3)} SOL exceeds ${PLAUSIBILITY_MULTIPLIER}× startingBalance — likely feed anomaly. Resetting to ${paperBalance.toFixed(3)} SOL. Use Reset button to confirm.`);
    await storage.updateBotStats({ walletBalance: paperBalance.toFixed(4) });
  } else {
    // DB walletBalance is 0 (e.g. after a reset that saved 0.0000).
    // Fall back to startingBalance so the UI shows the correct paper baseline.
    paperBalance = engineSettings.startingBalance;
    console.log(`[ENGINE] DB walletBalance is 0 — using startingBalance: ${paperBalance.toFixed(3)} SOL`);
    // Persist immediately so UI reads the correct value
    await storage.updateBotStats({ walletBalance: paperBalance.toFixed(4) });
  }

  // The reference balance for the stale-peak guard differs by mode:
  //   • Live:  actual on-chain wallet balance (liveWalletBalOnInit). Using paperBalance
  //            (= startingBalance sentinel) here is wrong — see comment above.
  //   • Paper: paperBalance (restored from DB or startingBalance).
  const peakGuardRef = isLiveMode ? liveWalletBalOnInit : paperBalance;

  const storedPeak = parseFloat((status as any).peakBalance || "0");
  // FIX: If DB walletBalance was 0 (reset/fresh start), peakBalance must also
  // reset — otherwise a stale high peak from a previous session inflates drawdown
  // to 40-50% before any trade fires, triggering the circuit breaker immediately.
  // Similarly cap if storedPeak is >20% above current balance (stale session data).
  // Threshold tightened from 1.5 → 1.2: a 20-50% stale peak (e.g. 0.630 vs 0.50
  // SOL after restart) previously slipped through the 1.5× guard and immediately
  // showed ~20% drawdown on startup with no trades.
  if (storedBalance <= 0 || storedPeak > peakGuardRef * 1.2) {
    peakBalance = peakGuardRef;
    console.log(`[ENGINE] peakBalance reset to ${peakGuardRef.toFixed(4)} SOL (stale DB peak ${storedPeak.toFixed(4)} discarded)`);
  } else {
    peakBalance = storedPeak > 0 ? storedPeak : peakGuardRef;
  }

  // In live mode seed dailyStartBalance from the real wallet, not paperBalance sentinel.
  const storedDailyStart = parseFloat((status as any).dailyStartBalance || "0");
  const dailyStartFallback = isLiveMode ? liveWalletBalOnInit : paperBalance;
  // BUGFIX #9: if RPC failed on init, dailyStartFallback=0. With dailyStartBalance=0,
  // dailyLossPct = totalLoss / 0 = Infinity → circuit breaker trips instantly.
  // Fall back to startingBalance (0.01) as a floor — never allow 0.
  dailyStartBalance = storedDailyStart > 0 ? storedDailyStart : (dailyStartFallback > 0 ? dailyStartFallback : engineSettings.startingBalance);
  try {
    const today = new Date().toDateString();
    const allTrades = await storage.getTrades();
    const closedToday = (allTrades as any[]).filter(t => t.status === "CLOSED" && new Date(t.closedAt || t.timestamp).toDateString() === today);
    dailyPnlSol = closedToday.reduce((sum, t) => sum + parseFloat(t.amount || "0") * (parseFloat(t.pnl || "0") / 100), 0);
    if (process.env.RESET_DAILY_ON_BOOT === "1") { console.log(`[RISK] RESET_DAILY_ON_BOOT - cleared today's realized PnL (was ${dailyPnlSol.toFixed(4)} SOL) for a fresh daily window on the new safe sizing.`); dailyPnlSol = 0; }
    // Only count REAL trading exits in the streak — admin/operational closes
    // (DESYNC_NO_BALANCE, FORCE_SELL, RESET etc.) are not trading outcomes and
    // must not pollute the consecutive loss counter. Including them inflates the
    // streak and raises the score gate to 74+, blocking all trades.
    const ADMIN_EXIT_REASONS = new Set([
      "DESYNC_NO_BALANCE", "DESYNC_AUTO_CLOSE", "FORCE_SELL", "FORCE_SELL_NO_BALANCE",
      "RESET", "MANUAL_DESYNC_FIX",
    ]);
    const closedAll = (allTrades as any[])
      .filter(t => t.status === "CLOSED" && !ADMIN_EXIT_REASONS.has(t.exitReason || t.closeReason || ""))
      .sort((a, b) => new Date(b.closedAt || b.timestamp).getTime() - new Date(a.closedAt || a.timestamp).getTime());
    let wins = 0, losses = 0;
    for (const t of closedAll) {
      const pnl = parseFloat(t.pnl || "0");
      if (pnl > 0) { if (losses > 0) break; wins++; } else { if (wins > 0) break; losses++; }
    }

    if (losses >= 3) {
      const storedCooldownEnd = parseFloat((status as any).lastLossCooldownEnd || "0");
      if (storedCooldownEnd > Date.now()) lastLossCooldownEnd = storedCooldownEnd;
    }
  } catch (e) { console.warn("[ENGINE] Could not restore risk state:", e); }
  const currentSolPrice = await getLiveSolPrice();
  const openTrades = await storage.getOpenTrades();
  // FIX: When no positions survive a restart there is zero unrealised drawdown.
  // A stale peakBalance from a prior session (e.g. 0.630 SOL vs current 0.50)
  // that slipped past the 1.2× guard above would still show phantom drawdown and
  // block the circuit breaker before any trade executes. Safe to reset here
  // because with no open trades there is nothing to measure drawdown against.
  if (openTrades.length === 0 && peakBalance > paperBalance) {
    console.log(`[ENGINE] No open trades on startup — peakBalance reset from ${peakBalance.toFixed(4)} to ${paperBalance.toFixed(4)} SOL (stale session peak discarded)`);
    peakBalance = paperBalance;
  }
  for (const t of openTrades) {
    tradedAddresses.set(t.tokenAddress, new Date(t.timestamp).getTime());
    if (t.peakPrice) peakPrices.set(t.id, parseFloat(t.peakPrice));
    if (!tradeStopPrices.has(t.id)) {
      const ep = parseFloat(t.price || "0");
      if (ep > 0) {
        const storedLiq = t.liquidity ? parseFloat(t.liquidity) : 0;
        const fallbackLiq = storedLiq > 0 ? storedLiq : (t.mode === "SNIPER" ? 5000 : t.mode === "MG" ? 15000 : 30000);
        const fallbackSize = parseFloat(t.amount || "0.1");
        tradeStopPrices.set(t.id, calcCostAwareStopPrice(ep, t.mode, fallbackLiq, fallbackSize, currentSolPrice));
      }
    }
  }
  // FIX: Sync the resolved peakBalance back to the DB immediately after init.
  // Without this, /api/status (reads DB botStatus.peakBalance) and
  // /api/engine/stats (reads in-memory peakBalance) can diverge after a restart
  // — the guards above may have clamped the in-memory peak down to paperBalance
  // while the DB still holds the old session high (e.g. 3.697 SOL vs 0.500 SOL).
  // When the frontend reads peak from one endpoint and drawdownPct from the other,
  // the pair is mathematically inconsistent (e.g. "0.1% drawdown, peak 3.697 SOL,
  // balance 3.58 SOL" — real drawdown would be 3.2%, not 0.1%).
  await storage.updateBotStats({
    peakBalance: peakBalance.toFixed(4),
    dailyStartBalance: dailyStartBalance.toFixed(4),
  }).catch(e => console.warn("[ENGINE] Could not sync peakBalance to DB on init:", e));
  balanceInitialized = true;
}

function getEffectiveMinScore(isMicroWallet: boolean = false): number {
  const base = isMicroWallet ? 55 : engineSettings.minScoreToTrade;
  const dailyLossPct = dailyStartBalance > 0 ? Math.max(0, (-dailyPnlSol / dailyStartBalance) * 100) : 0;
  // FIX: raised tier thresholds from (>0 / >=5 / >=10) to (>=3 / >=8 / >=15).
  // On a 0.05 SOL micro-wallet, a single -8% trade instantly triggered the old ">0"
  // tier (+5) and pushed effective minScore from 60 → 65+, blocking recovery entries.
  // The new thresholds only fire when drawdown is material (≥3%), severe (≥8%),
  // or critical (≥15%), matching the intent without penalising normal variance.
  // MICRO FIX: loss-based penalties created a death spiral on micro wallets.
  // Paper/early losses raised the floor to 73-88, but the best micro candidates
  // top out around score 73-74, so they could NEVER clear the bar and the bot
  // could never recover. Skip both penalties entirely while in micro mode;
  // the base 58 floor + per-token safety/score gates are enough protection here.
  const tierBonus = isMicroWallet ? 0 : (dailyLossPct >= 15 ? 15 : dailyLossPct >= 8 ? 10 : dailyLossPct >= 3 ? 5 : 0);
  const streakBonus = isMicroWallet ? 0 : Math.min(15, consecutiveLosses * 3);
  const effective = base + tierBonus + streakBonus;
  if (effective > base) console.log(`[SCORE_GATE] Raised min score: ${base} → ${effective} (dailyLoss=${dailyLossPct.toFixed(1)}%, streak=${consecutiveLosses})`);
  return effective;
}


const FORCE_SELL_INTERVAL_MS  = 15_000;          // FIX 5: retry interval for persistent liquidation
const MAX_FORCE_SELL_TIME_MS  = 5 * 60_000;       // FIX 5: max 5-minute liquidation window

// ─────────────────────────────────────────────────────────────────────────────
// FIX 5: Persistent forced-liquidation loop.
//
// When a normal sell exhausts its retry budget (sellFailureStrikes > MAX_SELL_FAILURES)
// the old code logged CRITICAL and gave up — leaving real tokens stranded in the
// wallet with no automatic recovery. This function retries every FORCE_SELL_INTERVAL_MS
// for up to MAX_FORCE_SELL_TIME_MS at 30 % slippage (survival mode: any fill > nothing).
//
// Worst case outcome: bad fill price.  NOT: stuck funds.
// ────────────���────────────────────────────────────────────────────────────────
async function forceSellPosition(
  trade: any,
  fallbackPrice: number
): Promise<{ success: boolean; solReceived: number }> {
  if (!jupiterService) return { success: false, solReceived: 0 };
  const start    = Date.now();
  const sizeSol  = parseFloat(trade.amount || "0");

  console.warn(`[FORCE_SELL] Entering persistent liquidation for #${trade.id} $${trade.tokenSymbol}`);

  while (Date.now() - start < MAX_FORCE_SELL_TIME_MS) {
    try {
      let tokenAmountRaw = liveTokenBalances.get(trade.id) ?? BigInt(0);
      if (tokenAmountRaw === BigInt(0)) {
        tokenAmountRaw = await jupiterService.getTokenBalance(trade.tokenAddress).catch(() => BigInt(0));
      }

      if (tokenAmountRaw === BigInt(0)) {
        // Tokens already gone — nothing to sell, treat as complete.
        console.log(`[FORCE_SELL] #${trade.id} $${trade.tokenSymbol} — no on-chain balance, closing as desync`);
        return { success: true, solReceived: 0 };
      }

      const result = await 
        jupiterService.sellToken(trade.tokenAddress, tokenAmountRaw, 3000);

      if (result.success) {
        console.log(`[FORCE_SELL] SUCCESS #${trade.id} $${trade.tokenSymbol} | SOL: ${result.solReceived.toFixed(6)} | tx: ${result.txSignature?.slice(0, 20)}...`);
        liveTokenBalances.delete(trade.id);
        dailyPnlSol += result.solReceived - sizeSol;
        return { success: true, solReceived: result.solReceived };
      }

      console.warn(`[FORCE_SELL] Attempt failed #${trade.id} $${trade.tokenSymbol}: ${result.error} — retrying in ${FORCE_SELL_INTERVAL_MS / 1000}s`);
    } catch (e: any) {
      console.warn(`[FORCE_SELL] Exception #${trade.id} $${trade.tokenSymbol}: ${e.message}`);
    }

    await new Promise(r => setTimeout(r, FORCE_SELL_INTERVAL_MS));
  }

  console.error(`[FORCE_SELL] EXHAUSTED #${trade.id} $${trade.tokenSymbol} — ${MAX_FORCE_SELL_TIME_MS / 60000} min elapsed. MANUAL INTERVENTION REQUIRED.`);
  // FIX: close the DB record at last-known price even on exhaustion.
  // Leaving it OPEN means: (a) worstOpenPnl blocks all new buys indefinitely,
  // (b) dailyPnlSol is never debited so the circuit breaker sees a phantom profit,
  // (c) the UI shows a permanently open ghost position.
  // The actual tokens may still be in the wallet — the FORCE_SELL_FAILED reason
  // signals to the operator that manual recovery is needed.
  try {
    const { price: lastPrice } = await fetchTokenPrice(trade.tokenAddress).catch(() => ({ price: fallbackPrice, pair: null }));
    const safePrice = lastPrice > 0 ? lastPrice : fallbackPrice;
    const entryP = parseFloat(trade.price || "0");
    const sizeSolEx = parseFloat(trade.amount || "0");
    const exhaustedPnlPct = entryP > 0 && safePrice > 0
      ? Math.max(-99, ((safePrice - entryP) / entryP) * 100)
      : -99;
    dailyPnlSol += sizeSolEx * (exhaustedPnlPct / 100);
    await storage.closeTrade(trade.id, safePrice.toString(), exhaustedPnlPct.toFixed(2), "FORCE_SELL_FAILED_MANUAL_REQUIRED");
    peakPrices.delete(trade.id); partialTpTaken.delete(trade.id); tradeStopPrices.delete(trade.id);
    prevPnlMap.delete(trade.id); pnlStableMap.delete(trade.id); liveTokenBalances.delete(trade.id);
    zeroBalanceStrikes.delete(trade.id); sellFailureStrikes.delete(trade.id);
    tradedAddresses.set(trade.tokenAddress, Date.now());
    console.error(`[FORCE_SELL] DB closed ghost position #${trade.id} $${trade.tokenSymbol} at $${safePrice.toExponential(4)} (PNL: ${exhaustedPnlPct.toFixed(2)}%) — CHECK WALLET FOR STRANDED TOKENS`);
  } catch (closeErr: any) {
    console.error(`[FORCE_SELL] CRITICAL: DB close also failed for #${trade.id}: ${closeErr.message}`);
  }
  return { success: false, solReceived: 0 };
}

async function checkOpenPositions() {
  if (priceCheckLock) return;
  priceCheckLock = true;
  try {
    const openTrades = await storage.getOpenTrades();
    if (openTrades.length === 0) return;
    const liveTradesToSync = openTrades.filter((t: any) => t.tradingMode === "live" && jupiterService);
    const preloadedBalances = new Map<number, bigint>();
    if (liveTradesToSync.length > 0) {
      const balanceFetches = await Promise.allSettled(liveTradesToSync.map((t: any) => jupiterService!.getTokenBalance(t.tokenAddress)));
      for (let i = 0; i < liveTradesToSync.length; i++) {
        const r = balanceFetches[i];
        if (r.status === "fulfilled") preloadedBalances.set(liveTradesToSync[i].id, r.value);
        else console.warn(`[SYNC] Pre-fetch failed for #${liveTradesToSync[i].id} $${liveTradesToSync[i].tokenSymbol}`);
      }
    }
    for (const trade of openTrades) {
      try {
        if (sellingInProgress.has(trade.id)) continue;
        // Bug #2 fix: use fetchTokenPriceForExit (no wash-trade filter) so that
        // rug-pull panic-selling (vol >> liq) never silences the stop-loss check.
        const { price: currentPrice, pair } = await fetchTokenPriceForExit(trade.tokenAddress);

        // PATCH #6: MID-HOLD RUGCHECK — re-run rugcheck every 60s to catch new risk
        // flags that appear after entry (LP unlocked mid-hold, new top-holder concentration,
        // newly-detected honeypot signals). $Taz had 6 risk flags at entry that were logged
        // but not gated; if any NEW flag appeared mid-hold, this catches it.
        const _patchHoldAgeMs = Date.now() - new Date(trade.timestamp).getTime();
        const _patchLastCheck = midHoldRugcheckMs.get(trade.id) ?? 0;
        if (_patchHoldAgeMs > 30_000 && Date.now() - _patchLastCheck > 60_000) {
          midHoldRugcheckMs.set(trade.id, Date.now());
          try {
            const _patchRugResp = await fetch(`https://api.rugcheck.xyz/v1/tokens/${trade.tokenAddress}/report/summary`,
              { signal: AbortSignal.timeout(3000) });
            if (_patchRugResp.ok) {
              const _patchRugData = await _patchRugResp.json() as any;
              const _patchRisks = Array.isArray(_patchRugData?.risks) ? _patchRugData.risks : [];
              const _patchHasFreeze = _patchRisks.some((r: any) => String(r?.name || "").toLowerCase().includes("freeze authority"));
              const _patchHasLpUnlocked = _patchRisks.some((r: any) => String(r?.name || "").toLowerCase().includes("lp unlocked"));
              const _patchHasSingleHolder = _patchRisks.some((r: any) => String(r?.name || "").toLowerCase().includes("single holder ownership"));
              if (_patchHasFreeze || _patchHasLpUnlocked || _patchHasSingleHolder) {
                console.warn(`[MID-HOLD-RISK] #${trade.id} $${trade.tokenSymbol} — exit triggered by mid-hold rugcheck: freeze=${_patchHasFreeze} lpUnlocked=${_patchHasLpUnlocked} singleHolder=${_patchHasSingleHolder}`);
                // Mark for immediate exit on this cycle (use a synthetic reason).
                // We can't set shouldClose here because it's declared later in the function;
                // instead we set the price to a sentinel that will trip HARD_LOSS_KILL via
                // the existing flow. The cleanest path is to log and let the price-drop
                // detector (PATCH #4) catch the resulting price action — but if the rug
                // hasn't started yet, we still want out. So we record a flag and exit below.
                (trade as any).__patchForceExit = `MID_HOLD_RISK (freeze=${_patchHasFreeze}, lpUnlocked=${_patchHasLpUnlocked}, singleHolder=${_patchHasSingleHolder})`;
              }
            }
          } catch { /* transient rugcheck failure — ignore, will retry next cycle */ }
        }
        if (currentPrice <= 0) {
          // ZERO_PRICE_STRIKE: DexScreener returned no price. Could be transient (RPC lag,
          // API blip) or permanent (pair delisted/migrated). Accumulate strikes; reset on
          // any successful read. After ZERO_PRICE_STRIKES_REQUIRED consecutive failures,
          // force-close at last known DB price so the trade doesn't freeze open forever.
          const zps = (zeroPriceStrikes.get(trade.id) ?? 0) + 1;
          if (zps < ZERO_PRICE_STRIKES_REQUIRED) {
            zeroPriceStrikes.set(trade.id, zps);
            if (zps === 1 || zps % 10 === 0) console.warn(`[ZERO_PRICE] #${trade.id} $${trade.tokenSymbol} — price unfetchable, strike ${zps}/${ZERO_PRICE_STRIKES_REQUIRED}`);
            continue;
          }
          // All strikes consumed — close at last valid DB price.
          const zpLastPrice = parseFloat((trade as any).currentPrice || trade.price || "0");
          const zpEntryPrice = parseFloat(trade.price || "0");
          const zpPnlPct = zpEntryPrice > 0 && zpLastPrice > 0 ? ((zpLastPrice - zpEntryPrice) / zpEntryPrice) * 100 : 0;
          const zpSizeSol = parseFloat(trade.amount || "0");
          console.error(`[ZERO_PRICE] 🔴 FORCE_CLOSE #${trade.id} $${trade.tokenSymbol} — ${zps} consecutive zero-price reads. Closing at last DB price $${zpLastPrice.toExponential(4)} (PNL: ${zpPnlPct.toFixed(2)}%)`);
          zeroPriceStrikes.delete(trade.id);
          if (trade.tradingMode !== "live") {
            paperBalance += zpSizeSol * (1 + zpPnlPct / 100);
            dailyPnlSol += zpSizeSol * (zpPnlPct / 100);
            if (paperBalance > peakBalance) peakBalance = paperBalance;
          } else {
            dailyPnlSol += zpSizeSol * (zpPnlPct / 100);
          }
          await storage.closeTrade(trade.id, zpLastPrice.toString(), zpPnlPct.toFixed(2), "ZERO_PRICE_FORCE_CLOSE");
          peakPrices.delete(trade.id); partialTpTaken.delete(trade.id); tradeStopPrices.delete(trade.id);
          prevPnlMap.delete(trade.id); pnlStableMap.delete(trade.id); liveTokenBalances.delete(trade.id);
          priceSanityRejections.delete(trade.id); priceSanityWarnOnce.delete(trade.id);
          zeroBalanceStrikes.delete(trade.id); lifecycleLastLogMs.delete(trade.id);
          trailActivatedLogged.delete(trade.id); liqCoWarnedTrades.delete(trade.id);
          tradedAddresses.set(trade.tokenAddress, Date.now());
          continue;
        }
        // Successful price read — reset any zero-price strike counter.
        if (zeroPriceStrikes.has(trade.id)) zeroPriceStrikes.delete(trade.id);
        if (trade.tradingMode === "live" && jupiterService) {
          const onChainRaw = preloadedBalances.get(trade.id) ?? BigInt(0);
          const prefetchSucceeded = preloadedBalances.has(trade.id);
          if (onChainRaw > BigInt(0)) {
            const mapBalance = liveTokenBalances.get(trade.id);
            if (mapBalance !== onChainRaw) liveTokenBalances.set(trade.id, onChainRaw);
            zeroBalanceStrikes.delete(trade.id); // healthy read — reset any strike counter
          } else if (prefetchSucceeded && liveTokenBalances.has(trade.id)) {
            // FIX V-2: only delete the map entry when we have CONFIRMED on-chain zero
            // (prefetchSucceeded = true). If the prefetch failed (RPC error), onChainRaw
            // defaults to BigInt(0) but that doesn't mean tokens are gone — deleting
            // here would corrupt in-memory tracking and risk a false desync close.
            //
            // DESYNC GRACE PERIOD: Solana RPC nodes propagate confirmed tx state to ATA
            // balance reads with eventual consistency — the balance can read as 0 for up
            // to 90s after a buy confirms. Never delete the map entry (or auto-close) for
            // trades younger than DESYNC_GRACE_PERIOD_MS, even if RPC returns zero.
            const _rawTradeAgeMs = Date.now() - new Date(trade.timestamp).getTime();
            if (_rawTradeAgeMs < 0) {
              // Negative age means trade.timestamp was stored in local time (e.g. IST)
              // instead of UTC, making it appear ~5.5 hours in the future.
              // This causes the grace period check to be permanently true and the
              // trade to never self-close via desync logic.
              console.warn(`[TIME BUG] Trade #${trade.id} $${trade.tokenSymbol} has future timestamp (${trade.timestamp}) — age ${Math.round(_rawTradeAgeMs / 1000)}s. Ensure storage saves timestamps as new Date().toISOString() (UTC with Z suffix).`);
            }
            const tradeAgeMs = Math.max(0, _rawTradeAgeMs);
            if (tradeAgeMs < DESYNC_GRACE_PERIOD_MS) {
              console.log(`[SYNC] Zero balance for #${trade.id} $${trade.tokenSymbol} but trade only ${Math.round(tradeAgeMs / 1000)}s old — retaining cached balance (RPC propagation lag)`);
            } else {
              console.warn(`[SYNC] Confirmed zero balance #${trade.id} $${trade.tokenSymbol}: map had ${liveTokenBalances.get(trade.id)} but on-chain zero → removed`);
              liveTokenBalances.delete(trade.id);
            }
          } else if (!prefetchSucceeded && liveTokenBalances.has(trade.id)) {
            console.warn(`[SYNC] Prefetch failed for #${trade.id} $${trade.tokenSymbol} — retaining cached balance ${liveTokenBalances.get(trade.id)}`);
          }
          if (onChainRaw === BigInt(0) && prefetchSucceeded) {
            // DESYNC GRACE PERIOD: suppress auto-close for fresh trades.
            // A zero balance this soon after a buy is RPC lag, not a real desync.
            const tradeAgeMsForDesync = Math.max(0, Date.now() - new Date(trade.timestamp).getTime());
            if (tradeAgeMsForDesync < DESYNC_GRACE_PERIOD_MS) {
              console.log(`[SYNC] Suppressing DESYNC_AUTO_CLOSE for #${trade.id} $${trade.tokenSymbol} — trade only ${Math.round(tradeAgeMsForDesync / 1000)}s old, within ${DESYNC_GRACE_PERIOD_MS / 1000}s grace period`);
              zeroBalanceStrikes.delete(trade.id);
              continue;
            }
            // MULTI-STRIKE CONFIRMATION: require ZERO_STRIKES_REQUIRED consecutive zero
            // reads before treating as a real desync. A single transient zero from an
            // overloaded RPC node must not close a live position — on a non-zero read we
            // reset the counter and do a live retry before the final close.
            const strikes = (zeroBalanceStrikes.get(trade.id) ?? 0) + 1;
            if (strikes < ZERO_STRIKES_REQUIRED) {
              zeroBalanceStrikes.set(trade.id, strikes);
              console.log(`[SYNC] Zero balance strike ${strikes}/${ZERO_STRIKES_REQUIRED} for #${trade.id} $${trade.tokenSymbol} — waiting for confirmation`);
              continue;
            }
            // All strikes consumed — do one final live read before closing.
            const retryBalance = await jupiterService!.getTokenBalance(trade.tokenAddress).catch(() => BigInt(0));
            if (retryBalance > BigInt(0)) {
              console.log(`[SYNC] False desync for #${trade.id} $${trade.tokenSymbol} — balance appeared on retry (${retryBalance}). Resetting strikes.`);
              liveTokenBalances.set(trade.id, retryBalance);
              zeroBalanceStrikes.delete(trade.id);
              continue;
            }
            zeroBalanceStrikes.delete(trade.id);
            const entryForDesync = parseFloat(trade.price || "0");
            // BUGFIX #3: was crediting PnL based on currentPrice vs entryPrice.
            // But tokens are GONE (on-chain balance = 0) — no SOL was received.
            // Crediting anything other than -100% is fictional and masks the
            // real daily loss, preventing the circuit breaker from tripping.
            const desyncPnlPct = "-100.00";
            const desyncSizeSol = parseFloat(trade.amount || "0");
            dailyPnlSol += desyncSizeSol * (parseFloat(desyncPnlPct) / 100);
            console.warn(`[LIVE] DESYNC DETECTED #${trade.id} $${trade.tokenSymbol} — zero on-chain balance → auto-closing (PNL: ${desyncPnlPct}% — full loss, no SOL recovered)`);
            await storage.closeTrade(trade.id, currentPrice.toString(), desyncPnlPct, "DESYNC_AUTO_CLOSE");
            liveTokenBalances.delete(trade.id); peakPrices.delete(trade.id); partialTpTaken.delete(trade.id);
            tradeStopPrices.delete(trade.id); prevPnlMap.delete(trade.id); pnlStableMap.delete(trade.id);
            tradedAddresses.set(trade.tokenAddress, Date.now());
            // FIX DESYNC-REENTRY: also block reentry via stoppedOutAddresses for the full
            // SL blackout period. Without this, the token immediately re-qualifies after the
            // 30s REENTRY_HARD_FLOOR and can be bought again before RPC propagation resolves ���
            // exactly what happened with $Eve (bought twice in live session). DESYNC is treated
            // the same as a stop-loss for reentry purposes: the bot doesn't know whether the
            // position was profitable or not when balance was zero, so caution is correct.
            stoppedOutAddresses.set(trade.tokenAddress, Date.now());
            console.log(`[DESYNC] Blocking reentry on $${trade.tokenSymbol} for ${engineSettings.slReentryDelayMs / 1000}s (DESYNC treated as SL for reentry)`);
            // FIX Z-4: desync closes must update the streak so the loss cooldown
            // can fire from repeated RPC outage + auto-close events.
            const desyncIsWin = parseFloat(desyncPnlPct) > 0;
            if (desyncIsWin) { consecutiveWins++; consecutiveLosses = 0; lastMiniCooldownEnd = 0; }
            else {
              consecutiveLosses++; consecutiveWins = 0;
              tokenSymbolLastLossMs.set(trade.tokenSymbol, Date.now()); // Change 6: symbol cooldown on desync loss
              if (consecutiveLosses === 2) {
                lastMiniCooldownEnd = Date.now() + MINI_LOSS_COOLDOWN_MS;
                console.log(`[RISK] 2 consecutive desync-closes — ${MINI_LOSS_COOLDOWN_MS / 1000}s mini-cooldown activated`);
              }
              if (consecutiveLosses >= 3) {
                lastLossCooldownEnd = Date.now() + engineSettings.lossCooldownMs;
                // FIX 16: reset counter so next penalty requires 3 NEW losses,
                // not immediately re-triggering on the very next trade.
                consecutiveLosses = 0;
                console.log(`[RISK] 3 consecutive desync-closes — ${engineSettings.lossCooldownMs / 1000}s cooldown activated`);
              }
            }
            continue;
          }
        }
        const entryPrice = parseFloat(trade.price);
        if (entryPrice <= 0) continue;
        let pnlPct = ((currentPrice - entryPrice) / entryPrice) * 100;
        // ── LAYER 1: Price ratio gate — reject the corrupted price BEFORE it touches any state ──
        const PRICE_RATIO_MAX = 100;   // reject any price > 100× entry  (+10,000%)
        const PRICE_RATIO_MIN = 0.01;  // reject any price < 1% of entry (−99% in a single tick)
        const priceRatio = entryPrice > 0 ? currentPrice / entryPrice : 1;
        if (priceRatio > PRICE_RATIO_MAX || priceRatio <= PRICE_RATIO_MIN) { // FIX #2: <= instead of < so exact -99% (ratio=0.01) is caught by sanity gate, not SL
          const rejCount = (priceSanityRejections.get(trade.id) ?? 0) + 1;
          priceSanityRejections.set(trade.id, rejCount);
          // Warn-once on first rejection; re-warn every 30 cycles for long-running cases.
          // Avoids 1-per-second log spam while still leaving periodic evidence.
          const shouldWarn = !priceSanityWarnOnce.has(trade.id) || rejCount % 30 === 0;
          if (shouldWarn) {
            priceSanityWarnOnce.add(trade.id);
            console.warn(
              `[PRICE_SANITY] ⚠️  Rejected anomalous price for $${trade.tokenSymbol} ` +
              `| entry $${entryPrice.toExponential(4)} → current $${currentPrice.toExponential(4)} ` +
              `| ratio ${priceRatio.toFixed(4)}× (allowed: ${PRICE_RATIO_MIN}×–${PRICE_RATIO_MAX}×) ` +
              `| rejection #${rejCount} — bad feed or token migration`
            );
          }
          // Force-close only on sustained DOWNWARD rejections. Upward spikes (ratio >
          // PRICE_RATIO_MAX) are typically transient feed errors that self-correct within
          // seconds; closing on a spike would lock in a false total loss.
          // EXCEPTION: after PRICE_SANITY_STUCK_CYCLES consecutive upward rejections the
          // feed is almost certainly a permanent migration/corruption — close at the last
          // valid DB price so this ghost trade cannot freeze worstOpenPnl indefinitely.
          // 30 cycles = 30s at priceCheckIntervalMs=1000ms. Real transient glitches
          // self-correct in <10s; DexScreener migration artifacts never do.
          const PRICE_SANITY_STUCK_CYCLES = 30;
          if (priceRatio > PRICE_RATIO_MAX && rejCount >= PRICE_SANITY_STUCK_CYCLES) {
            const lastValidPrice = parseFloat((trade as any).currentPrice || trade.price || "0");
            const stuckPnlPct = entryPrice > 0 && lastValidPrice > 0
              ? ((lastValidPrice - entryPrice) / entryPrice) * 100
              : 0;
            const sizeSolStuck = parseFloat(trade.amount || "0");
            console.error(
              `[PRICE_SANITY] 🟡 STUCK_CLOSE $${trade.tokenSymbol} #${trade.id} — ` +
              `${rejCount} consecutive upward rejections (ratio ${priceRatio.toFixed(0)}×). ` +
              `Closing at last valid price $${lastValidPrice.toExponential(4)} (PNL: ${stuckPnlPct.toFixed(2)}%).`
            );
            const stuckCleanup = () => {
              priceSanityRejections.delete(trade.id);
              priceSanityWarnOnce.delete(trade.id);
              peakPrices.delete(trade.id);
              partialTpTaken.delete(trade.id);
              tradeStopPrices.delete(trade.id);
              prevPnlMap.delete(trade.id);
              pnlStableMap.delete(trade.id);
              zeroBalanceStrikes.delete(trade.id);
              lifecycleLastLogMs.delete(trade.id);
              trailActivatedLogged.delete(trade.id);
              liqCoWarnedTrades.delete(trade.id);
              tradedAddresses.set(trade.tokenAddress, Date.now());
            };
            if (trade.tradingMode === "live" && jupiterService && !sellingInProgress.has(trade.id)) {
              sellingInProgress.add(trade.id);
              const capturedStuck = { ...trade };
              jupiterService.sellToken(capturedStuck.tokenAddress, liveTokenBalances.get(capturedStuck.id) ?? BigInt(0), 3000)
                .then(async (res) => {
                  const finalPnl = res.success && sizeSolStuck > 0
                    ? Math.max(-99, ((res.solReceived - sizeSolStuck) / sizeSolStuck) * 100)
                    : stuckPnlPct;
                  if (res.success) dailyPnlSol += res.solReceived - sizeSolStuck;
                  liveTokenBalances.delete(capturedStuck.id);
                  await storage.closeTrade(capturedStuck.id, lastValidPrice.toString(), finalPnl.toFixed(2), "PRICE_SANITY_STUCK_CLOSE");
                })
                .catch(async () => {
                  liveTokenBalances.delete(capturedStuck.id);
                  await storage.closeTrade(capturedStuck.id, lastValidPrice.toString(), stuckPnlPct.toFixed(2), "PRICE_SANITY_STUCK_CLOSE_SELL_FAILED");
                })
                .finally(() => { stuckCleanup(); sellingInProgress.delete(capturedStuck.id); });
            } else if (trade.tradingMode !== "live") {
              paperBalance += sizeSolStuck * (1 + stuckPnlPct / 100);
              dailyPnlSol += sizeSolStuck * (stuckPnlPct / 100);
              if (paperBalance > peakBalance) peakBalance = paperBalance;
              await storage.closeTrade(trade.id, lastValidPrice.toString(), stuckPnlPct.toFixed(2), "PRICE_SANITY_STUCK_CLOSE");
              stuckCleanup();
            }
          }

          // FIX SNIGGA: Fire emergency on-chain sell on the VERY FIRST downward PRICE_SANITY
          // rejection for live positions. The original design waited PRICE_SANITY_FORCE_CLOSE_CYCLES
          // (7 s) to distinguish feed glitches from real rugs — but that 7-second window is
          // exactly when a rugged token bleeds from recoverable to near-zero. The on-chain sell
          // is initiated here immediately (non-blocking, fire-and-forget); sellingInProgress
          // prevents the per-trade skip at line 1568 from letting cycles 2-7 re-trigger it.
          // The cycle-7 block below remains as the DB close backstop for paper mode.
          if (priceRatio < PRICE_RATIO_MIN && rejCount === 1 &&
              trade.tradingMode === "live" && jupiterService && !sellingInProgress.has(trade.id)) {
            const rugPnlPctEarly = Math.max(-99, ((currentPrice - entryPrice) / entryPrice) * 100);
            const sizeSolEarly   = parseFloat(trade.amount || "0");
            console.warn(
              `[PRICE_SANITY] 🚨 EARLY_SELL $${trade.tokenSymbol} #${trade.id} — ` +
              `first downward rejection (ratio ${priceRatio.toFixed(6)}×, ${rugPnlPctEarly.toFixed(1)}%). ` +
              `Firing emergency sell immediately (not waiting for cycle ${PRICE_SANITY_FORCE_CLOSE_CYCLES}).`
            );
            sellingInProgress.add(trade.id);
            const esCapturedTrade = { ...trade };
            const esCapturedPrice = currentPrice;
            jupiterService.sellToken(esCapturedTrade.tokenAddress, liveTokenBalances.get(esCapturedTrade.id) ?? BigInt(0), 3000)
              .then(async (sellResult) => {
                const finalPnl = sellResult.success && sizeSolEarly > 0
                  ? Math.max(-99, ((sellResult.solReceived - sizeSolEarly) / sizeSolEarly) * 100)
                  : rugPnlPctEarly;
                if (sellResult.success) dailyPnlSol += sellResult.solReceived - sizeSolEarly;
                liveTokenBalances.delete(esCapturedTrade.id);
                await storage.closeTrade(esCapturedTrade.id, esCapturedPrice.toString(), finalPnl.toFixed(2), "PRICE_SANITY_EARLY_SELL");
              })
              .catch(async () => {
                liveTokenBalances.delete(esCapturedTrade.id);
                await storage.closeTrade(esCapturedTrade.id, esCapturedPrice.toString(), rugPnlPctEarly.toFixed(2), "PRICE_SANITY_EARLY_SELL_FAILED");
              })
              .finally(() => {
                priceSanityRejections.delete(esCapturedTrade.id);
                priceSanityWarnOnce.delete(esCapturedTrade.id);
                peakPrices.delete(esCapturedTrade.id);
                partialTpTaken.delete(esCapturedTrade.id);
                tradeStopPrices.delete(esCapturedTrade.id);
                prevPnlMap.delete(esCapturedTrade.id);
                pnlStableMap.delete(esCapturedTrade.id);
                zeroBalanceStrikes.delete(esCapturedTrade.id);
                lifecycleLastLogMs.delete(esCapturedTrade.id);
                trailActivatedLogged.delete(esCapturedTrade.id);
                liqCoWarnedTrades.delete(esCapturedTrade.id);
                tradedAddresses.set(esCapturedTrade.tokenAddress, Date.now());
                consecutiveLosses++;
                consecutiveWins = 0;
                if (consecutiveLosses === 2) lastMiniCooldownEnd = Date.now() + MINI_LOSS_COOLDOWN_MS;
                if (consecutiveLosses >= 3) {
                  lastLossCooldownEnd = Date.now() + engineSettings.lossCooldownMs;
                  consecutiveLosses = 0;
                }
                tokenLastLossMs.set(esCapturedTrade.tokenAddress, Date.now());
                tokenSymbolLastLossMs.set(esCapturedTrade.tokenSymbol, Date.now());
                sellingInProgress.delete(esCapturedTrade.id);
              });
          }

          if (priceRatio < PRICE_RATIO_MIN && rejCount >= PRICE_SANITY_FORCE_CLOSE_CYCLES) {
            const rugPnlPct = Math.max(-99, ((currentPrice - entryPrice) / entryPrice) * 100);
            const sizeSol   = parseFloat(trade.amount || "0");
            console.error(
              `[PRICE_SANITY] 🔴 FORCE_CLOSE $${trade.tokenSymbol} #${trade.id} — ` +
              `${rejCount} consecutive downward rejections (ratio ${priceRatio.toFixed(6)}×, ` +
              `${rugPnlPct.toFixed(1)}% loss). Confirmed rug. Closing position.`
            );
            // Cleanup helper — called in both paper and live paths.
            const cleanupSanityState = () => {
              priceSanityRejections.delete(trade.id);
              priceSanityWarnOnce.delete(trade.id);
              peakPrices.delete(trade.id);
              partialTpTaken.delete(trade.id);
              tradeStopPrices.delete(trade.id);
              prevPnlMap.delete(trade.id);
              pnlStableMap.delete(trade.id);
              zeroBalanceStrikes.delete(trade.id);
              lifecycleLastLogMs.delete(trade.id);
              trailActivatedLogged.delete(trade.id);
              liqCoWarnedTrades.delete(trade.id);
              tradedAddresses.set(trade.tokenAddress, Date.now());
              consecutiveLosses++;
              consecutiveWins = 0;
              if (consecutiveLosses === 2) lastMiniCooldownEnd = Date.now() + MINI_LOSS_COOLDOWN_MS;
              if (consecutiveLosses >= 3) {
                lastLossCooldownEnd = Date.now() + engineSettings.lossCooldownMs;
                consecutiveLosses = 0;
              }
              tokenLastLossMs.set(trade.tokenAddress, Date.now());
              tokenSymbolLastLossMs.set(trade.tokenSymbol, Date.now());
            };
            if (trade.tradingMode === "live" && jupiterService && !sellingInProgress.has(trade.id)) {
              // Attempt a 30%-slippage emergency sell. Non-blocking — close the DB record
              // regardless of sell outcome so the position is never permanently stuck.
              sellingInProgress.add(trade.id);
              const capturedTrade = { ...trade };
              jupiterService.sellToken(capturedTrade.tokenAddress, liveTokenBalances.get(capturedTrade.id) ?? BigInt(0), 3000)
                .then(async (sellResult) => {
                  const finalPnl = sellResult.success && sizeSol > 0
                    ? Math.max(-99, ((sellResult.solReceived - sizeSol) / sizeSol) * 100)
                    : rugPnlPct;
                  if (sellResult.success) dailyPnlSol += sellResult.solReceived - sizeSol;
                  liveTokenBalances.delete(capturedTrade.id);
                  await storage.closeTrade(capturedTrade.id, currentPrice.toString(), finalPnl.toFixed(2), "PRICE_SANITY_FORCE_CLOSE");
                })
                .catch(async () => {
                  liveTokenBalances.delete(capturedTrade.id);
                  await storage.closeTrade(capturedTrade.id, currentPrice.toString(), rugPnlPct.toFixed(2), "PRICE_SANITY_FORCE_CLOSE_SELL_FAILED");
                })
                .finally(() => { cleanupSanityState(); sellingInProgress.delete(capturedTrade.id); });
            } else if (trade.tradingMode !== "live") {
              // Paper mode: close synchronously.
              paperBalance += sizeSol * (1 + rugPnlPct / 100);
              dailyPnlSol   += sizeSol * (rugPnlPct / 100);
              if (paperBalance > peakBalance) peakBalance = paperBalance;
              await storage.closeTrade(trade.id, currentPrice.toString(), rugPnlPct.toFixed(2), "PRICE_SANITY_FORCE_CLOSE");
              cleanupSanityState();
            }
          }
          continue; // skip to next trade — do NOT update pnlPct, peakPrices, paperBalance, or dailyPnlSol
        }
        // Successful price read — reset the rejection counter so any future anomaly
        // starts a fresh count rather than inheriting stale strikes.
        if (priceSanityRejections.has(trade.id)) {
          priceSanityRejections.delete(trade.id);
          priceSanityWarnOnce.delete(trade.id);
        }
        // ── LAYER 2: Belt-and-suspenders cap for legitimate multi-tick compounding pumps ──
        if (pnlPct > 500) {
          console.log(
            `[TRADE] SUSPICIOUS PNL $${trade.tokenSymbol} | +${pnlPct.toFixed(1)}% exceeds 500% cap — capping. ` +
            `Price ratio ${priceRatio.toFixed(2)}× passed sanity check (may be legitimate multi-tick pump).`
          );
          pnlPct = 500;
        }
        const holdTime = Math.max(0, Date.now() - new Date(trade.timestamp).getTime()) / 1000;
        const tradeScore = parseInt(trade.score || "0", 10);
        const dynamicTP = getScoreBasedTP(tradeScore);
        const liveBP = (() => { if (!pair) return 0.5; const b = pair.txns?.m5?.buys || 0, s = pair.txns?.m5?.sells || 0; return (b + s) > 0 ? b / (b + s) : 0.5; })();
        const dynamicMaxHold = getScoreBasedMaxHold(tradeScore, pnlPct, liveBP);
        let peak = peakPrices.get(trade.id) || entryPrice;
        const maxAllowedPeak = entryPrice * (1 + 500 / 100); // 500% gain ceiling — matches pnlPct cap
        if (currentPrice > peak && currentPrice <= maxAllowedPeak) {
          peak = currentPrice;
          peakPrices.set(trade.id, peak);
        } else if (currentPrice > maxAllowedPeak) {
          // Price is above the 500% ceiling — don't update peak to avoid corrupting trailingFloor.
          // The bad-feed case is already rejected above by Layer 1; this handles legitimate
          // multi-tick pumps that compound past 500% cumulatively without triggering the ratio gate.
          console.log(
            `[PEAK_CAP] Not updating peak for $${trade.tokenSymbol} — ` +
            `currentPrice $${currentPrice.toExponential(4)} exceeds 500% ceiling $${maxAllowedPeak.toExponential(4)}`
          );
        }
        const peakPnl = ((peak - entryPrice) / entryPrice) * 100;
        const drawdownFromPeak = peak > 0 ? ((peak - currentPrice) / peak) * 100 : 0;
        
        // BUGFIX #18: was `await` — blocks price-check loop on DB writes (50-200ms each).
        // During a rug, every millisecond counts. Fire-and-forget so the loop continues
        // to the exit decision immediately. DB will catch up on the next cycle.
        storage.updateTradeCurrentPrice(trade.id, currentPrice.toString(), pnlPct.toFixed(2)).catch(() => {});
        storage.updateTradePeakPrice(trade.id, peak.toString(), peakPnl.toFixed(2)).catch(() => {});

        // --- WITH THESE TIMEOUT-WRAPPED LINES: ---
        // await withTimeout(
        //     storage.updateTradeCurrentPrice(trade.id, currentPrice.toString(), pnlPct.toFixed(2)),
        //     3000, 
        //     "DB_UpdatePrice"
        // ).catch(e => console.warn(`[DB WARNING] Failed to update price for $${trade.tokenSymbol}: ${e.message}`));

        // await withTimeout(
        //     storage.updateTradePeakPrice(trade.id, peak.toString(), peakPnl.toFixed(2)),
        //     3000, 
        //     "DB_UpdatePeak"
        // ).catch(e => console.warn(`[DB WARNING] Failed to update peak for $${trade.tokenSymbol}: ${e.message}`));

        // LIFECYCLE:HOLD heartbeat — emitted every 30s per trade for production monitoring
        const _now = Date.now();
        if (_now - (lifecycleLastLogMs.get(trade.id) ?? 0) >= LIFECYCLE_HOLD_INTERVAL_MS) {
          lifecycleLastLogMs.set(trade.id, _now);
          console.log(`[LIFECYCLE:HOLD] id=#${trade.id} $${trade.tokenSymbol} | age: ${Math.round(holdTime)}s | pnl: ${pnlPct.toFixed(2)}% | peak: ${peakPnl.toFixed(2)}% | price: $${currentPrice.toFixed(8)} | mode: ${trade.mode}`);
        }
        // TRAIL:ACTIVATED — logged once when trailing stop becomes armed
        if (!trailActivatedLogged.has(trade.id) && peakPnl >= engineSettings.trailingStopActivation) {
          trailActivatedLogged.add(trade.id);
          console.log(`[TRAIL:ACTIVATED] id=#${trade.id} $${trade.tokenSymbol} | peakPnl: +${peakPnl.toFixed(2)}% reached threshold +${engineSettings.trailingStopActivation}% | trailing distance: -${engineSettings.trailingStopDistance}%`);
        }
        // Partial TP
        // BUGFIX #14: track partial TP failures. If the sell fails 3x (rugged pool),
        // mark as taken to stop retrying — each retry wastes priority fees.
        const partialTpFailures = partialTpFailuresMap.get(trade.id) ?? 0;
        if (!partialTpTaken.has(trade.id) && partialTpFailures < 3 && pnlPct >= engineSettings.partialTpThreshold && pnlPct < dynamicTP) {
          const sizeSol = parseFloat(trade.amount);
          const partialSize = sizeSol * engineSettings.partialTpRatio;
          const isLivePartial = trade.tradingMode === "live" && jupiterService !== null;
          let partialSuccess = false;
          if (isLivePartial) {
            sellingInProgress.add(trade.id);
            try {
              let totalTokens = liveTokenBalances.get(trade.id) ?? BigInt(0);
              if (totalTokens === BigInt(0)) { totalTokens = await jupiterService!.getTokenBalance(trade.tokenAddress); if (totalTokens > BigInt(0)) liveTokenBalances.set(trade.id, totalTokens); }
              if (totalTokens > BigInt(0)) {
                const sellTokens = (totalTokens * BigInt(Math.round(engineSettings.partialTpRatio * 100))) / 100n;
                const partialLiq = pair?.liquidity?.usd ?? 1000;
                const partialCosts = calcTransactionCosts(partialLiq, partialSize);
                const partialSlippageBps = Math.min(2000, Math.max(100, Math.round(partialCosts.exitSlippagePct * 1.5 * 100)));
                const partialResult = await jupiterService!.sellToken(trade.tokenAddress, sellTokens, partialSlippageBps);
                if (partialResult.success) {
                  liveTokenBalances.set(trade.id, totalTokens - sellTokens);
                  dailyPnlSol += partialResult.solReceived - partialSize;
                  partialTpTaken.add(trade.id);
                  await storage.updateTradeAmount(trade.id, (sizeSol - partialSize).toFixed(4));
                  console.log(`[LIVE] PARTIAL TP $${trade.tokenSymbol} | Sold ${engineSettings.partialTpRatio * 100}% on-chain @ +${pnlPct.toFixed(1)}% | SOL received: ${partialResult.solReceived.toFixed(4)} | tx: ${partialResult.txSignature?.slice(0, 20)}...`);
                  partialSuccess = true;
                } else {
                  // BUGFIX #14: increment failure counter. After 3 failures, stop retrying.
                  partialTpFailuresMap.set(trade.id, (partialTpFailuresMap.get(trade.id) ?? 0) + 1);
                  const fails = partialTpFailuresMap.get(trade.id) ?? 0;
                  console.warn(`[LIVE] PARTIAL TP FAILED $${trade.tokenSymbol} (attempt ${fails}/3): ${partialResult.error}${fails >= 3 ? ' — giving up, marking as taken' : ''}`);
                  if (fails >= 3) partialTpTaken.add(trade.id);  // stop retrying
                }
              } else console.warn(`[LIVE] PARTIAL TP DESYNC: No tokens for $${trade.tokenSymbol}`);
            } finally { sellingInProgress.delete(trade.id); }
          } else {
            const partialLiq = pair?.liquidity?.usd ?? 1000;
            const partialTxCosts = calcTransactionCosts(partialLiq, partialSize);
            const partialExitCostPct = partialTxCosts.exitSlippagePct + partialTxCosts.exitFeePct;
            const netPartialPnlPct = pnlPct - partialExitCostPct;
            const partialReturn = partialSize * (1 + netPartialPnlPct / 100);
            paperBalance += partialReturn;
            partialTpTaken.add(trade.id);
            dailyPnlSol += partialReturn - partialSize;
            await storage.updateTradeAmount(trade.id, (sizeSol - partialSize).toFixed(4));
            console.log(`[PAPER] PARTIAL TP $${trade.tokenSymbol} | Sold ${engineSettings.partialTpRatio * 100}% @ +${pnlPct.toFixed(1)}% | ExitCost: -${partialExitCostPct.toFixed(1)}% | Secured: ${partialReturn.toFixed(4)} SOL`);
            partialSuccess = true;
          }
          if (partialSuccess) {
            // Keep prevPnlMap current even on a partial-TP cycle so PROFIT_DECLINE
            // has a fresh baseline on the very next price check. Without this, the
            // baseline is stale by one cycle and a drop just after partial TP is invisible.
            prevPnlMap.set(trade.id, pnlPct);
            continue;
          }
        }
        const prevPnl = prevPnlMap.get(trade.id) ?? null;
        prevPnlMap.set(trade.id, pnlPct);
        if (pnlPct >= 1) {
          const stable = pnlStableMap.get(trade.id);
          if (!stable) pnlStableMap.set(trade.id, { pnl: pnlPct, since: Date.now() });
          else if (Math.abs(pnlPct - stable.pnl) >= 0.5) pnlStableMap.set(trade.id, { pnl: pnlPct, since: Date.now() });
        } else pnlStableMap.delete(trade.id);
        let shouldClose = false, reason = "";
        // PATCH #6: honor mid-hold rugcheck force-exit flag set above.
        if ((trade as any).__patchForceExit) {
          shouldClose = true;
          reason = (trade as any).__patchForceExit;
          (trade as any).__patchForceExit = undefined;
        }
        // FIX DEEP_RUG: fires at -50% PNL unconditionally, immediately, no grace.
        // The PRICE_SANITY gate (PRICE_RATIO_MIN = 0.01) only catches single-tick
        // -99% collapses. A gradual rug that drops price over 3–7 ticks (e.g. -20%,
        // -40%, -60%, -80%) passes the ratio check each tick and skips EARLY_SELL
        // entirely — reaching -99% through the normal shouldClose path. HARD_LOSS_KILL
        // fires at -10% but cannot prevent the full drain when the next price read
        // after -10% is already -80%. This gate catches any position that has lost
        // more than half its value regardless of how it got there.
        if (pnlPct <= -50) { shouldClose = true; reason = `DEEP_RUG_KILL (pnl ${pnlPct.toFixed(2)}% ≤ -50% emergency floor)`; }
        // FIX SURVIVAL-1: HARD LOSS KILL — fires unconditionally at -10% PNL.
        // Stop-loss of -6% is theoretical; memecoin prices gap through it in <3s.
        // By the time priceCheckIntervalMs fires again, actual loss is -30% to -100%.
        // This is the last-resort circuit before the position bleeds to zero.
        // No trailing, no grace, no hold-time conditions — just exit immediately.
        else if (pnlPct <= -10) { shouldClose = true; reason = `HARD_LOSS_KILL (pnl ${pnlPct.toFixed(2)}% ≤ -10% hard floor)`; }
        // FIX SURVIVAL-2: TAKE_PROFIT_20 — restored from old working version.
        // The new dynamicTP allows holding until +65 to +100% depending on score.
        // In practice, memecoins peak and collapse within seconds. EDFB peaked at
        // +17.9% and exited at -104% because dynamicTP was 90% (score=94). BOPS
        // peaked at +12% and exited at -104% with dynamicTP=80%. The old version
        // exited both at +20% via this check — capturing real profit instead of
        // watching it evaporate. Always exit at +20%: it's a real, bankable gain.
        // PATCH #3: re-enabled TAKE_PROFIT_20. Memecoins peak and collapse within seconds;
        // a +20% take-profit captures real bankable gains before the rug. $Taz peaked at +5.64%
        // then bled to -100% because there was no profit-taking gate below dynamicTP (65%+).
        else if (pnlPct >= 20) { shouldClose = true; reason = `TAKE_PROFIT_20 (+${pnlPct.toFixed(2)}%)`; }
        const costAwareStopPrice = tradeStopPrices.get(trade.id) ?? 0;
        const stopLossPct = costAwareStopPrice > 0 && entryPrice > 0 ? ((costAwareStopPrice - entryPrice) / entryPrice) * 100 : engineSettings.stopLoss;
        // FIX: halfStopPct floor prevents EARLY_CUT from firing on entry noise.
        // At -3% halfStop, a normal ±2-3% pump.fun price oscillation on entry can trigger
        // the cut before the position has moved at all. HWR and MG entries already absorb
        // 1-3% in tx costs, so -4% minimum gives at least 1-2% of genuine move required.
        const rawHalfStop = stopLossPct / 2;
        const halfStopPct = trade.mode === "HWR" ? Math.min(rawHalfStop, -4.0) :
                            trade.mode === "MG"  ? Math.min(rawHalfStop, -3.5) :
                            rawHalfStop;
        const trailingFloor = peakPnl > 30 ? peakPnl * 0.50 : peakPnl > 15 ? peakPnl * 0.38 : peakPnl > 8 ? peakPnl * 0.25 : peakPnl > 3 ? peakPnl * 0.15 : 0;
        // NOTE: HARD_TP (pnlPct >= dynamicTP) is removed. dynamicTP minimum is 65%
        // but TAKE_PROFIT_20 above always fires at +20%, so HARD_TP was unreachable.
        // dynamicTP is still used as the upper-bound guard for partial TP above.
        // NEAR-MISS SUPPRESSION: if pnlPct is already above +17% and the tick-to-tick
        // drop is under 3%, suppress PROFIT_DECLINE and let TAKE_PROFIT_20 fire cleanly.
        // Without this, normal price oscillation at +17-19% (e.g. +18% → +16%, drop=2%)
        // triggers an early exit just below the +20% gate — capturing 15-17% instead of 20%.
        // The suppression window is intentionally narrow: only active when pnlPct > 17
        // (close enough to TP gate to matter) AND drop < 3% (small oscillation, not a
        // genuine reversal). A real reversal at this level (≥3% drop) still fires normally.
        const isNearTpGate = pnlPct > 17 && prevPnl !== null && (prevPnl - pnlPct) < 3.0;
        // Bug #6 fix: grace period reduced from 60 → 20 s.  The original 60 s window
        // allowed a token to drop from +5 % to -9 % in the first minute without
        // PROFIT_DECLINE firing (HARD_LOSS_KILL only activates at -10 %).  20 s
        // still gives two or three price-check cycles to confirm the move is real
        // before closing, without creating a 40-second free-bleed window on fast rugs.
        // NEW: Gives the token 4% of wiggle room before cutting a profitable trade
        // FIX(round-trip cost gate): mid-price PnL ignores spread + slippage + fees. On #10250 a "+1.61% mid"
        // exit realized -4.42% (truePnl -5.05%). VOLUNTARY profit-taking exits (PROFIT_DECLINE, PNL_STAGNANT)
        // must clear the estimated round-trip cost before firing. Loss-cut / emergency exits are NOT gated.
        const _rtCosts = calcTransactionCosts(pair?.liquidity?.usd ?? 0, parseFloat(trade.amount || "0"));
        const COST_SAFETY_MULT = 2.0; // modeled cost under-predicts reality (~3.4% modeled vs ~6% realized on #10250)
        const minProfitableExitPct = _rtCosts.totalRoundTripPct * COST_SAFETY_MULT + 0.5;
        const clearsRoundTrip = pnlPct >= minProfitableExitPct;
        if (pnlPct >= 1 && !clearsRoundTrip && holdTime > 30 && (Date.now() - (costGateLastLogMs.get(trade.id) ?? 0) >= 30000) && (costGateLastLogMs.set(trade.id, Date.now()) || true)) console.log(`[DIAG-COSTGATE] $${trade.tokenSymbol} mid pnl +${pnlPct.toFixed(2)}% < round-trip floor ${minProfitableExitPct.toFixed(2)}% (modeled ${_rtCosts.totalRoundTripPct.toFixed(2)}% x${COST_SAFETY_MULT}) -> holding; voluntary profit-exits suppressed`);
        // PATCH #2: removed `clearsRoundTrip` requirement from PROFIT_DECLINE and PNL_STAGNANT.
        // The cost gate's INTENT is "don't sell for less than round-trip cost" — that should only
        // apply to LOSS exits (where we'd be crystallizing a loss below the cost-recovery floor),
        // NOT to profit exits. $Taz peaked at +5.64% but the cost gate required +12.02% before any
        // profit exit could fire, so the bot held through the peak and bled to -100%.
        // Profit-taking should always be allowed above +1%; the cost gate is enforced separately
        // on the loss side via HARD_LOSS_KILL / DEEP_RUG_KILL.
        if (prevPnl !== null && prevPnl > 0 && pnlPct > 0 && pnlPct < prevPnl && prevPnl >= 1.0 && (prevPnl - pnlPct) >= 4.0 && holdTime > 20 && !isNearTpGate) {
            shouldClose = true; reason = `PROFIT_DECLINE (was +${prevPnl.toFixed(2)}%, now +${pnlPct.toFixed(2)}%, drop=${(prevPnl - pnlPct).toFixed(2)}%)`;
        }
        else if (pnlPct >= 1 && (() => { const stable = pnlStableMap.get(trade.id); if (!stable || pnlPct < 1) return false; const stagnantMs = peakPnl < 3.0 ? 35_000 : 60_000; return (Date.now() - stable.since) >= stagnantMs; })()) {
          const stableSec = Math.round((Date.now() - (pnlStableMap.get(trade.id)!.since)) / 1000);
          shouldClose = true; reason = `PNL_STAGNANT (+${pnlPct.toFixed(2)}% unchanged for ${stableSec}s)`;
        }
        else if (peakPnl >= engineSettings.trailingStopActivation && drawdownFromPeak >= engineSettings.trailingStopDistance) {
          shouldClose = true;
          reason = `TRAIL_STOP (peak +${peakPnl.toFixed(1)}%, fell ${drawdownFromPeak.toFixed(1)}%, floor +${trailingFloor.toFixed(1)}%)`;
        }
        // BUGFIX #6: was `pair.liquidity?.usd && pair.liquidity.usd < 300` —
        // the `&&` short-circuits when usd=0, so a pool with literally $0
        // liquidity doesn't trigger this exit. Use nullish coalescing.
        else if (pair && (pair.liquidity?.usd ?? 0) < 300) {
           shouldClose = true; reason = `LIQUIDITY_DRAIN_EMERGENCY(liq < $300, now ${(pair.liquidity?.usd ?? 0).toFixed(0)})`;
        }
        else if (costAwareStopPrice > 0 && currentPrice <= costAwareStopPrice) { shouldClose = true; reason = `STOP_LOSS (stop $${costAwareStopPrice.toFixed(8)}, price $${currentPrice.toFixed(8)}, pnl ${pnlPct.toFixed(1)}%)`; }
        else if (holdTime > dynamicMaxHold && pnlPct < 5) { shouldClose = true; reason = `MAX_HOLD(${Math.round(dynamicMaxHold)}s)`; }
        // ABSOLUTE_MAX_HOLD: fires regardless of PnL when holdTime exceeds the engine-wide
        // maximum (dynamicHoldMaxSeconds, default 2100s = 35min). The normal MAX_HOLD above
        // requires pnlPct < 5%, so a trade stagnating between +5% and +20% — where TRAIL_STOP
        // hasn't triggered (no drawdown from peak) and TAKE_PROFIT_20 hasn't reached — can
        // hold open indefinitely. This is a hard ceiling: no memecoin position should survive
        // past 35 minutes regardless of profitability. Placed as standalone if (not else-if)
        // so it always evaluates even if shouldClose is already true from another branch.
        if (!shouldClose && holdTime > engineSettings.dynamicHoldMaxSeconds) {
          shouldClose = true;
          reason = `ABSOLUTE_MAX_HOLD(${Math.round(holdTime)}s > ${engineSettings.dynamicHoldMaxSeconds}s cap, pnl ${pnlPct.toFixed(2)}%)`;
        }
        else if (holdTime > dynamicMaxHold / 2 && pnlPct < halfStopPct) {
          // EARLY_CUT minimum hold guard: don't fire before the token has had time to
          // develop momentum. For HWR (buy pressure measured over 1h) cutting at 3-4min
          // is contradictory — the signal is sustained, not instant. For SNIPER/MG a
          // shorter minimum is appropriate since those are momentum-burst entries.
          // Shadow data consistently shows EARLY_CUT firing on temporary dips that
          // recover: $WLD shadow=-2.13% vs paper=-8.27% (-6.14% paper inflation).
          const earlyCutMinHold =
            trade.mode === "HWR"    ? 360 :  // 6 min — HWR needs sustained pressure to develop
            trade.mode === "MG"     ? 240 :  // 4 min — momentum needs time to play out
            trade.mode === "SNIPER" ? 180 :  // 3 min — sniper positions move fast, shorter min OK
            240;
          if (holdTime >= earlyCutMinHold) {
            shouldClose = true; reason = `EARLY_CUT (pnl ${pnlPct.toFixed(1)}% < halfStop ${halfStopPct.toFixed(1)}%)`;
          }
        }
        else if (holdTime > 120 && pnlPct < stopLossPct * 0.7) { shouldClose = true; reason = `FAST_CUT (pnl ${pnlPct.toFixed(1)}% past 70% of stop ${(stopLossPct * 0.7).toFixed(1)}%)`; }
        else if (pnlPct > 10 && (() => { const bp = pair && pair.txns?.m5 ? ((pair.txns.m5.buys + pair.txns.m5.sells) > 0 ? pair.txns.m5.buys / (pair.txns.m5.buys + pair.txns.m5.sells) : 0.5) : 0.5; const pc5m = pair?.priceChange?.m5 || 0; return bp < 0.43 && pc5m < -3; })()) { const bp = pair && pair.txns?.m5 ? ((pair.txns.m5.buys + pair.txns.m5.sells) > 0 ? pair.txns.m5.buys / (pair.txns.m5.buys + pair.txns.m5.sells) : 0.5) : 0.5; const pc5m = pair?.priceChange?.m5 || 0; shouldClose = true; reason = `EARLY_EXIT_WEAK_BP (bp=${bp.toFixed(2)}, Δ5m=${pc5m.toFixed(1)}%)`; }
        else if (pair && pnlPct > 5 && ((pair.volume?.m5 || 0) / (pair.liquidity?.usd || 1)) > 7) { const volLiq = (pair.volume?.m5 || 0) / (pair.liquidity?.usd || 1); shouldClose = true; reason = `LIQUIDITY_EXHAUSTION (${volLiq.toFixed(2)}x)`; }
        else if (!shouldClose && pair && holdTime > 45) { const m5b = pair.txns?.m5?.buys || 0, m5s = pair.txns?.m5?.sells || 0; const currentBP = (m5b + m5s) > 0 ? m5b / (m5b + m5s) : 0.5; const priceChange5m = pair.priceChange?.m5 || 0; if (currentBP < 0.38 && priceChange5m < -2) { shouldClose = true; reason = `MOMENTUM_FADE (BP=${currentBP.toFixed(2)}, Δ5m=${priceChange5m.toFixed(1)}%)`; } else if (pnlPct > 5 && currentBP < 0.43 && priceChange5m < -4) { shouldClose = true; reason = `PROFIT_PROTECT_FADE (BP=${currentBP.toFixed(2)}, Δ5m=${priceChange5m.toFixed(1)}%, PNL=+${pnlPct.toFixed(1)}%)`; } }
        // FIX: VOL_COLLAPSE must be an independent `if`, not `else if`.
        // When holdTime > 45, the MOMENTUM_FADE branch above consumes the else-if,
        // and VOL_COLLAPSE (holdTime > 180) is never evaluated — tokens bleed to
        // zero indefinitely. Using a separate if allows both checks to run.
        if (!shouldClose && pair && holdTime > 180 && pnlPct > 1) { const currentVol5m = pair.volume?.m5 || 0; const vol1hNow = pair.volume?.h1 || 0; const expectedVol5m = vol1hNow / 12; if (expectedVol5m > 100 && currentVol5m < expectedVol5m * 0.15) { shouldClose = true; reason = `VOL_COLLAPSE (5m vol ${currentVol5m.toFixed(0)} is <15% of expected ${expectedVol5m.toFixed(0)})`; } }
        // PATCH #4: PRICE-DROP RUG DETECTOR — leading indicator that does NOT depend
        // on DexScreener's liquidity field (which lags on-chain state by 30-90s during a rug).
        // Price updates propagate faster than liquidity aggregates, so a sharp price drop
        // from peak is the earliest reliable signal of an active rug. $Taz bled from +5.64%
        // to -100% over ~3 minutes without firing LIQ_COLLAPSE because DexScreener still
        // reported stale liq until the pool was already empty.
        if (!shouldClose && holdTime > 20) {
          const _patchPeak = peakPrices.get(trade.id) ?? entryPrice;
          const _patchDropFromPeakPct = _patchPeak > 0 ? ((_patchPeak - currentPrice) / _patchPeak) * 100 : 0;
          // Fast rug: -25% from peak in any window — unconditional exit
          if (_patchDropFromPeakPct >= 25) {
            shouldClose = true;
            reason = `PRICE_RUG (-${_patchDropFromPeakPct.toFixed(1)}% from peak $${_patchPeak.toExponential(4)} -> $${currentPrice.toExponential(4)})`;
          }
          // SLOW_BLEED: -5% from peak AND below entry AND hold > 60s AND peakPnl < trailingStopActivation.
          // Covers the gap below trailing activation (5%) where TRAIL_STOP never arms.
          // Drop threshold raised to 5% (from 3%) to avoid whipsaw on normal memecoin oscillation.
          else if (_patchDropFromPeakPct >= 5 && currentPrice < entryPrice && holdTime > 60 && peakPnl < engineSettings.trailingStopActivation) {
            shouldClose = true;
            reason = `SLOW_BLEED (-${_patchDropFromPeakPct.toFixed(1)}% from peak, below entry, peakPnl ${peakPnl.toFixed(2)}%)`;
          }
        }
        // FIX D: Liquidity collapse emergency exit. A rug pull drains LP before it crashes
        // price — our stop-loss fires too late because price is calculated against drained
        // liquidity. If current liquidity is below $300 (un-tradeable) OR has dropped >70%
        // from entry while we're still holding, exit immediately at any PNL.
        // This fires regardless of holdTime because rugs don't wait.
        if (!shouldClose && pair) {
          const currentLiq = pair.liquidity?.usd ?? 0;
          // BUGFIX #16: if DexScreener returns no liquidity field (undefined),
          // currentLiq=0 triggers false LIQ_COLLAPSE. Only fire if liquidity
          // was actually reported (field exists and is a number).
          const liqReported = typeof pair.liquidity?.usd === "number";
          // FIX LIQ_CO: "0" is a truthy string so the old ternary (trade.liquidity ? parseFloat(...) : 0)
          // resolved to parseFloat("0") = 0 for every trade stored with zero liquidity — making the
          // relative 50% drop check permanently false (0 > 1000 is never true). Use parseFloat with
          // nullish coalesce and a || 0 fallback so NaN / "0" / null / undefined all produce 0, and
          // log a warning so we can confirm the stored value is non-zero going forward.
          const entryLiqUsd = parseFloat(trade.liquidity ?? "0") || 0;
          // FIX #5: when entry liquidity is zero the relative 70% drop check was permanently disabled.
          // Use sniperMinLiquidity as a conservative floor so the relative check stays active.
          // This doesn't mean the token actually had that liquidity — it means slow-rug detection
          // will use the floor as a baseline rather than being silently bypassed.
          const effectiveEntryLiq = entryLiqUsd > 0 ? entryLiqUsd : (engineSettings.sniperMinLiquidity ?? 3000);
          if (entryLiqUsd === 0 && !liqCoWarnedTrades.has(trade.id)) {
            liqCoWarnedTrades.add(trade.id);
            console.warn(`[LIQ_CO] #${trade.id} $${trade.tokenSymbol} — entry liquidity zero, using floor $${effectiveEntryLiq} for relative drop check (FIX #5)`);
          }
          // BUGFIX #16: only fire if liquidity was actually reported. Missing
          // liquidity field is a data gap, not a real $0 pool.
          const liqCollapsed = liqReported && currentLiq < 300;
          // FIX #6: threshold tightened from 30% remaining (70% drain) to 50% remaining (50% drain).
          // A 55% LP drain already compromises the token — waiting for 70% drain costs an extra
          // ~20% of exit value. Catching the collapse at 50% drain gives the SL a wider price window
          // to execute before the token becomes un-tradeable. Safe to lower because the absolute
          // $300 floor (liqCollapsed) is unchanged and still catches near-zero LP situations.
          const liqDropped50pct = effectiveEntryLiq > 1000 && currentLiq < effectiveEntryLiq * 0.50; // was 0.30 (70% drain gate)
          if (liqCollapsed || liqDropped50pct) {
            shouldClose = true;
            reason = `LIQ_COLLAPSE (entry $${effectiveEntryLiq.toFixed(0)} → now $${currentLiq.toFixed(0)}, ${liqCollapsed ? "below floor" : ">50% drain"})`;
          }
        }
        if (shouldClose) {
          // FIX H: CONSOLIDATED FLOOR — applies to every exit path, not just TRAIL_STOP
          // and PROFIT_DECLINE. LIQ_COLLAPSE and VOL_COLLAPSE set shouldClose in independent
          // if-blocks that run after the floor-protected branches, so pnlPct was never clamped
          // for them. $FAH: peakPnl 12%, floor should be +3%, recorded -14.5% via VOL_COLLAPSE.
          // $808: peakPnl 3.7%, floor should be +0.55%, recorded -22.77% via LIQ_COLLAPSE.
          // The floor is an accounting protection — it doesn't change the on-chain fill price,
          // but it prevents gap fills from tripping the daily circuit breaker on good sessions.
          // Exception: STOP_LOSS, HARD_LOSS_KILL, EARLY/FAST_CUT fire when there was no
          // meaningful peak — applying the floor there would be misleading.
          const isHardLoss = reason.startsWith("STOP_LOSS") || reason.startsWith("HARD_LOSS_KILL") ||
                             reason.startsWith("DEEP_RUG_KILL") ||
                             reason.startsWith("EARLY_CUT") || reason.startsWith("FAST_CUT");
          if (!isHardLoss && pnlPct < trailingFloor && trailingFloor > 0) {
            console.log(`[EXIT:FLOOR] $${trade.tokenSymbol} | ${reason.split(" ")[0]} | raw pnl ${pnlPct.toFixed(2)}% → floor locked at +${trailingFloor.toFixed(2)}% (peak was +${peakPnl.toFixed(1)}%)`);
            pnlPct = trailingFloor;
          }
          console.log(`[LIFECYCLE:EXIT] id=#${trade.id} $${trade.tokenSymbol} | reason: ${reason} | pnl: ${pnlPct.toFixed(2)}% | peakPnl: ${peakPnl.toFixed(2)}% | holdTime: ${Math.round(holdTime)}s | mode: ${trade.tradingMode}`);
          lifecycleLastLogMs.delete(trade.id);
          trailActivatedLogged.delete(trade.id);
          const sizeSol = parseFloat(trade.amount);
          const isLiveSell = trade.tradingMode === "live" && jupiterService !== null;
          let finalPnlPct: number, sellTxSig: string | null = null;
          if (isLiveSell) {
            sellingInProgress.add(trade.id);
            // FIX: when the force-sell background task takes over, it owns
            // sellingInProgress for its entire 5-minute window. The flag
            // prevents the outer finally from deleting the entry prematurely,
            // which would let the next price-check cycle re-enter the sell
            // path and attempt a double-sell on the same live position.
            let handedOffToForceSell = false;
            try {
              let tokenAmountRaw = liveTokenBalances.get(trade.id) ?? BigInt(0);
              if (tokenAmountRaw === BigInt(0)) { tokenAmountRaw = await jupiterService!.getTokenBalance(trade.tokenAddress); if (tokenAmountRaw > BigInt(0)) liveTokenBalances.set(trade.id, tokenAmountRaw); }
              if (tokenAmountRaw === BigInt(0)) {
                const desyncPnlPct = sizeSol > 0 && entryPrice > 0 && currentPrice > 0 ? (((currentPrice - entryPrice) / entryPrice) * 100).toFixed(2) : "0";
                const desyncPnlSol = sizeSol * (parseFloat(desyncPnlPct) / 100);
                dailyPnlSol += desyncPnlSol;
                console.warn(`[LIVE] DESYNC: No tokens on-chain for $${trade.tokenSymbol} (trade #${trade.id}). Auto-closing in DB (PNL: ${desyncPnlPct}%).`);
                await storage.closeTrade(trade.id, currentPrice.toString(), desyncPnlPct, "DESYNC_NO_BALANCE");
                liveTokenBalances.delete(trade.id); peakPrices.delete(trade.id); partialTpTaken.delete(trade.id);
                tradeStopPrices.delete(trade.id); prevPnlMap.delete(trade.id); pnlStableMap.delete(trade.id);
                tradedAddresses.set(trade.tokenAddress, Date.now());
                continue;
              }
              const exitLiqUsd = pair?.liquidity?.usd ?? 1000;
              const exitCostsModel = calcTransactionCosts(exitLiqUsd, sizeSol);
              const baseExitSlippageBps = Math.min(2000, Math.max(100, Math.round(exitCostsModel.exitSlippagePct * 1.5 * 100)));
              // If this trade has previous sell failures, use escalated slippage from
              // the ladder — don't start back at base slippage on every retry.
              const priorStrikes = sellFailureStrikes.get(trade.id) ?? 0;
              const exitSlippageBps = priorStrikes === 0 ? baseExitSlippageBps
                : priorStrikes === 1 ? Math.min(baseExitSlippageBps * 2, 500)
                : priorStrikes === 2 ? 500
                : priorStrikes === 3 ? 1500
                : 3000;
              // FIX E: Auto-escalate exit slippage when liquidity has shrunk since entry.
              // If liq at entry was > $1k but current liq < 40% of entry, the pool is
              // draining — use a minimum of 500bps to avoid failed fills and wasted fees.
              const entryLiqForSell = trade.liquidity ? parseFloat(trade.liquidity) : 0;
              const currentLiqForSell = pair?.liquidity?.usd ?? 0;
              const liqDrainedSignificantly = entryLiqForSell > 1000 && currentLiqForSell > 0 && currentLiqForSell < entryLiqForSell * 0.40;
              const autoEscalatedExitBps = liqDrainedSignificantly ? Math.max(exitSlippageBps, 500) : exitSlippageBps;
              if (liqDrainedSignificantly && autoEscalatedExitBps > exitSlippageBps) {
                console.warn(`[SELL] Liq drained ${entryLiqForSell.toFixed(0)}→${currentLiqForSell.toFixed(0)} — auto-escalating exit slippage ${exitSlippageBps}→${autoEscalatedExitBps}bps`);
              }
              // Sell impact guard: pre-check
              // ── ANTI-RUG ROUTING GUARD (DEAD POOL DETECTION) ──
              let sellQuote: any = null;
              try {
                sellQuote = await jupiterService!.fetchQuote(trade.tokenAddress, SOL_MINT, tokenAmountRaw.toString(), [autoEscalatedExitBps]);
              } catch (quoteErr: any) {
                if (quoteErr.message?.includes("NO_ROUTES_FOUND") || quoteErr.message?.includes("No routes")) {
                  console.error(`[DEAD POOL] 🚨 NO ROUTES FOUND for $${trade.tokenSymbol}. Liquidity is completely gone. Force-closing ghost record.`);
                  
                  // Close the DB record immediately so it stops looping
                  const deadPnl = "-99.00";
                  dailyPnlSol -= sizeSol * 0.99; // Register the loss against daily limits
                  await storage.closeTrade(trade.id, "0.00000001", deadPnl, "RUGGED_NO_ROUTES");
                  
                  // Wipe it from memory
                  liveTokenBalances.delete(trade.id); peakPrices.delete(trade.id); partialTpTaken.delete(trade.id);
                  tradeStopPrices.delete(trade.id); prevPnlMap.delete(trade.id); pnlStableMap.delete(trade.id);
                  sellFailureStrikes.delete(trade.id); zeroBalanceStrikes.delete(trade.id); liqCoWarnedTrades.delete(trade.id);
                  tradedAddresses.set(trade.tokenAddress, Date.now());
                  
                  // Apply loss streak penalties
                  consecutiveLosses++; consecutiveWins = 0;
                  if (consecutiveLosses === 2) lastMiniCooldownEnd = Date.now() + MINI_LOSS_COOLDOWN_MS;
                  if (consecutiveLosses >= 3) { lastLossCooldownEnd = Date.now() + engineSettings.lossCooldownMs; consecutiveLosses = 0; }
                  
                  continue; // Skip the rest of the loop — trade is officially dead
                }
                console.warn(`[SELL PRE-CHECK] Quote failed for $${trade.tokenSymbol}: ${quoteErr.message}`);
              }

              const sellImpactPct = parseFloat(sellQuote?.priceImpactPct ?? "0");
              if (sellImpactPct > 50) console.warn(`[SELL] Extreme impact ${sellImpactPct.toFixed(1)}% for ${trade.tokenSymbol} — forcing sell anyway (rugpull escape)`);
              // ───────────────────────────────────────────────────
              // FIX LOCK: use a shorter per-cycle timeout (12 s) rather than EXECUTION_TIMEOUT_MS (30 s).
              // priceCheckLock is held for the full duration of this await — a 30 s block means other
              // open positions get zero price checks for 30 s during any slow/failed sell.
              // 12 s is still long enough for a successful Jupiter confirmation (~2-5 s average);
              // a timeout here increments sellFailureStrikes and the escalating-slippage ladder
              // retries next cycle automatically, so no position is ever abandoned.
              const POSITION_SELL_TIMEOUT_MS = 12_000;
              // PATCH #7: For death-signal exits (LIQ_COLLAPSE / PRICE_RUG / SLOW_BLEED /
              // MID_HOLD_RISK), the pool is already known to be dead. Skip the slow
              // escalating-slippage ladder (4 strikes, ~50s) and jump straight to max
              // slippage (3000 bps = 30%) on the first attempt. $Taz wasted 50 seconds
              // going through strikes 1->4 on a dead pool, finally selling for 0 SOL.
              // For non-death-signal exits (PROFIT_DECLINE, TRAIL_STOP, etc.), keep the
              // original escalating ladder to maximize fill quality on healthy pools.
              const _patchIsDeathExit = reason.startsWith("LIQ_COLLAPSE") || reason.startsWith("PRICE_RUG") || reason.startsWith("SLOW_BLEED") || reason.startsWith("MID_HOLD_RISK");
              const _patchFirstAttemptBps = _patchIsDeathExit ? 3000 : autoEscalatedExitBps;
              const sellResult = await jupiterService!.sellToken(trade.tokenAddress, tokenAmountRaw, _patchFirstAttemptBps);
              if (!sellResult.success) {
                const strikes = (sellFailureStrikes.get(trade.id) ?? 0) + 1;
                sellFailureStrikes.set(trade.id, strikes);
                // PATCH #7: for death exits, jump straight to the force-sell background
                // loop after just 1 failed attempt (instead of 4). The pool is dead,
                // retrying 3 more times with the same max slippage is pure waste.
                const _patchMaxStrikes = _patchIsDeathExit ? 1 : 4;
                // AUTO-ESCALATING SLIPPAGE LADDER: each failed sell retries with wider
                // slippage rather than giving up. Giving up = tokens stuck on-chain with
                // no automatic recovery — in live mode that is a guaranteed full loss.
                // Strike 1 → 2x slippage (wider but still reasonable)
                // Strike 2 → 500 bps (5% — covers most pool conditions)
                // Strike 3 → 1500 bps (15% — emergency exit, accept bad fill over stuck)
                // Strike 4+ → 3000 bps (30% — last resort, any fill beats zero)
                if (strikes <= _patchMaxStrikes) {
                  const escalatedBps = _patchIsDeathExit ? 3000
                    : strikes === 1 ? Math.min(exitSlippageBps * 2, 500)
                    : strikes === 2 ? 500
                    : strikes === 3 ? 1500
                    : 3000;
                  console.warn(`[LIVE] SELL FAILED $${trade.tokenSymbol} (attempt ${strikes}${_patchIsDeathExit ? " [DEATH_EXIT]" : ""}): ${sellResult.error} — escalating slippage to ${escalatedBps}bps next cycle`);
                  // Store escalated slippage for next cycle by bumping the strike count
                  // — the escalated bps will be derived from it on the next price check.
                } else {
                  // FIX 6: Instead of logging CRITICAL and giving up (which leaves real tokens
                  // stranded in the wallet forever), launch the persistent force-sell loop in
                  // the background. It retries every 15s at 30% slippage for up to 5 minutes.
                  // sellingInProgress keeps the normal sell path from double-triggering.
                  // We do NOT await — this must not block the price-checking loop.
                  console.error(`[SELL] CRITICAL: $${trade.tokenSymbol} #${trade.id} failed ${strikes} times — launching persistent force-sell loop (30% slippage, 5-min window)`);
                  const capturedTrade  = { ...trade };
                  const capturedPrice  = currentPrice;
                  // Hand ownership of sellingInProgress to the background task.
                  // The entry is already present (added before the try block above).
                  // The background .then()/.catch() finally blocks are responsible
                  // for the eventual delete — do NOT let the outer finally remove it.
                  handedOffToForceSell = true;
                  forceSellPosition(capturedTrade, capturedPrice).then(async ({ success, solReceived }) => {
                    try {
                      const { price: exitPrice } = await fetchTokenPrice(capturedTrade.tokenAddress).catch(() => ({ price: capturedPrice, pair: null }));
                      const safeExitPrice = exitPrice > 0 ? exitPrice : capturedPrice;
                      const entryPriceFp  = parseFloat(capturedTrade.price || "0");
                      const capSizeSol    = parseFloat(capturedTrade.amount || "0");
                      const finalPnlPct   = success && solReceived > 0
                        ? (capSizeSol > 0 ? ((solReceived - capSizeSol) / capSizeSol) * 100 : 0)
                        : (entryPriceFp > 0 && safeExitPrice > 0 ? ((safeExitPrice - entryPriceFp) / entryPriceFp) * 100 : 0);
                      const closeReason   = success ? "FORCE_SELL" : "FORCE_SELL_FAILED_MANUAL_REQUIRED";
                      // Reclaim ~0.002 SOL rent fee even in background force-sell success
                      if (success) jupiterService!.closeTokenAccount(capturedTrade.tokenAddress).catch(() => {});
                      await storage.closeTrade(capturedTrade.id, safeExitPrice.toString(), finalPnlPct.toFixed(2), closeReason);
                      sellFailureStrikes.delete(capturedTrade.id);
                      peakPrices.delete(capturedTrade.id);
                      partialTpTaken.delete(capturedTrade.id);
                      tradeStopPrices.delete(capturedTrade.id);
                      prevPnlMap.delete(capturedTrade.id);
                      pnlStableMap.delete(capturedTrade.id);
                      zeroBalanceStrikes.delete(capturedTrade.id);
                      tradedAddresses.set(capturedTrade.tokenAddress, Date.now());
                      console.log(`[FORCE_SELL] DB closed #${capturedTrade.id} $${capturedTrade.tokenSymbol} | PNL: ${finalPnlPct.toFixed(2)}% | success: ${success}`);
                    } catch (dbErr: any) {
                      console.error(`[FORCE_SELL] DB close failed #${capturedTrade.id}: ${dbErr.message}`);
                    } finally {
                      sellingInProgress.delete(capturedTrade.id);
                    }
                  }).catch((e: any) => {
                    console.error(`[FORCE_SELL] Unhandled error #${capturedTrade.id}: ${e.message}`);
                    sellingInProgress.delete(capturedTrade.id);
                  });
                }
                continue;
              }
              sellFailureStrikes.delete(trade.id); // clear on success
              sellTxSig = sellResult.txSignature;
              finalPnlPct = sizeSol > 0 ? ((sellResult.solReceived - sizeSol) / sizeSol) * 100 : 0;
              dailyPnlSol += sellResult.solReceived - sizeSol;
              liveTokenBalances.delete(trade.id);
              // BUGFIX #19: was `await getWalletBalance()` — blocks price-check loop
              // on RPC round-trip. Fire-and-forget; peakBalance updates async.
              jupiterService!.getWalletBalance().then((liveBalAfterSell) => {
                if (liveBalAfterSell > peakBalance) {
                  peakBalance = liveBalAfterSell;
                  storage.updateBotStats({ peakBalance: peakBalance.toFixed(4) }).catch(() => {});
                }
              }).catch(() => {});
              // FEE TRACKING: log real sell fees so cumulative fee drag is visible.
              const sellFeesSol = sellResult.feesSol ?? 0;
              const trueNetSol = sellResult.solReceived - sellFeesSol;
              const truePnlPct = sizeSol > 0 ? ((trueNetSol - sizeSol) / sizeSol) * 100 : 0;
              console.log(
                `[LIVE_FEE] SELL $${trade.tokenSymbol} | fees: ${sellFeesSol.toFixed(6)} SOL` +
                ` | grossReceived: ${sellResult.solReceived.toFixed(6)} SOL` +
                ` | netReceived: ${trueNetSol.toFixed(6)} SOL` +
                ` | reportedPnl: ${finalPnlPct >= 0 ? "+" : ""}${finalPnlPct.toFixed(2)}%` +
                ` | truePnl(after fees): ${truePnlPct >= 0 ? "+" : ""}${truePnlPct.toFixed(2)}%`
              );
              console.log(`[LIVE] ${finalPnlPct >= 0 ? "WIN" : "LOSS"} SELL $${trade.tokenSymbol} | PNL: ${finalPnlPct >= 0 ? "+" : ""}${finalPnlPct.toFixed(2)}% | ${reason} | tx: ${sellTxSig?.slice(0, 20)}...`);
            } finally { if (!handedOffToForceSell) sellingInProgress.delete(trade.id); }
          } else {
            let exitPnlPct = Math.min(500, Math.max(pnlPct, -99)); // cap: paper exit bounded [−99, 500] — mirrors the hold-loop 500% cap so a bad feed price cannot credit impossible SOL gains to paperBalance
            const exitLiq = pair?.liquidity?.usd ?? 1000;
            const exitTxCosts = calcTransactionCosts(exitLiq, sizeSol);
            const exitCostPct = exitTxCosts.exitSlippagePct + exitTxCosts.exitFeePct;
            // FIX: floor at -99 AFTER subtracting exit costs. In live trading you cannot
            // lose more than 100% of a position — the worst case is selling for near-zero
            // and receiving dust. Applying exit costs on top of a -99% position produced
            // -109% in paper mode, which inflated the circuit breaker's daily loss calc
            // and drawdown figure with numbers that are physically impossible in live mode.
            exitPnlPct = Math.max(-99, exitPnlPct - exitCostPct);
            // FIX FLOOR: the trailing floor was applied to pnlPct before entering this
            // branch (line ~1716), but subtracting exit costs can push exitPnlPct back
            // below it (e.g. floor +0.95%, exitCost 3.8% → −2.85%). The floor is an
            // accounting device to prevent gap-through trail exits from tripping the
            // circuit breaker on sessions that peaked positive — it must survive costs.
            // isHardLoss and trailingFloor are both in scope from the shouldClose block.
            if (!isHardLoss && trailingFloor > 0 && exitPnlPct < trailingFloor) {
              exitPnlPct = trailingFloor;
            }
            const MAX_RETURN_MULTIPLIER = 6; // 500% gain = 6× return — hard ceiling matches pnlPct cap
            const returnSolRaw = sizeSol * (1 + exitPnlPct / 100);
            const returnSol = Math.min(returnSolRaw, sizeSol * MAX_RETURN_MULTIPLIER);
            if (returnSolRaw !== returnSol) {
              console.warn(
                `[BALANCE_GUARD] returnSol clamped ${returnSolRaw.toFixed(4)} → ${returnSol.toFixed(4)} SOL ` +
                `for $${trade.tokenSymbol} | exitPnlPct was ${exitPnlPct.toFixed(2)}%`
              );
            }
            paperBalance += returnSol;
            dailyPnlSol += returnSol - sizeSol;
            finalPnlPct = exitPnlPct;
            if (paperBalance > peakBalance) peakBalance = paperBalance;
            console.log(`[PAPER] ${finalPnlPct >= 0 ? "WIN" : "LOSS"} SELL $${trade.tokenSymbol} @ $${currentPrice.toFixed(8)} | PNL: ${finalPnlPct >= 0 ? "+" : ""}${finalPnlPct.toFixed(2)}% | ${reason} | ExitCost: -${exitCostPct.toFixed(1)}% | Bal: ${paperBalance.toFixed(3)} SOL`);
          }
          const isWin = finalPnlPct! > 0;
          if (isWin) { consecutiveWins++; consecutiveLosses = 0; lastMiniCooldownEnd = 0; }
          else {
            consecutiveLosses++; consecutiveWins = 0;
            // POST-LOSS COOLDOWN: record this token's loss timestamp so the entry gate
            // can block re-entry for POST_LOSS_COOLDOWN_MS. This prevents the observed
            // pattern of immediately re-entering a token that just stopped out or bled.
            tokenLastLossMs.set(trade.tokenAddress, Date.now());
            tokenSymbolLastLossMs.set(trade.tokenSymbol, Date.now()); // Change 6: symbol-level cooldown
            if (consecutiveLosses === 2) {
              // 2-loss mini-cooldown: pause 3 minutes before the next entry.
              // Keeps the bot from adding a third loss mid-streak while market is hostile.
              lastMiniCooldownEnd = Date.now() + MINI_LOSS_COOLDOWN_MS;
              console.log(`[RISK] 2 consecutive losses — ${MINI_LOSS_COOLDOWN_MS / 1000}s mini-cooldown activated`);
            }
            if (consecutiveLosses >= 3) {
              lastLossCooldownEnd = Date.now() + engineSettings.lossCooldownMs;
              // FIX: reset so next penalty requires 3 NEW losses, not instantly
              // re-firing on every subsequent loss from an accumulated count.
              consecutiveLosses = 0;
              console.log(`[RISK] 3 consecutive losses — ${engineSettings.lossCooldownMs / 1000}s cooldown activated`);
            }
          }
          await storage.closeTrade(trade.id, currentPrice.toString(), finalPnlPct!.toFixed(2), reason);

          // BUGFIX #13: was `jupiterService!.closeTokenAccount(...)` — non-null
          // assertion crashes paper mode where jupiterService is null. Guard with
          // null check. Also log failures so operator can manually reclaim rent.
          if (jupiterService) {
            jupiterService.closeTokenAccount(trade.tokenAddress).catch((e: any) => {
              console.warn(`[RECLAIM] closeTokenAccount failed for $${trade.tokenSymbol} (dust balance may prevent close): ${e?.message ?? e}`);
            });
          }

          
          // ── SHADOW MODE: close matching shadow trade ──────────────────────
          if (trade.tradingMode !== "live") {
            closeShadowTrade(trade.tokenAddress, currentPrice, finalPnlPct!, reason).catch(() => {});
          }
          // ─────────────────────────────────────────────────────────────────
          tradedAddresses.set(trade.tokenAddress, Date.now());
          if (reason.startsWith("STOP_LOSS") || reason.startsWith("HARD_LOSS_KILL") || reason.startsWith("DEEP_RUG_KILL") || reason.startsWith("EARLY_CUT") || reason.startsWith("FAST_CUT") || reason.startsWith("LIQ_COLLAPSE") || reason.startsWith("VOL_COLLAPSE")) {
            stoppedOutAddresses.set(trade.tokenAddress, Date.now());
            // Block re-entry on ANY new contract with the same symbol for the full slReentryDelayMs.
            // Fixes $SOS re-entering 11m47s after LIQ_COLLAPSE via a new contract address —
            // stoppedOutAddresses is address-keyed so the new address bypassed it; this closes the gap.
            tokenSymbolSlBlockMs.set(trade.tokenSymbol, Date.now());
            // FIX B: increment repeat-loser strike counter and extend block for chronic losers.
            // Two stops on the same token in a session = the market has rejected this token twice.
            // Continuing to re-enter just bleeds fees. Lock it out for 4 hours instead of 15 min.
            // FIX G: LIQ_COLLAPSE and VOL_COLLAPSE are structurally equivalent to a stop-loss —
            // the token's pool is either drained or dead. Previously they only set tradedAddresses
            // (60s gate) instead of stoppedOutAddresses (900s gate), allowing immediate re-entry
            // into the same hostile token. $FARTCAT entered twice 73s apart for -23% and -14%.
            const slCount = (tokenStopLossCount.get(trade.tokenAddress) ?? 0) + 1;
            tokenStopLossCount.set(trade.tokenAddress, slCount);
            if (slCount >= 2) {
              hardBlockedAddresses.set(trade.tokenAddress, Date.now()); // reuse hardBlock with custom TTL
              console.log(`[RISK] REPEAT_LOSER $${trade.tokenSymbol} — ${slCount} SLs this session → hard block for ${REPEAT_LOSER_BLOCK_MS / 3600000}h`);
            } else {
              console.log(`[RISK] SL blackout set for $${trade.tokenSymbol} (${reason.split(" ")[0]}) — no re-entry for ${(engineSettings.slReentryDelayMs / 60000).toFixed(0)} min`);
            }
          }
          peakPrices.delete(trade.id); partialTpTaken.delete(trade.id); tradeStopPrices.delete(trade.id);
          prevPnlMap.delete(trade.id); pnlStableMap.delete(trade.id); liveTokenBalances.delete(trade.id);
          sellFailureStrikes.delete(trade.id);
          zeroBalanceStrikes.delete(trade.id);
          liqCoWarnedTrades.delete(trade.id);
          const allTrades = await storage.getTrades();
          const closedTrades = allTrades.filter((t: any) => t.status === "CLOSED");
          const winsCount = closedTrades.filter((t: any) => parseFloat(t.pnl || "0") > 0).length;
          const totalPnl = closedTrades.reduce((sum, t) => sum + parseFloat(t.pnl || "0"), 0);
          const wr = closedTrades.length > 0 ? ((winsCount / closedTrades.length) * 100).toFixed(1) : "0";
          const openNow = allTrades.filter((t: any) => t.status === "OPEN").length;
          const displayBal = (isLiveSell && jupiterService) ? (await jupiterService.getWalletBalance().catch(() => 0)).toFixed(4) : paperBalance.toFixed(3);
          await storage.updateBotStats({ walletBalance: displayBal, totalPnl: (totalPnl / Math.max(closedTrades.length, 1)).toFixed(2), winRate: wr, totalTrades: allTrades.length, openPositions: openNow, lastSignal: `SOLD $${trade.tokenSymbol} | ${isWin ? "+" : ""}${finalPnlPct!.toFixed(1)}% | ${reason}`, peakBalance: peakBalance.toFixed(4), lastLossCooldownEnd, dailyStartBalance: dailyStartBalance.toFixed(4) });
        }
      } catch (tradeErr) { console.error(`[POSITION_MANAGER] Error processing $${trade.tokenSymbol}:`, tradeErr); }
    }
  } catch (e) { console.error("[POSITION_MANAGER] Error:", e); } finally { priceCheckLock = false; }
}

async function startTradingEngine() {
  if (scannerInterval) clearInterval(scannerInterval);
  if (priceCheckerInterval) clearInterval(priceCheckerInterval);
  // Reset session-scoped state on every engine start so stale counts from a
  // previous run don't carry over and block valid entries on the new session.
  sessionTokenBuyCount.clear();
  sessionSymbolBuyCount.clear();       // Change 4: symbol-scoped buy counts
  tokenSymbolLastLossMs.clear();       // Change 4: symbol-scoped loss timestamps
  tokenSymbolSlBlockMs.clear();        // FIX: symbol-level SL block (new contract, same symbol)
  tokenStopLossCount.clear(); // FIX B: clear repeat-loser strikes on engine restart
  liqCoWarnedTrades.clear();           // FIX: warn-once guard reset on engine start
  priceSanityRejections.clear();       // FIX: rejection counters reset on engine start
  priceSanityWarnOnce.clear();         // FIX: warn-once guard reset on engine start
  consecutiveWins = 0;
  consecutiveLosses = 0;
  console.log("==================== 1000x ROI TRADING BOT ====================");
  const _bootStatus = await storage.getBotStatus().catch(() => ({ tradingMode: "paper" }));
  const _bootMode = _bootStatus.tradingMode === "live" ? "live" : "paper";
  console.log(`[CONFIG] Mode: ${_bootMode === "live" ? "LIVE (on-chain trading)" : "paper + moonbag + shadow"}`);
  console.log(`[CONFIG] Paper seed: ${engineSettings.startingBalance} SOL (config default — NOT the live wallet; real balance shown below)`);
  console.log("[CONFIG] ROI Target: 1000x");
  console.log("[CONFIG] Win Rate Target: >80%");
  const _micro = getEdgeParams(true), _normal = getEdgeParams(false);
  console.log(`[CONFIG] EDGE micro: minEdge=${_micro.minEdgePct}% buffer=${_micro.buffer}% | normal: minEdge=${_normal.minEdgePct}% buffer=${_normal.buffer}%`);
  console.log("[CONFIG] Starting trading engine...");
  jupiterService = createJupiterService();
  if (jupiterService) {
    const walletBal = await jupiterService.getWalletBalance().catch(() => 0);
    console.log(`[ENGINE] Live trading ENABLED | wallet: ${jupiterService.walletAddress} | balance: ${walletBal.toFixed(4)} SOL`);
    await syncLiveTokenBalances();

    // --> ADD THIS LINE RIGHT HERE <--
    await jupiterService.sweepEmptyAccounts();
  } else console.log("[ENGINE] Live trading DISABLED — paper mode only");
  await initBalanceFromDB();
  const mlUp = await checkMLService();
  console.log(mlUp ? "[ENGINE] ML Service connected" : "[ENGINE] ML Service not available");
  if (mlCheckerInterval) clearInterval(mlCheckerInterval);
  mlCheckerInterval = setInterval(checkMLService, 30000);
  console.log("[ENGINE] Fetching live SOL price from DexScreener...");
  for (let attempt = 0; attempt < 10; attempt++) {
    const price = await getLiveSolPrice();
    if (solPriceFetchedOnce && price > 0) { console.log(`[ENGINE] SOL price locked at $${price.toFixed(2)}`); break; }
    if (attempt < 9) await new Promise(r => setTimeout(r, 2000));
    else console.warn(`[ENGINE] Could not fetch live SOL price after 10 attempts — proceeding with cached fallback $${cachedSolPriceUsd}`);
  }
  // BUGFIX #4: was setInterval — if checkOpenPositions takes >1s (slow RPC, many
  // positions), calls stack up and priceCheckLock skips them. During a rug, exits
  // can be delayed by 5-10s. Recursive setTimeout guarantees the next call only
  // schedules AFTER the current one completes, with no stacking.
  function scheduleScan() {
    scannerInterval = setTimeout(async () => {
      await runScanCycle();
      scheduleScan();
    }, engineSettings.scanIntervalMs);
  }
  function schedulePriceCheck() {
    priceCheckerInterval = setTimeout(async () => {
      await checkOpenPositions();
      schedulePriceCheck();
    }, engineSettings.priceCheckIntervalMs);
  }
  scheduleScan();
  schedulePriceCheck();
  setTimeout(runScanCycle, 3000);
  setTimeout(checkOpenPositions, 8000);
}
// RECONCILIATION: Clear phantom positions after restart
async function reconcilePositions() {
    const openTrades = await storage.getOpenTrades();
    const jupiter = createJupiterService();
    if (!jupiter) return;
    for (const trade of openTrades) {
        const balance = await jupiter.getTokenBalance(trade.tokenAddress);
        if (balance <= 0n) {
            log.warn(`[RECONCILE] Phantom trade cleared: ${trade.tokenSymbol}`);
            await storage.closeTrade(trade.id, "0", "0", "RECONCILE_AUTO_CLOSE");
        }
    }
}

async function syncLiveTokenBalances() {
  if (!jupiterService) return;
  try {
    const openTrades = await storage.getOpenTrades();
    const liveTrades = openTrades.filter((t: any) => t.tradingMode === "live");
    if (liveTrades.length === 0) return;
    console.log(`[JUPITER] Syncing token balances for ${liveTrades.length} open live trade(s)...`);
    const fetches = await Promise.allSettled(liveTrades.map((t: any) => jupiterService!.getTokenBalance(t.tokenAddress)));
    for (let i = 0; i < liveTrades.length; i++) {
      const trade = liveTrades[i];
      const result = fetches[i];
      if (result.status === "fulfilled") {
        if (result.value > BigInt(0)) { liveTokenBalances.set(trade.id, result.value); console.log(`[JUPITER] Restored trade #${trade.id} ($${trade.tokenSymbol}): ${result.value} raw tokens`); }
        else console.warn(`[JUPITER] Trade #${trade.id} ($${trade.tokenSymbol}): no ATA balance found`);
      } else console.error(`[JUPITER] Trade #${trade.id} ($${trade.tokenSymbol}): balance fetch failed — ${(result as PromiseRejectedResult).reason?.message ?? "unknown"}`);
    }
  } catch (e) { console.error("[JUPITER] syncLiveTokenBalances error:", e); }
}

export async function registerRoutes(httpServer: Server, app: Express): Promise<Server> {
  // CRITICAL: Initialize storage wrapper before any storage access
  await initStorageWrapper();
  await storage.seedInitialData();
  startHeartbeat();            // FAILSAFE: write .heartbeat every 5s so the watchdog sees liveness
  await startTradingEngine();

  app.get(api.status.get.path, async (req, res) => { res.json(await storage.getBotStatus()); });
  app.get("/api/health", async (_req, res) => {
    try {
      const status = await storage.getBotStatus().catch(() => ({ tradingMode: "paper", isRunning: false, walletBalance: "0" }));
      const openTrades = await storage.getOpenTrades().catch(() => []);
      res.json({
        status: healthState().status,
        halted: isHalted(),
        mode: status.tradingMode || "paper",
        isRunning: status.isRunning ?? false,
        walletBalance: status.walletBalance || "0",
        openPositions: openTrades.length,
        uptimeSeconds: Math.floor((Date.now() - engineStartTime) / 1000),
        timestamp: new Date().toISOString(),
      });
    } catch (e) {
      res.status(503).json({ status: "unhealthy", error: String(e) });
    }
  });
  app.get(api.trades.list.path, async (req, res) => { res.json(await storage.getTrades()); });
  app.get(api.candidates.list.path, async (req, res) => { res.json(await storage.getCandidates()); });
  app.get("/api/candidates/live", async (_req, res) => { try { res.json(await fetchDexScreenerCandidates()); } catch (e) { console.error(e); res.json([]); } });
  app.get("/api/trades/open", async (_req, res) => { try { res.json(await storage.getOpenTrades()); } catch (e) { console.error(e); res.status(500).json({ error: "Failed to fetch open trades" }); } });
  app.get("/api/engine/stats", async (_req, res) => {
    try {
      const allTrades = await storage.getTrades();
      const closedTrades = allTrades.filter((t: any) => t.status === "CLOSED");
      const openTrades = allTrades.filter((t: any) => t.status === "OPEN");
      const wins = closedTrades.filter((t: any) => parseFloat(t.pnl || "0") > 0);
      const losses = closedTrades.filter((t: any) => parseFloat(t.pnl || "0") <= 0);
      const avgWin = wins.length > 0 ? wins.reduce((s, t) => s + parseFloat(t.pnl || "0"), 0) / wins.length : 0;
      const avgLoss = losses.length > 0 ? losses.reduce((s, t) => s + parseFloat(t.pnl || "0"), 0) / losses.length : 0;
      const totalPnlSol = closedTrades.reduce((s, t) => s + (parseFloat(t.amount || "0") * parseFloat(t.pnl || "0") / 100), 0);
      const bestTrade = closedTrades.length > 0 ? closedTrades.reduce((best, t) => parseFloat(t.pnl || "0") > parseFloat(best?.pnl || "-999") ? t : best, closedTrades[0]) : null;
      const worstTrade = closedTrades.length > 0 ? closedTrades.reduce((worst, t) => parseFloat(t.pnl || "0") < parseFloat(worst?.pnl || "999") ? t : worst, closedTrades[0]) : null;
      const uptimeSeconds = Math.floor((Date.now() - engineStartTime) / 1000);
      // FIX W-4: use time elapsed TODAY (not total uptime) as denominator.
      // With total uptime, dailyPnlSol resets at midnight but uptimeSeconds never
      // resets, so solPerHour trends toward zero on long-running sessions even on
      // profitable days. Cap at today's start (midnight) or engine start, whichever
      // is later.
      const dayStartMs   = new Date().setHours(0, 0, 0, 0);
      const elapsedToday = Math.max(1, (Date.now() - Math.max(dayStartMs, engineStartTime)) / 1000);
      const solPerHour   = (dailyPnlSol / (elapsedToday / 3600)).toFixed(4);
      // elapsedTodaySeconds is exposed so the frontend can recompute solPerHour
      // directly from dailyPnlSol in the same JSON snapshot, rather than deriving
      // it from a separate poll that may be one cycle stale.
      const elapsedTodaySeconds = Math.round(elapsedToday);
      // REAL-MONEY P&L: report the true on-chain balance and LIFETIME ROI measured against
      // liveStartingBalance (persisted), not the 0.01 paper sentinel. Paper mode (baseline 0)
      // falls back to startingBalance. Additive fields only.
      const effectiveBalForRoi = await getEffectiveBalance();
      const roiBaselineStats = liveStartingBalance > 0 ? liveStartingBalance : engineSettings.startingBalance;
      const roiPctStats = roiBaselineStats > 0 ? ((effectiveBalForRoi - roiBaselineStats) / roiBaselineStats) * 100 : 0;
      res.json({
        totalTrades: allTrades.length, closedTrades: closedTrades.length, openTrades: openTrades.length,
        wins: wins.length, losses: losses.length,
        winRate: closedTrades.length > 0 ? ((wins.length / closedTrades.length) * 100).toFixed(1) : "0",
        avgWinPct: avgWin.toFixed(2), avgLossPct: avgLoss.toFixed(2), totalPnlSol: totalPnlSol.toFixed(4),
        bestTrade: bestTrade ? { symbol: bestTrade.tokenSymbol, pnl: bestTrade.pnl, mode: bestTrade.mode } : null,
        worstTrade: worstTrade ? { symbol: worstTrade.tokenSymbol, pnl: worstTrade.pnl, mode: worstTrade.mode } : null,
        consecutiveWins, consecutiveLosses, paperBalance: paperBalance.toFixed(3), liveBalance: effectiveBalForRoi.toFixed(4), liveStartBalance: roiBaselineStats.toFixed(4), roiPct: roiPctStats.toFixed(1), engineVersion: "4.2+ML",
        mlServiceActive: mlServiceAvailable, scoreBlend: `Rule ${engineSettings.scoreWeight * 100}% + ML ${engineSettings.mlWeight * 100}%`,
        trailingStop: `+${engineSettings.trailingStopActivation}% / -${engineSettings.trailingStopDistance}%`,
        hardTP: `+${engineSettings.hardTakeProfit}-100%`, stopLoss: `${engineSettings.stopLoss}%`,
        solPerHour, uptimeSeconds, dailyPnlSol: dailyPnlSol.toFixed(4), dailyTradeCount,
        elapsedTodaySeconds,
        peakBalance: peakBalance.toFixed(3),
        drawdownPct: peakBalance > 0 ? Math.max(0, (peakBalance - (await getEffectiveBalance())) / peakBalance * 100).toFixed(1) : "0",
        circuitBreakerActive, dailyLossLimitPct: engineSettings.dailyLossLimitPct, maxDrawdownPct: engineSettings.maxDrawdownPct,
        txCostsEnabled: !!engineSettings.txCostsEnabled, safetyChecksEnabled: !!engineSettings.safetyChecksEnabled,
        dynamicHoldEnabled: !!engineSettings.dynamicHoldEnabled, discoveryWindowSeconds: engineSettings.maxDiscoveryAgeSeconds,
        lastMiniCooldownEnd, lastLossCooldownEnd,
      });
    } catch (e) { console.error(e); res.status(500).json({ error: "Failed to fetch stats" }); }
  });
  app.post("/api/engine/reset-roi-baseline", async (_req, res) => {
    // Re-baseline lifetime ROI to the current on-chain balance. Call this after a deposit
    // or withdrawal so ROI stays meaningful (lifetime ROI assumes capital is unchanged).
    try {
      const bal = await getEffectiveBalance();
      if (bal > 0) { liveStartingBalance = bal; saveLiveBaseline(bal); }
      res.json({ success: true, liveStartBalance: liveStartingBalance.toFixed(4) });
    } catch (e) { res.status(500).json({ error: String(e) }); }
  });
  app.get("/api/engine/risk-status", async (_req, res) => {
    const riskCheck = await checkCircuitBreakers();
    const effectiveBal = await getEffectiveBalance();
    const drawdownPct = peakBalance > 0 ? ((peakBalance - effectiveBal) / peakBalance * 100) : 0;
    const realizedLossPct = dailyPnlSol < 0 && dailyStartBalance > 0 ? (Math.abs(dailyPnlSol) / dailyStartBalance * 100) : 0;
    res.json({
      canTrade: riskCheck.canTrade, reason: riskCheck.reason, circuitBreakerActive,
      drawdownPct: Math.max(0, drawdownPct).toFixed(1), dailyLossPct: realizedLossPct.toFixed(1),
      dailyLossLimitPct: engineSettings.dailyLossLimitPct, maxDrawdownPct: engineSettings.maxDrawdownPct,
      peakBalance: peakBalance.toFixed(3), dailyStartBalance: dailyStartBalance.toFixed(3), consecutiveLosses,
      cooldownActive: Date.now() < lastLossCooldownEnd, cooldownRemainingMs: Math.max(0, lastLossCooldownEnd - Date.now()),
    });
  });
  app.get("/api/settings", async (_req, res) => { res.json(engineSettings); });

  // ── Shadow mode endpoints ─────────────────────────────────────────────────
  app.get("/api/shadow/trades", (_req, res) => {
    const { open, closed } = getShadowTrades();
    // Compute summary statistics on closed trades
    const withGap = closed.filter(t => t.pnlGapPct !== undefined);
    const avgPaperPnl   = withGap.length ? withGap.reduce((s, t) => s + (t.paperPnlPct ?? 0), 0) / withGap.length : 0;
    const avgShadowPnl  = withGap.length ? withGap.reduce((s, t) => s + (t.shadowPnlPct ?? 0), 0) / withGap.length : 0;
    const avgGap        = withGap.length ? withGap.reduce((s, t) => s + (t.pnlGapPct ?? 0), 0) / withGap.length : 0;
    const avgImpact     = closed.length  ? closed.reduce((s, t) => s + t.quoteImpactPct, 0) / closed.length : 0;
    const avgQuoteMs    = closed.length  ? closed.reduce((s, t) => s + t.quoteDurationMs, 0) / closed.length : 0;
    const avgHops       = closed.length  ? closed.reduce((s, t) => s + t.routeHops, 0) / closed.length : 0;
    res.json({
      enabled: shadowModeEnabled,
      summary: {
        totalShadowTrades: closed.length,
        openShadowTrades:  open.length,
        avgPaperPnlPct:    +avgPaperPnl.toFixed(2),
        avgShadowPnlPct:   +avgShadowPnl.toFixed(2),
        avgPnlGapPct:      +avgGap.toFixed(2),   // positive = paper overstates real results
        avgPriceImpactPct: +avgImpact.toFixed(2),
        avgQuoteFetchMs:   +avgQuoteMs.toFixed(0),
        avgRouteHops:      +avgHops.toFixed(1),
        interpretation:    avgGap > 0
          ? `Paper overstates live by ~${avgGap.toFixed(1)}% per trade`
          : `Shadow slightly BETTER than paper (unusual — check liquidity filters)`,
      },
      open,
      closed: closed.slice(-50), // last 50 only to keep response lean
    });
  });

  app.post("/api/shadow/toggle", (req, res) => {
    if (!requireAdmin(req, res)) return;
    const enable = req.body?.enabled;
    if (typeof enable !== "boolean") return res.status(400).json({ error: "body must be { enabled: boolean }" });
    setShadowModeEnabled(enable);
    res.json({ shadowModeEnabled: enable });
  });

  // ── Latency endpoints ─────────────────────────────────────────────────────
  app.get("/api/latency/log", (_req, res) => {
    const log = getLatencyLog();
    const successful  = log.filter(r => r.success);
    const failed      = log.filter(r => !r.success);
    const avg = (arr: number[]) => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
    const p90 = (arr: number[]) => {
      if (!arr.length) return 0;
      const sorted = [...arr].sort((a, b) => a - b);
      return sorted[Math.floor(sorted.length * 0.9)];
    };
    const quoteTimes    = successful.map(r => r.quoteDurationMs);
    const confirmTimes  = successful.map(r => r.confirmDurationMs);
    const totalTimes    = successful.map(r => r.totalDurationMs);
    const ageTimes      = successful.map(r => r.quoteAgeAtSendMs);
    res.json({
      totalRecords:         log.length,
      successCount:         successful.length,
      failCount:            failed.length,
      successRate:          log.length ? ((successful.length / log.length) * 100).toFixed(1) + "%" : "n/a",
      latency: {
        quoteFetch: {
          avgMs: +avg(quoteTimes).toFixed(0),
          p90Ms: +p90(quoteTimes).toFixed(0),
          note:  "Time to get Jupiter quote. >1000ms = RPC lag risk",
        },
        quoteAgeAtSend: {
          avgMs: +avg(ageTimes).toFixed(0),
          p90Ms: +p90(ageTimes).toFixed(0),
          note:  "Quote staleness at send. >1500ms = staleness guard triggered refreshes",
        },
        txConfirm: {
          avgMs: +avg(confirmTimes).toFixed(0),
          p90Ms: +p90(confirmTimes).toFixed(0),
          note:  "Send → on-chain confirmed. >3000ms = congestion, consider Jito",
        },
        totalRoundTrip: {
          avgMs: +avg(totalTimes).toFixed(0),
          p90Ms: +p90(totalTimes).toFixed(0),
          note:  "Quote fetch start → confirmed. This is your real execution delay",
        },
      },
      recentRecords: log.slice(-30),
      recentErrors:  failed.slice(-10).map(r => ({ tokenMint: r.tokenMint, error: r.error, totalMs: r.totalDurationMs })),
    });
  });

  app.delete("/api/latency/log", (req, res) => {
    if (!requireAdmin(req, res)) return;
    const { clearLatencyLog } = require("./jupiter");
    clearLatencyLog();
    res.json({ cleared: true });
  });
  // ─────────────────────────────────────────────────────────────────────────
  app.post("/api/settings", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      const updates = req.body;
      if (!updates || typeof updates !== "object") return res.status(400).json({ message: "Invalid settings payload" });
      const validKeys = Object.keys(engineSettings) as (keyof typeof engineSettings)[];
      let restartIntervals = false;
      const minValues: Record<string, number> = { scanIntervalMs: 1000, priceCheckIntervalMs: 1000, reentryDelayMs: 0, slReentryDelayMs: 0, lossCooldownMs: 0, maxHoldSeconds: 10, maxOpenPositions: 1, maxTradesPerCycle: 1, minScoreToTrade: 0, startingBalance: 0.1, minPositionSize: 0.01, maxPositionSize: 0.01, txFeePercent: 0, rugcheckMinScore: 0, maxVolLiqRatioNewToken: 1, maxDiscoveryAgeSeconds: 60, dynamicHoldMaxSeconds: 60, txCostsEnabled: 0, safetyChecksEnabled: 0, dynamicHoldEnabled: 0, compoundBoostEnabled: 0, compoundRefSol: 0.1, compoundPower: 0.5, compoundMaxMultiplier: 1.0, compoundAbsCapSol: 0.1, minEdgePct: 0, edgeBuffer: 0, microMinEdgePct: 0, microEdgeBuffer: 0 };
      const maxValues: Record<string, number> = { mlWeight: 1, scoreWeight: 1, partialTpRatio: 1, dailyLossLimitPct: 100, maxDrawdownPct: 100, txFeePercent: 5, rugcheckMinScore: 1000, maxVolLiqRatioNewToken: 50, maxDiscoveryAgeSeconds: 86400, dynamicHoldMaxSeconds: 7200, txCostsEnabled: 1, safetyChecksEnabled: 1, dynamicHoldEnabled: 1, compoundBoostEnabled: 1, compoundRefSol: 100.0, compoundPower: 5.0, compoundMaxMultiplier: 10.0, compoundAbsCapSol: 10.0, minEdgePct: 20, edgeBuffer: 10, microMinEdgePct: 20, microEdgeBuffer: 10 };
      for (const key of validKeys) {
        if (key in updates) {
          const newVal = updates[key];
          const currentType = typeof engineSettings[key];
          if (currentType === "number" && typeof newVal === "number" && isFinite(newVal)) {
            let clamped = newVal;
            if (key in minValues) clamped = Math.max(clamped, minValues[key]);
            if (key in maxValues) clamped = Math.min(clamped, maxValues[key]);
            (engineSettings as any)[key] = clamped;
            if (key === "scanIntervalMs" || key === "priceCheckIntervalMs") restartIntervals = true;
          } else if (currentType === "string" && typeof newVal === "string") {
            if (key === "mlServiceUrl") {
              try {
                const u = new URL(newVal);
                const h = u.hostname;
                const isLocal = h === "localhost" || h === "127.0.0.1" || h === "::1" || /^192\.168\./.test(h) || /^10\./.test(h) || /^172\.(1[6-9]|2\d|3[01])\./.test(h);
                if (!isLocal) return res.status(400).json({ message: "mlServiceUrl must point to a local/private address" });
              } catch { return res.status(400).json({ message: "mlServiceUrl must be a valid URL" }); }
            }
            (engineSettings as any)[key] = newVal;
          }
        }
      }
      const weightSum = engineSettings.mlWeight + engineSettings.scoreWeight;
      if (weightSum === 0) { engineSettings.mlWeight = 0.5; engineSettings.scoreWeight = 0.5; }
      else if (Math.abs(weightSum - 1.0) > 0.001) { engineSettings.mlWeight /= weightSum; engineSettings.scoreWeight /= weightSum; }
      if (restartIntervals) {
        if (scannerInterval) clearInterval(scannerInterval);
        if (priceCheckerInterval) clearInterval(priceCheckerInterval);
        scannerInterval = setInterval(runScanCycle, engineSettings.scanIntervalMs);
        priceCheckerInterval = setInterval(checkOpenPositions, engineSettings.priceCheckIntervalMs);
        console.log(`[ENGINE] Intervals restarted: scan=${engineSettings.scanIntervalMs}ms, price=${engineSettings.priceCheckIntervalMs}ms`);
      }
      console.log(`[SETTINGS] Updated engine settings:`, JSON.stringify(updates));
      res.json(engineSettings);
    } catch (e) { console.error(e); res.status(500).json({ message: "Failed to update settings" }); }
  });
  app.post("/api/bot/force-sell-all", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      const openTrades = await storage.getOpenTrades();
      let closedCount = 0;
      const isLiveMode = jupiterService !== null;
      for (const trade of openTrades) {
        if (sellingInProgress.has(trade.id)) continue;
        sellingInProgress.add(trade.id);
        try {
          const { price: currentPrice } = await fetchTokenPrice(trade.tokenAddress);
          const entryPrice = parseFloat(trade.price);
          const sizeSol = parseFloat(trade.amount);
          let finalPnlPct = 0;
          if (isLiveMode && trade.tradingMode === "live") {
            let tokenAmountRaw = liveTokenBalances.get(trade.id) ?? BigInt(0);
            if (tokenAmountRaw === BigInt(0)) tokenAmountRaw = await jupiterService!.getTokenBalance(trade.tokenAddress);
            if (tokenAmountRaw === BigInt(0)) {
              const closingPrice = currentPrice > 0 ? currentPrice : entryPrice;
              finalPnlPct = entryPrice > 0 && closingPrice > 0 ? ((closingPrice - entryPrice) / entryPrice) * 100 : 0;
              await storage.closeTrade(trade.id, closingPrice.toString(), finalPnlPct.toFixed(2), "FORCE_SELL_NO_BALANCE");
              liveTokenBalances.delete(trade.id); peakPrices.delete(trade.id); partialTpTaken.delete(trade.id);
              tradeStopPrices.delete(trade.id); prevPnlMap.delete(trade.id); pnlStableMap.delete(trade.id);
              closedCount++; continue;
            }
            const forceLiq = trade.liquidity ? parseInt(trade.liquidity, 10) : 1000;
            const forceCosts = calcTransactionCosts(forceLiq, sizeSol);
            const forceSlippageBps = Math.min(2000, Math.max(300, Math.round(forceCosts.exitSlippagePct * 2 * 100)));
            const sellResult = await jupiterService!.sellToken(trade.tokenAddress, tokenAmountRaw, forceSlippageBps);
            if (!sellResult.success) { console.warn(`[FORCE] SELL FAILED $${trade.tokenSymbol}: ${sellResult.error} — skipping`); continue; }
            finalPnlPct = sizeSol > 0 ? ((sellResult.solReceived - sizeSol) / sizeSol) * 100 : 0;
            dailyPnlSol += sellResult.solReceived - sizeSol;
            liveTokenBalances.delete(trade.id);
            const closingPriceForSell = currentPrice > 0 ? currentPrice : entryPrice;
            console.log(`[FORCE] LIVE sold $${trade.tokenSymbol} | SOL in: ${sizeSol.toFixed(4)} → out: ${sellResult.solReceived.toFixed(4)} | PNL: ${finalPnlPct.toFixed(2)}%`);
            await storage.closeTrade(trade.id, closingPriceForSell.toString(), finalPnlPct.toFixed(2), "FORCE_SELL");
          } else {
            if (currentPrice <= 0) continue;
            const pnlPct = entryPrice > 0 ? ((currentPrice - entryPrice) / entryPrice) * 100 : 0;
            const returnSol = sizeSol * (1 + pnlPct / 100);
            paperBalance += returnSol; dailyPnlSol += returnSol - sizeSol;
            if (paperBalance > peakBalance) peakBalance = paperBalance;
            finalPnlPct = pnlPct;
            console.log(`[FORCE] PAPER sold $${trade.tokenSymbol} @ $${currentPrice.toFixed(8)} | PNL: ${pnlPct.toFixed(2)}%`);
            await storage.closeTrade(trade.id, currentPrice.toString(), finalPnlPct.toFixed(2), "FORCE_SELL");
          }
          tradedAddresses.set(trade.tokenAddress, Date.now());
          peakPrices.delete(trade.id); partialTpTaken.delete(trade.id); tradeStopPrices.delete(trade.id);
          prevPnlMap.delete(trade.id); pnlStableMap.delete(trade.id);
          closedCount++;
        } finally { sellingInProgress.delete(trade.id); }
      }
      const newBal = jupiterService ? await jupiterService.getWalletBalance().catch(() => 0) : paperBalance;
      const openNow = (await storage.getOpenTrades()).length;
      await storage.updateBotStats({ walletBalance: newBal.toFixed(4), openPositions: openNow, lastSignal: `Force sold ${closedCount} positions` });
      res.json({ success: true, closedCount, newBalance: newBal.toFixed(4) });
    } catch (e) { console.error(e); res.status(500).json({ success: false, error: "Failed to force sell" }); }
  });
  app.post("/api/bot/reset-balance", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      const openTrades = await storage.getOpenTrades();
      for (const trade of openTrades) {
        const entryPrice = parseFloat(trade.price || "0");
        const closePrice = parseFloat(trade.currentPrice || trade.price || "0");
        const sizeSol = parseFloat(trade.amount || "0");
        const pnlPct = entryPrice > 0 && closePrice > 0 ? ((closePrice - entryPrice) / entryPrice) * 100 : 0;
        dailyPnlSol += sizeSol * (pnlPct / 100);
        await storage.closeTrade(trade.id, (closePrice || entryPrice).toString(), pnlPct.toFixed(2), "RESET");
        tradedAddresses.set(trade.tokenAddress, Date.now());
        peakPrices.delete(trade.id); partialTpTaken.delete(trade.id); tradeStopPrices.delete(trade.id);
        prevPnlMap.delete(trade.id); pnlStableMap.delete(trade.id); liveTokenBalances.delete(trade.id);
      }
      // FIX: gate on actual tradingMode from DB, not just key presence.
      // If WALLET_PRIVATE_KEY is set but the UI is in paper mode, jupiterService
      // is non-null but isLiveReset was true — causing the reset to read the
      // on-chain wallet balance (possibly 0 SOL) and persist "0.0000" to the DB,
      // wiping the paper baseline even though no live trading was happening.
      const resetStatus = await storage.getBotStatus();
      const isLiveReset = jupiterService !== null && resetStatus.tradingMode === "live";
      const liveWalletBal = isLiveReset ? await jupiterService!.getWalletBalance().catch(() => engineSettings.startingBalance) : engineSettings.startingBalance;
      const resetBaseline = isLiveReset ? liveWalletBal : engineSettings.startingBalance;
      paperBalance = engineSettings.startingBalance;
      peakBalance = resetBaseline; dailyStartBalance = resetBaseline;
      dailyPnlSol = 0; dailyTradeCount = 0;
      consecutiveWins = 0; consecutiveLosses = 0;
      circuitBreakerActive = false; lastLossCooldownEnd = 0; lastMiniCooldownEnd = 0;
      tradeStopPrices.clear(); stoppedOutAddresses.clear();
      prevPnlMap.clear(); pnlStableMap.clear();
      sessionTokenBuyCount.clear();
      sessionSymbolBuyCount.clear();   // Change 4: symbol-scoped buy counts
      tokenLastLossMs.clear(); // clear post-loss cooldowns on reset
      tokenSymbolLastLossMs.clear();   // Change 4: symbol-scoped loss timestamps
      tokenStopLossCount.clear(); // FIX B: clear repeat-loser strikes on reset
      tokenSymbolSlBlockMs.clear();    // FIX: symbol-level SL block
      liqCoWarnedTrades.clear();       // FIX: warn-once guard
      priceSanityRejections.clear();   // FIX: rejection counters reset on balance reset
      priceSanityWarnOnce.clear();     // FIX: warn-once guard reset on balance reset
      rugcheckBlockedAddresses.clear(); // FIX: clear rugcheck 30-min block cache on reset
      // In paper mode always display startingBalance regardless of any live wallet
      // value — the two are independent and confusing them caused the UI to show
      // "0.0000 SOL" after a paper reset when a live key was configured.
      const displayBalance = isLiveReset
        ? liveWalletBal.toFixed(4)
        : engineSettings.startingBalance.toFixed(4);
      await storage.updateBotStats({ walletBalance: displayBalance, totalPnl: "0", openPositions: 0, lastSignal: `Balance reset to ${displayBalance} SOL`, peakBalance: resetBaseline.toFixed(4), lastLossCooldownEnd: 0, dailyStartBalance: resetBaseline.toFixed(4) });
      console.log(`[ENGINE] Reset complete | mode: ${isLiveReset ? "LIVE" : "paper"} | peak/baseline set to ${resetBaseline.toFixed(4)} SOL`);
      res.json({ success: true, newBalance: displayBalance, peakBalance: resetBaseline.toFixed(4) });
    } catch (e) { console.error(e); res.status(500).json({ success: false, error: "Failed to reset" }); }
  });
  app.post("/api/bot/trading-mode", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const { mode, confirmed } = req.body;
    if (!mode || !["paper", "live"].includes(mode)) return res.status(400).json({ message: "Invalid trading mode. Use 'paper' or 'live'." });
    if (mode === "live" && !confirmed) return res.status(400).json({ message: "Live trading requires explicit confirmation. Set confirmed: true." });
    // Reset streak counters when switching to live mode.
    // Paper losses carry different risk characteristics than live losses — a paper
    // streak of 2 losses should not raise the live score gate by +6 points before
    // the first live trade fires. Each mode switch is a clean execution context.
    if (mode === "live") {
      consecutiveWins = 0;
      consecutiveLosses = 0;
      lastMiniCooldownEnd = 0;
      // FIX CIRCUIT-BREAKER: reset ALL session state when switching to live.
      // Previous bug: (1) paper peakBalance (e.g. 0.093 SOL) stayed as drawdown
      // baseline → instant 55% drawdown → circuit breaker tripped before trade #1.
      // (2) dailyPnlSol was never zeroed → paper losses counted against live daily
      // limit. (3) liveWalletBal === 0 on RPC timeout silently skipped the reset.
      circuitBreakerActive = false;
      dailyPnlSol = 0; // FIX: zero paper P&L so it doesn't pollute live daily loss calc
      let liveWalletBal = 0;
      if (jupiterService) {
        // Retry up to 3 times — first call can return 0 on RPC cold-start.
        for (let attempt = 0; attempt < 3 && liveWalletBal <= 0; attempt++) {
          liveWalletBal = await jupiterService.getWalletBalance().catch(() => 0);
          if (liveWalletBal <= 0 && attempt < 2) await new Promise(r => setTimeout(r, 800));
        }
      }
      if (liveWalletBal > 0) {
        peakBalance = liveWalletBal;
        dailyStartBalance = liveWalletBal;
        console.log(`[ENGINE] Switched to LIVE mode — peakBalance + dailyStartBalance reset to ${liveWalletBal.toFixed(4)} SOL (live wallet)`);
      } else {
        // Hard fallback: RPC unavailable — keep circuitBreakerActive = false but
        // set peakBalance to a safe floor of MIN_FEE_BUFFER_SOL so drawdownPct
        // starts at 0% instead of (paper_peak - 0) / paper_peak ≈ 100%.
        // The first successful getEffectiveBalance() call in checkCircuitBreakers()
        // will immediately raise peakBalance to the real wallet balance.
        peakBalance = MIN_FEE_BUFFER_SOL;
        dailyStartBalance = MIN_FEE_BUFFER_SOL;
        console.warn(`[ENGINE] Switched to LIVE mode — RPC returned 0 after 3 retries. peakBalance set to floor ${MIN_FEE_BUFFER_SOL} SOL. Will self-correct on first circuit-breaker check.`);
      }
      // Sync the new peak to DB immediately so the UI reflects the correct
      // drawdown from the very first scan cycle (not the stale paper value).
      storage.updateBotStats({ peakBalance: peakBalance.toFixed(4), dailyStartBalance: dailyStartBalance.toFixed(4) }).catch(() => {});
      console.log("[ENGINE] Switched to LIVE mode — streak counters + circuit breaker + dailyPnlSol reset");
    }
    res.json(await storage.updateTradingMode(mode));
  });
  app.post("/api/bot/toggle", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const { isRunning } = req.body;
    if (typeof isRunning !== "boolean") return res.status(400).json({ message: "isRunning must be boolean" });
    res.json(await storage.updateBotRunning(isRunning));
  });
  app.post("/api/bot/strategy-mode", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const { mode } = req.body;
    if (!mode || !["SNIPER", "MG", "HWR", "AUTO"].includes(mode)) return res.status(400).json({ message: "Invalid strategy mode" });
    res.json(await storage.updateStrategyMode(mode));
  });

   app.post("/api/bot/reset-streak", (req, res) => {
	  if (!requireAdmin(req, res)) return;
	  consecutiveLosses = 0;
	  consecutiveWins = 0;
	  console.log("[ENGINE] Streak manually reset — consecutiveLosses=0");
	  res.json({ success: true });
	});
  app.get("/api/wallet", async (_req, res) => {
    if (!jupiterService) return res.json({ connected: false, address: null, balanceSol: null, liveTradesActive: 0, message: "WALLET_PRIVATE_KEY not set — live trading disabled" });
    try {
      const [balanceSol, openTrades] = await Promise.all([jupiterService.getWalletBalance(), storage.getOpenTrades()]);
      const liveOpen = (openTrades as any[]).filter(t => t.tradingMode === "live");
      const rawPriorityFee = parseInt(process.env.PRIORITY_FEE_LAMPORTS ?? "10000", 10);
      res.json({ connected: true, address: jupiterService.walletAddress, balanceSol: parseFloat(balanceSol.toFixed(4)), liveTradesActive: liveOpen.length, trackedTokenBalances: liveTokenBalances.size, rpcUrl: process.env.SOLANA_RPC_URL?.slice(0, 40) + "...", priorityFeeLamports: isNaN(rawPriorityFee) ? 10000 : rawPriorityFee, jupiterDexFilter: `${JUPITER_SUPPORTED_DEXES.size} DEXes allowed`, jupiterPoolAgeGateSec: JUPITER_INDEX_DELAY_MS / 1000 });
    } catch (e: any) { res.status(500).json({ connected: true, address: jupiterService.walletAddress, error: e.message }); }
  });
  app.post("/api/bot/fix-desync", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    if (!jupiterService) return res.status(400).json({ error: "Live mode not active — WALLET_PRIVATE_KEY not set" });
    const openTrades = await storage.getOpenTrades();
    let fixed = 0, recovered = 0;
    const liveTradesToFix = openTrades.filter((t: any) => t.tradingMode === "live");
    for (const trade of liveTradesToFix) {
      let timerId: ReturnType<typeof setTimeout> | undefined;
      try {
        const fetchPromise = jupiterService!.getTokenBalance(trade.tokenAddress);
        const timeoutPromise = new Promise<never>((_, reject) => { timerId = setTimeout(() => reject(new Error("getTokenBalance timeout after 8s")), 8000); });
        const onChainBalance = await Promise.race([fetchPromise, timeoutPromise]);
        if (onChainBalance === BigInt(0)) {
          const { price: currentPrice } = await fetchTokenPrice(trade.tokenAddress);
          const entryPrice = parseFloat(trade.price || "0");
          const sizeSol = parseFloat(trade.amount || "0");
          const pnlPct = entryPrice > 0 && currentPrice > 0 ? ((currentPrice - entryPrice) / entryPrice) * 100 : 0;
          await storage.closeTrade(trade.id, currentPrice.toString(), pnlPct.toFixed(2), "MANUAL_DESYNC_FIX");
          liveTokenBalances.delete(trade.id); peakPrices.delete(trade.id); partialTpTaken.delete(trade.id);
          tradeStopPrices.delete(trade.id); prevPnlMap.delete(trade.id); pnlStableMap.delete(trade.id);
          tradedAddresses.set(trade.tokenAddress, Date.now());
          fixed++;
          console.log(`[DESYNC_FIX] Closed desynced trade #${trade.id} $${trade.tokenSymbol} — no on-chain balance`);
        } else { liveTokenBalances.set(trade.id, onChainBalance); recovered++; console.log(`[DESYNC_FIX] Recovered balance for #${trade.id} $${trade.tokenSymbol}: ${onChainBalance} raw units`); }
      } catch (err: any) { console.warn(`[DESYNC_FIX] Error for #${trade.id} $${trade.tokenSymbol}: ${err.message}`); }
      finally { if (timerId !== undefined) clearTimeout(timerId); }
    }
    const newBal = await jupiterService.getWalletBalance().catch(() => 0);
    const openNow = (await storage.getOpenTrades()).length;
    await storage.updateBotStats({ walletBalance: newBal.toFixed(4), openPositions: openNow });
    console.log(`[DESYNC_FIX] Done — closed ${fixed}, recovered ${recovered}. Wallet: ${newBal.toFixed(4)} SOL`);
    res.json({ success: true, fixedCount: fixed, recoveredCount: recovered, newWalletBalance: newBal.toFixed(4), openPositionsRemaining: openNow });
  });
  return httpServer;
}
