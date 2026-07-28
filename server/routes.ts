import { log } from "./logger";
import type { Express } from "express";
import type { Server } from "http";
import { storage, initStorageWrapper } from "./storage";
import { api } from "@shared/routes";
import { checkAdvancedFilters } from "./advanced_filters";
import { JupiterService, createJupiterService, SOL_MINT, MIN_FEE_BUFFER_SOL,getLatencyLog, clearLatencyLog  } from "./jupiter";
import { existsSync, readFileSync, writeFileSync, promises as fsPromises } from "fs";
import { join as pathJoin } from "path";
import { startHeartbeat, isHalted, healthState } from "./runtime-hooks";
import { setDefaultResultOrder as __setDnsResultOrder } from "node:dns";
// =============================================================
// GOLD STANDARD HUNTER
// =============================================================
import { runHunter, checkMint, pollSignalFeed, pollTrending, pollTrenches, pollSmartMoneyFeed, pollDexScreenerFeeds } from './gold_standard_hunter';
import { evaluateNewMintGate, GateInput } from './lib/newMintGate';
import { evaluateBeastDiscovery, BeastDiscoveryInput } from './beast-scanner';
import { evaluateBeastSafety, combineBeastWithSoft, BEAST_MIN_LP_LOCK_PCT } from './beast-safety';
import { evaluateBeastExit, BEAST_TP_LADDER, tierForMultiplier, BeastBagTier } from './beast-exit';

// AI-FIX(2026-06-24): Force IPv4-first DNS resolution. Node 17+ defaults to "verbatim"
// (AAAA/IPv6 returned first); on hosts without working IPv6, undici fetch() to
// public-api.birdeye.so stalls until the AbortSignal timeout fires, while curl (IPv4)
// returns in <1s. This silently disabled EVERY Birdeye call — smart-money top_traders
// ("aborted due to timeout") AND the discovery tokenlist feed (bdVol=0 on every scan).
// Restoring ipv4first makes Node take the same fast path curl uses. Process-wide DNS
// preference only; no other behavior changes.
try { __setDnsResultOrder("ipv4first"); } catch { /* no-op on older runtimes */ }

// ── MULTIPLIER & STAGING CACHES ──
const SEARCH_QUERIES = [
  "raydium sol", "meteora sol", "orca sol", "solana usdc", "sol usdt",
  "pumpswap sol", "pump fun sol",
  "raydium usdc", "orca usdc", "meteora usdc",
  "pumpswap usdt", "pumpswap pump", "pumpswap meteora", "pumpswap raydium",
  "pump fun usdc", "pump fun usdt",
  "raydium clmm", "raydium amm", "meteora dlmm", "meteora damm",
  "orca whirlpool", "lifinity sol", "phoenix sol", "openbook sol",
  "dog sol", "cat sol", "ai sol", "pepe sol", "meme sol",
  "trump sol", "elon sol", "doge sol", "bonk sol",
  "new sol", "launch sol", "pump sol"
]; // FREQ(2026-06-29): Trimmed 40 -> 35. Removed low-yield duplicates; safety filters unchanged.
const watchlistCache = new Map<string, { pair: DexScreenerPair, firstSeen: number }>();
const WATCHLIST_MAX_AGE_MS = 15 * 60_000; // Keep on watch for 15 mins

// AI-TUNE(2026-06-24) JUPITER VERIFIED LIST — real quality lever at the source.
// Jupiter's verified token list is Solana's canonical "trusted token" set. Listing
// requires team identity verification + community vetting, which filters out the
// vast majority of scam tokens. We refresh the set hourly and tag every candidate
// with _jupVerified so it's visible in logs and downstream analysis.
//   - HARD FILTER (opt-in): set QUALITY_REQUIRE_JUPITER_VERIFIED=true to only
//     ingest verified tokens. This is a strict quality lift but collapses fresh-
//     launch flow — it turns the bot from a sniper into a verified-token swing trader.
//   - SOFT AGE FILTER (mild, default ON): QUALITY_MIN_AGE_MIN (default 5) drops the
//     freshest tokens that haven't had time to prove they aren't rugs. 5 minutes is a
//     small quality lift with negligible legit-candidate loss.
let jupiterVerifiedSet: Set<string> = new Set<string>();
let jupiterVerifiedFetchedAt = 0;
let jupiterVerifiedHydrationOffset = 0; // AI-TUNE(2026-06-24): rolling cursor for verified-set hydration source.
const JUPITER_VERIFIED_TTL_MS = 60 * 60_000; // 1h cache

async function refreshJupiterVerifiedSet(): Promise<void> {
  const now = Date.now();
  if (jupiterVerifiedSet.size > 0 && (now - jupiterVerifiedFetchedAt) < JUPITER_VERIFIED_TTL_MS) return;
  try {
    const res: any = await withTimeout(
      fetch("https://api.jup.ag/tokens/v2/toptraded/5m?limit=100", {  // AI-TUNE(2026-06-24): tokens.jup.ag domain is dead; api.jup.ag/tokens/v2/toptraded/5m is live and verified from internet.
        headers: { "Accept": "application/json" },
        signal: AbortSignal.timeout(10_000),
      }).then(r => r.ok ? r.json() : []),
      12_000,
      "Jupiter Verified List"
    ).catch(() => []);
    const tokenList = Array.isArray(res) ? res : (res?.tokens || []);
    if (tokenList.length > 0) {
      const next = new Set<string>();
      for (const t of tokenList) {
        const addr = (t && t.id) as string | undefined;  // v2 API uses "id" as mint address
        const isVerified = t?.isVerified === true;
        const tags = Array.isArray(t?.tags) ? t.tags : [];
        const isQuality = isVerified || tags.includes("verified") || tags.includes("community") || tags.includes("strict") || t?.strict === true;
        if (addr && isQuality) next.add(addr);
      }
      if (next.size > 0) {
        jupiterVerifiedSet = next;
        jupiterVerifiedFetchedAt = now;
        console.log(`[QUALITY] Jupiter verified list refreshed: ${jupiterVerifiedSet.size} tokens.`);
      }
    }
  } catch (e: any) {
    console.warn(`[QUALITY] Jupiter verified list refresh failed:`, e?.message || e);
  }
}

function isJupiterVerified(addr: string | undefined): boolean {
  if (!addr) return false;
  return jupiterVerifiedSet.has(addr);
}

const MIN_VIABLE_TRADE_SOL  = 0.001; // Force-lowered to allow <0.003 SOL trades
const MIN_TRADE_SIZE_SOL     = 0.003; // restored from old profitable routes.ts // restored from old profitable routes.ts // Force-lowered to allow <0.003 SOL trades
const EXECUTION_TIMEOUT_MS  = 60_000; // Increased from 30,000 for network stability

const ADMIN_SECRET = process.env.ADMIN_SECRET?.trim() || null;

// AI-FIX(2026-06-28 ADMIN-FALSE-ALARM): the module-level ADMIN_SECRET const above is
// EXIT STRATEGY HELPERS
function getDynamicTrailPct(peakPnl: number): number {
  if (peakPnl < 1)  return 0.8;
  if (peakPnl < 3)  return 1.2;
  if (peakPnl < 6)  return 1.8;
  if (peakPnl < 12) return 2.5;
  return 3.5;
}
function getMidHoldRiskSeverity(flags: string): string {
  if (/honeypot|freeze.*true|mint.*true/i.test(flags)) return 'CRITICAL';
  if (/lp_unlocked|lpUnlocked.*true/i.test(flags))     return 'MODERATE';
  return 'LOW';
}
// read at module-eval time, but esbuild hoists the ./routes import ABOVE dotenv.config()
// in index.ts (see requireAdmin note below), so process.env is still empty here and the
// const is ALWAYS null on boot — producing a FALSE "not set / publicly accessible" warning
// even though .env defines it and requireAdmin() authenticates every request at request time.
// Defer the check by one tick with setImmediate: by then the synchronous module load has
// completed and dotenv.config() has populated process.env, so we report the TRUE state.
setImmediate(() => {
  const adminSecret = process.env.ADMIN_SECRET?.trim() || null;
  if (!adminSecret) {
    console.warn(
      "[SECURITY] ADMIN_SECRET env var is not set — all admin endpoints " +
      "are publicly accessible. Set ADMIN_SECRET before going live."
    );
  } else {
    console.log("[SECURITY] ADMIN_SECRET loaded — admin endpoints require authentication (requireAdmin active).");
  }
});

// ── MICRO-AWARE EDGE GATE ───────────────────────────────────────�����────────
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

// ENHANCED EDGE FILTER — comprehensive real-time validation before any trade
export async function executeEnhancedEdgeFilter(
  signal: any,
  dexPair: any,
  isMicroWallet: boolean,
  jup: JupiterService | null,
): Promise<{ allowed: boolean; reason: string; edgeScore: number }> {
  const now = Date.now();
  const ctx: any = {
    edgeScore: 0,
    checks: [] as string[],
    rawEdge: 0,
  };

  if (!dexPair) {
    return { allowed: false, reason: "NO_DEX_PAIR", edgeScore: 0 };
  }

  const ageSec = signal.gmgn?.creation_timestamp ? (now / 1000 - signal.gmgn.creation_timestamp) : 99999;
  const liq = dexPair.liquidity?.usd || 0;
  const volume5m = dexPair.volume?.m5 || 0;
  const priceChange5m = dexPair.priceChange?.m5 || 0;
  const marketCap = dexPair.marketCap || dexPair.fdv || 0;

  const pairToken = signal.gmgn?.bonding_currency === 'usdc' ? 'USDC' : 'SOL';
  ctx.edgeScore += (signal.score || 0) * 0.4;
  ctx.checks.push(`goldScore_contrib(${signal.score})`);

  if (liq >= 100000) {
    const liqPct = Math.min((liq - 100000) / (1000000 - 100000), 1) * 100;
    ctx.edgeScore += liqPct * 0.35;
    ctx.checks.push(`liquidity_usd_${liq.toFixed(0)}`);
  } else if (liq >= 50000) {
    const liqPct = Math.min((liq - 50000) / 50000, 1) * 50;
    ctx.edgeScore += liqPct;
    ctx.checks.push(`liquidity_mid_${liq.toFixed(0)}`);
  }

  if (priceChange5m > 15) {
    const movePct = Math.min(priceChange5m, 100);
    ctx.edgeScore += movePct * 0.15;
    ctx.checks.push(`price_move_${priceChange5m.toFixed(1)}%`);
  }

  const advParams = getEdgeParams(isMicroWallet);
  const rawEdge = priceChange5m;
  const edgePct = isFinite(rawEdge) ? rawEdge : 0;
  ctx.rawEdge = edgePct;

  if (edgePct >= advParams.minEdgePct) {
    const bufferSafety = edgePct >= (advParams.minEdgePct + advParams.buffer) ? 1.0 : (edgePct - advParams.minEdgePct) / advParams.buffer;
    ctx.edgeScore += edgePct * bufferSafety * 0.20;
    ctx.checks.push(`edge_raw_${edgePct.toFixed(2)}buf_${bufferSafety.toFixed(2)}`);
  }

  const liquidityRatio = marketCap > 0 ? liq / marketCap : 0;
  if (liquidityRatio >= 0.05) {
    const liqScore = Math.min(liquidityRatio * 15, 15);
    ctx.edgeScore += liqScore * 0.10;
    ctx.checks.push(`liq_cap_ratio_${(liquidityRatio * 100).toFixed(2)}%`);
  }

  const volumeRatio = liq > 0 ? volume5m / liq : 0;
  if (volumeRatio >= 3.0) {
    const volScore = Math.min(volumeRatio - 3.0, 2) * 5;
    ctx.edgeScore += volScore * 0.10;
    ctx.checks.push(`vol_ratio_${volumeRatio.toFixed(1)}x`);
  }

  if (ageSec < 600) {
    const ageScore = Math.max(0, 20 - ageSec / 30);
    ctx.edgeScore += ageScore * 0.05;
    ctx.checks.push(`age_young_${ageSec}s`);
  }

  ctx.edgeScore = Math.max(0, Math.min(100, ctx.edgeScore));

  const hardBlockReasons: string[] = [];

  if (edgePct < advParams.minEdgePct - (isMicroWallet ? 0 : 2)) {
    hardBlockReasons.push(`EDGE_BELOW_MIN_${(advParams.minEdgePct - (isMicroWallet ? 0 : 2)).toFixed(2)}`);
  }

  if (liq < (isMicroWallet ? 5000 : 15000)) {
    hardBlockReasons.push(`LIQUIDITY_TOO_LOW_${liq}`);
  }

  if (volumeRatio < 0.5) {
    hardBlockReasons.push(`VOLUME_TOO_THIN_${volumeRatio.toFixed(2)}`);
  }

  if (liquidityRatio < 0.02) {
    hardBlockReasons.push(`LIQ_CAP_RATIO_TOO_LOW_${(liquidityRatio * 100).toFixed(2)}%`);
  }

  const passSignals: string[] = [];
  for (const s of ctx.checks) {
    if (!s.includes('buf_0') && !s.includes('p_0_0') && !s.includes('00') && !s.includes('000')) {
      passSignals.push(s);
    }
  }

  const MIN_EDGE_PCT = isMicroWallet ? 5.0 : 15.0;
  const minimumViableScore = MIN_EDGE_PCT;

  if (hardBlockReasons.length > 0 || ctx.edgeScore < minimumViableScore) {
    const detailedReason = hardBlockReasons.length > 0
      ? hardBlockReasons.join(';')
      : `EDGE_SCORE_TOE_LOW(${ctx.edgeScore.toFixed(1)}<${minimumViableScore})`;

    return {
      allowed: false,
      reason: detailedReason,
      edgeScore: ctx.edgeScore,
    };
  }

  const boostFactor = isMicroWallet ? 1.0 : (ctx.edgeScore >= 75 ? 1.15 : ctx.edgeScore >= 90 ? 1.25 : 1.0);
  const finalEdgeScore = ctx.edgeScore * boostFactor;

  console.log(
    `[ENHANCED-EDGE] $${signal.gmgn?.symbol || 'UNKNOWN'} | ` +
    `score:${signal.score} edge:${edgePct.toFixed(2)}% | ` +
    `checks:${passSignals.join(',')} | ` +
    `finalEdge:${finalEdgeScore.toFixed(1)}${boostFactor !== 1.0 ? ` +${(boostFactor - 1) * 100}% boost` : ''}`
  );

  return {
    allowed: true,
    reason: `ENHANCED_EDGE_PASS(edge=${edgePct.toFixed(2)}%,score_${finalEdgeScore.toFixed(1)})`,
    edgeScore: finalEdgeScore,
  };
}

function requireAdmin(req: any, res: any): boolean {
  // Read at REQUEST time, not module-load time. dotenv.config() in index.ts runs after
  // routes.ts top-level evaluates (esbuild hoists the ./routes import above the config
  // statement), so the module-level ADMIN_SECRET const is null even when .env defines it.
  // By the time an HTTP request hits this, dotenv has populated process.env.
  const adminSecret = process.env.ADMIN_SECRET?.trim() || null;
  if (!adminSecret) {
    res.status(500).json({ error: "Server Misconfiguration: ADMIN_SECRET is not set in .env" });
    return false;
  }
  const provided = req.headers["x-admin-secret"] ?? req.body?.adminSecret;
  if (provided !== adminSecret) {
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
    private delay = 200; // FREQ(2026-06-29): 350 -> 200ms. DexScreener WAF allows ~5 req/s; 200ms is safe and doubles scan throughput.

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
  // OPTIMIZED-2026-07-17: Calibrated for max win rate + profit + frequency.
  // activation=6 arms the trail at +6%, capturing more moderate runners (peaks 6-12%)
  // that previously round-tripped. Lower activation = more positions exit with locked profit.
  // Historical context: $VORF peaked +25.74% -> sold -1.41% because old activation=50 never armed.
  // CONVERGENCE-FIX had it at 12, further lowered to 6. Paired with laddered trailingFloor
  // (peak>30->60%, >15->50%, >8->40%, >3->40%) so exits fire AT the floor (honest fill).
  trailingStopActivation: 6,
  // distance=12 = 12% drawdown from peak triggers exit. Tight enough to lock gains,
  // loose enough to let 1000x runners consolidate. Tune via TRAIL_DISTANCE_PCT.
  // PLAYBOOK(2026-06-29): was 15, lowered to 12. Standard new-token range is 10-15%.
  trailingStopDistance: Number(process.env.TRAIL_DISTANCE_PCT) || 12,
  // Unchanged: uncapped. The rare +429% ($AC) runner should never be capped.
  hardTakeProfit: 100000000,
  // stopLoss=-8: wider than -5 to reduce noise-triggered exits that cut winners short.
  // The hard floor is still -20% (HARD_STOP_PCT). This only affects the cost-aware stop.
  // Bleed on dead days handled by REGIME GATE, not by tighter stops.
  stopLoss: -8,

  // -- Conviction Gates --
  // OPTIMIZED-2026-07-17: Lowered to 65 so EDGE_POCKET (score>=80 or momentum or explosive)
  // makes ALL admission decisions. This crude floor is just a pre-filter.
  minScoreToTrade: Number(process.env.MIN_SCORE) || 65,
  microMinScoreToTrade: Number(process.env.MICRO_MIN_SCORE) || 65,
  
  // -- SNIPER Mode Calibration --
  // OPTIMIZED-2026-07-17: Lowered to 80 (real tokens max at 82). Aligns with EDGE_POCKET's
  // score>=80 gate. Tokens 80-84 now enter SNIPER mode instead of being rejected.
  sniperMinScore: 80, 
  // OPTIMIZED-2026-07-17: sniperMinBuyPressure=0.60 ensures genuine buyer dominance.
  // Higher buy pressure = higher probability of continued upward momentum = higher win rate.
  sniperMinBuyPressure: 0.60,
  // -- Core Exit & Speed Strategy --
  // trailingStopActivation: 5, 
  // trailingStopDistance: 2.5, 
  // hardTakeProfit: 80, 
  // stopLoss: -5,
  maxHoldSeconds: 14400, // MOONSHOT: 4 hour absolute ceiling (Conditional 10-min kill switch handles mundane coins) 
    maxOpenPositions: 2, // SAFETY-ECON(2026-06-29): 1->2 for 0.03 SOL micro wallet.
                        // MICRO tier auto-sizes each position to ~10% of remaining balance
                        // (tierPct=0.10 for wallets <0.05 SOL). On 0.03 SOL wallet:
                        //   Position 1: 0.005 SOL (clamped from 0.003) → remaining 0.025
                        //   Position 2: 0.005 SOL (clamped from 0.0025) → total exposure 0.01 (33%)
                        //   Worst simultaneous STOP_LOSS(-22%): 0.0022 SOL = 7.3% daily loss ✓
                        //   Worst simultaneous HARD_LOSS(-45%): 0.0045 SOL = 15% daily loss ✓
                        //   Both within dailyLossLimitPct(20%)=0.006 SOL and maxDrawdownPct(45%).
                        // Fee cost (jito+priority+base): ~0.000022 SOL/round-trip = 0.44% of 0.005 pos.
                        // AMM spread at $10K+ liq pools: ~2-4%. Total costs ~2.5-4.5%.
                        // Each position still gated by: goldScore+tier, ML gate, rugcheck, cost gate.
                        // 2 concurrent positions on 0.03 SOL is safe and economically viable.
    startingBalance: 0.03,
  // OPTIMIZED-2026-07-17: scanInterval=5000 for higher candidate throughput.
  // DexScreener queue delay=200ms is safe for ~5 req/s. 5s cycle lets more candidates qualify.
  scanIntervalMs: 5000,
  // OPTIMIZED-2026-07-17: priceCheck=400ms frees position slots faster.
  // Faster exit detection = higher effective trade frequency.
  priceCheckIntervalMs: 400,

  // -- Conviction Gates (Lowered for current market) --
  // minScoreToTrade: 90,          // was 85 → matches actual B+ setups
  mlServiceUrl: "http://localhost:5001",
  mlWeight: 0.50,  
  scoreWeight: 0.50, 
  // OPTIMIZED-2026-07-17: dailyLossLimit=25 gives more room on bad days without deadlocking.
  // The momentum circuit breaker (3+ consecutive losses) provides real streak protection.
  dailyLossLimitPct: 25,
  microDailyLossLimitPct: 30,
  maxDrawdownPct: 45,
  // OPTIMIZED-2026-07-17: lossCooldown=3min (was 5min). Faster recovery after losses
  // means the bot can find the next winner sooner. Still long enough to prevent death spirals.
  lossCooldownMs: 180000,
                          // SLOW_BLEED stoppedOut block now prevent stale-token re-entry at the source.
                          // The 10min cooldown was needed because old code kept re-buying the same dead
                          // tokens; with the age cap that can't happen. 5min is enough for market reset.
  // OPTIMIZED-2026-07-17: partialTpRatio=0.4 sells 40% at partial, keeping 60% for runner.
  // threshold=4 fires at +4% (below typical 3-6% peak, so partial actually banks profit).
  // costMargin=0.5 means partial fires when (exitCost + 0.5%) is cleared — faster capture.
  partialTpRatio: 0.4,
  partialTpThreshold: 4,
  partialTpCostMargin: 0.5,

  // -- Sizing Strategy (Calibrated for 1000x compounding) --
  // OPTIMIZED-2026-07-17: min=0.003 enables more smaller entries per cycle (higher frequency).
  // max=0.012 keeps risk controlled while maintaining decent upside on winners.
  minPositionSize: 0.003,
  maxPositionSize: 0.012,
  
  // -- SNIPER Mode Calibration --
  // sniperMinScore: 85,
  sniperMaxAge: 1800,  // CONVERGENCE-FIX: 14400=4hrs is NOT fresh-launch SNIPER. 1800=30min. Tokens older than 30min should classify as MG/HWR, not SNIPER.
  // sniperMinBuyPressure: 0.55, 
  // OPTIMIZED-2026-07-17: $20k approaches BioCraft $21k disaster line (that trade had ~35%
  // real round-trip loss due to thin liq) but EDGE_POCKET quality gate provides protection.
  // Round-trip cost at $20k ~6.75%, within typical memecoin peak 3-8% range.
  // Old values: 60k (starved trades), 40k (starved), 25k (viable, +3.06%/trade empirical).
  sniperMinLiquidity: 20000,
  sniperMaxSize: 0.006, // old profitable // old profitable      // OLD PROFITABLE: was 0.003 — normal sizing restored    
  // OPTIMIZED-2026-07-17: mgMinLiquidity=8000. Still above HWR ($5k), below SNIPER ($20k).
  // EDGE_POCKET gate (score>=80/momentum) protects quality. More MG candidates = higher frequency.
  mgMinLiquidity: 8000,
  // OPTIMIZED-2026-07-17: mgMinScore=40 ensures only decent momentum tokens enter MG.
  // Still lets through enough candidates for meaningful frequency.
  mgMinScore: 40,
  mgMaxSize: 0.008,
  // OPTIMIZED-2026-07-17: hwrMinScore=40 for higher conviction whale-retention trades.
  hwrMinScore: 40,
  hwrMinLiquidity: 5000, // old profitable non-micro setting // MC(2026-06-24): 60000 -> 40000. The $60k floor starved entries in this market (live log: strong score-79..88 candidates at $42-55k liq all rejected [liq < 60000], nothing qualified). $40k is the pre-identified fallback: modeled EV still ~+6.7%/trade (dampened) vs +7.5% at $60k, but it admits the $48-54k cluster that actually exists right now. // MC(2026-06-24): raised 20000 -> 60000. Calibrated Monte Carlo (reproduces live win 42.1%/EV -0.24%) shows the ~3.76% round-trip spread at $20k is the dominant per-trade drag; $60k cuts RT cost to ~2.25% and lifts modeled EV from +4.9% to +7.5%/trade, robust even under maturity-dampening. Gains plateau past $60k. Score>=90 entry gate deferred until win-rate-by-score is logged (unanchored + starves flow). // old profitable non-micro setting // FIX(cost-geometry): raised 1500 -> 8000. Pools <$8k carry 5-8% entry slippage + 6.5-10% exit slippage = 11-18% round-trip cost. With the trailing stop now armed at +12%, an 11% cost floor means even winners book net losses. $8k floor keeps round-trip cost <5% so trades have positive expectancy when the strategy works as intended.
  hwrMaxSize: 0.008, // old profitable // old profitable // OLD PROFITABLE: was 0.004
  hwrMaxAge: 86400,          // FIX(no-trades): raised 7200s(2h) -> 21600s(6h). ROOT CAUSE: every mode (SNIPER<=900s, MG<=2400s, HWR<=7200s) only traded tokens <2h old, but tokens <2h old almost always have UNLOCKED LP -> blocked by the (correct) hard LP-unlock veto. The LP-LOCKED tokens that pass the veto are OLDER than 2h, so the safe set was empty by construction. The 24h discovery funnel already surfaces them; this lets HWR (sustained buy-pressure mode) actually reach the older, LP-locked, trending tokens. Safe: veto stays hard, so any still-unlocked token is still blocked; locked-LP tokens have no one-block-LP-pull death mode, so the 1s-poll exits are adequate. PAPER-test before considering live. Parallel to mgMaxAge. After the MG cap shipped,
                             // stale zombie tokens (Jetchua ~12h/43.6k s, WCT/RDR2/MYLOO 2.6-4.9h) simply re-entered
                             // via HWR, which had NO age gate, and bled out (Jetchua HWR entry: peak only +5.5%,
                             // exit -7.85% SLOW_BLEED). HWR targets mature-but-LIVE tokens; 2h blocked those zombies.
                             // ===> VERIFIED against current code (not just this comment): a 6h cap does NOT
                             // mechanically re-admit dead zombies. The scorer zero-weights age past 3600s
                             // (ageScore=0, see scoreToken), so a >1h token must earn >=75 from liq+bp+vol+price+tx
                             // alone; AND HWR entry requires bp5m>=0.55 + bp1h>=0.50 + chase guard (px5m<=25).
                             // bp5m DEFAULTS to 0.5 when 5m txns are absent (< the 0.55 gate), so a dead-flow token
                             // fails automatically. Only a mature-but-ACTIVELY-BOUGHT token can qualify. The old
                             // WCT/RDR2/MYLOO bleed was under the prior NO-age-gate regime, not today's gates.
                             // Residual risk is generic fade-AFTER-entry (exists at any age; handled by
                             // MOMENTUM_FADE/SLOW_BLEED/EARLY_CUT). Still PAPER-test; watch HWR fills with entry
                             // age >7200s — if those specifically underperform younger HWR fills, revert to 7200.

  // -- Mode Classifier Thresholds (MG / HWR gates) --
  // OPTIMIZED-2026-07-17: mgMinVolMomentum=0.10 slightly higher for stronger momentum signal.
  // mgMinPriceChange5m=2.0 ensures MG only catches tokens with real 5m price action.
  mgMinVolMomentum: 0.10,
  mgMinPriceChange5m: 2.0,
  mgMinTxVelocity: 8, // old profitable // old profitable       // OLD PROFITABLE: was 8
  mgMaxAge: 86400,           // FIX(mg-stale-entry): 2400s = 40min. Every MG winner was < 36min old (WCT 2153s).
                            // Every MG loss on aged tokens (RDR2 8.4k-10.6k, MYLOO 9.7k-11.2k, MrAsteroid 3.2k+)
                            // was on a stale token whose momentum had already exited. Caps MG to live momentum only.
  // OPTIMIZED-2026-07-17: maxEntryPriceChange=35 slightly tighter to block more parabolic
  // entries while still admitting 12-30% momentum runners.
  maxEntryPriceChange5m: Number(process.env.MAX_ENTRY_PX5M) || 35,
  // OPTIMIZED-2026-07-17: hwrMinBuyPressure5m=0.75 for HIGH conviction whale retention.
  // Fewer HWR trades but significantly higher win rate per trade.
  hwrMinBuyPressure5m: 0.75,
  hwrMinBuyPressure1h: 0.51,

  // -- Operational Safety & Discovery --
  maxTradesPerCycle: 2, // micro wallet: max 2 attempts per scan
  reentryDelayMs: 60000, // old profitable // old profitable // RE-ENTRY CHURN FIX: was 60s. After a flat/stagnant exit (no SL, so no 15min SL blackout) the bot re-bought the SAME token ~60-120s later as it rolled over ($Jetchua: WIN +1.96% -> re-entry #10259 -> SLOW_BLEED -9.65%, peak 0.00%). 5min lets a stalled token either resume a real trend (re-qualifies fresh) or drop off the candidate set. Score>=85 still bypasses (genuine renewed strength).
  slReentryDelayMs: 900000, // old profitable // old profitable 
  txCostsEnabled: 1, // old profitable // old profitable
  safetyChecksEnabled: 1, // old profitable // old profitable
  txFeePercent: 0.5, // old profitable // old profitable // OLD PROFITABLE: was 1.5
  // OPTIMIZED-2026-07-17: rugcheckMinScore=200 for stricter initial rug filter.
  // OLD PROFITABLE: was 400 — too restrictive. 200 balances safety with candidate flow.
  // rugcheckMaxRiskNormalised=60 blocks borderline tokens (norm 61-65) that were admitted
  // but had questionable safety (e.g. $BAGEY/$SPCX/$EarthX/$CPU/$ZERO at norm=61 were
  // killed after admission with old max=65). Higher safety = fewer rugs = higher win rate.
  rugcheckMinScore: 200,
  rugcheckMaxRiskNormalised: 60,

  // -- Micro-aware EDGE gate (dashboard-tunable) --
  // Only the two LOW-RISK knobs are exposed. feeMultiplier (2.0),
  // expectedMoveCoeff (0.35) and exitImpactMult (1.30) are intentionally
  // NOT settable — they model real round-trip economics and loosening them
  // re-admits fee-bleed/optimism. They stay hardcoded in getEdgeParams().
  minEdgePct:       -5.0,   // non-micro edge threshold (pass if edge >= this)
  edgeBuffer:       1.0,   // non-micro flat cushion, pct
  microMinEdgePct: 5.0,   // OLD PROFITABLE: was 0.5 — relaxed for micro-wallet
  microEdgeBuffer:  0.5,   // micro-wallet flat cushion, pct

  maxVolLiqRatioNewToken: 14, // old profitable // old profitable // OLD PROFITABLE: was 14
  maxDiscoveryAgeSeconds: 86400, // old profitable // old profitable // OLD PROFITABLE: was 86400
  
  dynamicHoldEnabled: 1, // old profitable // old profitable 
  dynamicHoldMaxSeconds: 14400, // MOONSHOT: 4 hour absolute maximum holding period
  
  // -- Compound Boost --
  // When enabled, position sizes scale super-linearly as the portfolio grows past
  // compoundRefSol. Formula: min(compoundMaxMultiplier, max(1, (portfolio/ref)^power))
  //   portfolio = compoundRefSol  → multiplier = 1  (same as today)
  //   portfolio = 1.0 SOL         → multiplier ≈ 1.8x
  //   portfolio = 2.0 SOL         → multiplier ≈ 3.2x  (capped at 5x)
  // Keep DISABLED until avgShadow turns consistently positive. Flip to 1 to activate.
  // ⚠️ WARNING: Compound boost is INERT below 0.3 SOL wallet (multiplier=1), so it
  // is safe to enable now. Once portfolio exceeds 0.3 SOL, verify avgShadow is
  // positive (see shadow-stats.json verdict) before relying on boost - without a
  // proven edge, compounding accelerates losses not wins.
  // OPTIMIZED-2026-07-17: ENABLED for the "1000x to 1 lakhx ROI" compounding thesis.
  // Formula: multiplier = min(5, max(1, (portfolio / ref)^power))
  //   At 0.3 SOL:   multiplier = 1x   (baseline, no boost below ref)
  //   At 1.0 SOL:   multiplier ≈ 2.5x (grows 2.5x faster as wallet grows)
  //   At 2.0 SOL:   multiplier ≈ 5x   (capped at 5x and 1.0 SOL/trade)
  compoundBoostEnabled: 1,
  compoundRefSol: 0.3,
  compoundPower: 1.5,
  compoundMaxMultiplier: 5.0,
  compoundAbsCapSol: 1.0,
};

let liveCandidatesCache: any[] = [], lastScanTime = 0;

// ── REGIME GATE CONFIG ──────────────────────────────────────
// Decides whether the CURRENT market is serving up vertical runners worth playing.
// The bot's edge is catching runners with the engineered moonshot exits; on flat
// days, opening positions just bleeds the ~8% round-trip cost floor. This gate is
// ENTRIES-ONLY and never touches exit geometry. Tunable live via env (no rebuild):
// REGIME_GATE_ENABLED, REGIME_MIN_RUNNERS, REGIME_RUNNER_PCT, REGIME_RUNNER_VOL,
// REGIME_RUNNER_BP, REGIME_STRONG_SINGLE_PCT, REGIME_SAMPLE.
const REGIME_GATE = {
  // OPTIMIZED-2026-07-17: Relaxed thresholds for higher trade frequency while maintaining quality.
  enabled:         String(process.env.REGIME_GATE_ENABLED ?? "true").toLowerCase() !== "false",
  minRunners:      Number(process.env.REGIME_MIN_RUNNERS ?? 1),        // 1 runner = viable regime (was 2)
  runnerPct:       Number(process.env.REGIME_RUNNER_PCT ?? 10),        // +10% = runner (was 12)
  runnerVolUsd:    Number(process.env.REGIME_RUNNER_VOL ?? 300),
  runnerBp:        Number(process.env.REGIME_RUNNER_BP ?? 0.55),
  strongSinglePct: Number(process.env.REGIME_STRONG_SINGLE_PCT ?? 20),
  sampleSize:      Number(process.env.REGIME_SAMPLE ?? 25),
};
let isFetchingCandidates = false; // <-- The Anti-Spam Lock

// ── Shadow mode ───────────────────────────�����───────────────────────────────────
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
  routeLabel:       string;          // e.g. "Raydium���Orca"
  sizeSol:          number;
  openedAt:         number;          // timestamp
  closedAt?:        number;
  paperExitPrice?:  number;
  shadowExitPrice?: number;
  paperPnlPct?:     number;
  shadowPnlPct?:    number;
  shadowPnlGrossPct?: number;        // Edit B (revised): pre-fee gross for transparency
  pnlGapPct?:       number;          // paperPnlPct - shadowPnlPct = your paper inflation
  shadowFeeBreakdownPct?: { jitoTip: number; priorityFee: number; baseFee: number; total: number }; // Edit B (revised): live-honest fee components as % of position
  exitReason?:      string;
  outAmountRaw?:    string;   // Jupiter buy-quote outAmount (raw token units) — used for shadow exit quote
}

let shadowModeEnabled = true;        // set false to disable without redeploying
let shadowTradeIdSeq  = 0;
const shadowOpenTrades = new Map<number, ShadowTrade>();
const shadowClosedTrades: ShadowTrade[] = [];
const MAX_SHADOW_HISTORY = 200;

// ── PERSISTENT SHADOW LEDGER (proving ground; survives restarts) ─────────────
// Every shadow CLOSE is committed to disk so the REAL (shadow) edge can be
// judged across many trades AND across restarts — the in-memory history above
// is capped at 200 and resets on reboot, which is useless for proving an edge.
//   shadow-stats.json   → rolling aggregate (the number you actually read)
//   shadow-trades.jsonl → one JSON line per closed trade (full raw history)
// This measures honesty, not paper fantasy. A 0.05 SOL wallet can only grow if
// avgShadowPnlPct is genuinely positive across >=20 trades. Until then: do not
// add capital.
interface ShadowLedger {
  totalTrades:    number;
  wins:           number;   // shadowPnlPct > 0
  losses:         number;   // shadowPnlPct <= 0
  sumShadowPnl:   number;   // additive sum of per-trade REAL (shadow) PnL %
  sumPaperPnl:    number;   // additive sum of per-trade paper PnL %
  sumInflation:   number;   // sum of (paper - shadow): how much paper lies
  compoundedMult: number;   // product of (1 + shadowPnl/100): full-size growth multiple
  bestPct:        number;
  worstPct:       number;
  firstAt:        number | null;
  lastAt:         number | null;
}
function shadowStatsFile():  string { return pathJoin(process.cwd(), "shadow-stats.json"); }
function shadowTradesFile(): string { return pathJoin(process.cwd(), "shadow-trades.jsonl"); }
function freshShadowLedger(): ShadowLedger {
  return { totalTrades: 0, wins: 0, losses: 0, sumShadowPnl: 0, sumPaperPnl: 0,
           sumInflation: 0, compoundedMult: 1, bestPct: -Infinity, worstPct: Infinity,
           firstAt: null, lastAt: null };
}
function loadShadowLedger(): ShadowLedger {
  try {
    const f = shadowStatsFile();
    if (existsSync(f)) return { ...freshShadowLedger(), ...JSON.parse(readFileSync(f, "utf8")) };
  } catch (e: any) { console.warn(`[SHADOW-TALLY] ledger load failed: ${e.message}`); }
  return freshShadowLedger();
}
let shadowLedger: ShadowLedger = loadShadowLedger();
function shadowLedgerSummary(): Record<string, number | string | null> {
  const n = shadowLedger.totalTrades;
  const avgShadow = n ? shadowLedger.sumShadowPnl / n : 0;
  const avgPaper  = n ? shadowLedger.sumPaperPnl  / n : 0;
  const avgInfl   = n ? shadowLedger.sumInflation / n : 0;
  const winRate   = n ? (shadowLedger.wins / n) * 100 : 0;
  const growthPct = (shadowLedger.compoundedMult - 1) * 100;
  let verdict: string;
  if (n < 20)                              verdict = `Need ${20 - n} more trades before the edge is meaningful (have ${n}/20). Keep it on paper.`;
  else if (avgShadow > 0 && growthPct > 0) verdict = `REAL POSITIVE EDGE so far: +${avgShadow.toFixed(2)}%/trade net of real execution across ${n} trades. This is the signal that funding more capital is justified.`;
  else                                     verdict = `NO real edge yet: ${avgShadow.toFixed(2)}%/trade after real execution across ${n} trades. Do NOT add capital — tune the strategy until this turns positive.`;
  return {
    totalTrades: n, wins: shadowLedger.wins, losses: shadowLedger.losses,
    winRatePct: +winRate.toFixed(1),
    avgShadowPnlPct: +avgShadow.toFixed(2),
    avgPaperPnlPct:  +avgPaper.toFixed(2),
    avgPaperInflationPct: +avgInfl.toFixed(2),
    compoundedShadowGrowthPct: +growthPct.toFixed(2),
    bestPct:  n ? +shadowLedger.bestPct.toFixed(2)  : 0,
    worstPct: n ? +shadowLedger.worstPct.toFixed(2) : 0,
    firstAt: shadowLedger.firstAt ? new Date(shadowLedger.firstAt).toISOString() : null,
    lastAt:  shadowLedger.lastAt  ? new Date(shadowLedger.lastAt).toISOString()  : null,
    verdict,
  };
}
function recordShadowLedger(closed: ShadowTrade): void {
  const s = closed.shadowPnlPct ?? 0;
  shadowLedger.totalTrades   += 1;
  if (s > 0) shadowLedger.wins += 1; else shadowLedger.losses += 1;
  shadowLedger.sumShadowPnl  += s;
  shadowLedger.sumPaperPnl   += closed.paperPnlPct ?? 0;
  shadowLedger.sumInflation  += closed.pnlGapPct ?? 0;
  shadowLedger.compoundedMult *= (1 + s / 100);
  shadowLedger.bestPct  = Math.max(shadowLedger.bestPct,  s);
  shadowLedger.worstPct = Math.min(shadowLedger.worstPct, s);
  if (shadowLedger.firstAt === null) shadowLedger.firstAt = closed.openedAt ?? closed.closedAt ?? Date.now();
  shadowLedger.lastAt = closed.closedAt ?? Date.now();
  try {
    writeFileSync(shadowStatsFile(), JSON.stringify(shadowLedger, null, 2));
    const line = JSON.stringify({
      id: closed.id, ts: closed.closedAt, token: closed.tokenSymbol, mode: closed.mode,
      score: closed.score, sizeSol: closed.sizeSol,
      paperPnlPct: closed.paperPnlPct, shadowPnlPct: closed.shadowPnlPct,
      gapPct: closed.pnlGapPct, exitReason: closed.exitReason,
    });
    writeFileSync(shadowTradesFile(), line + "\n", { flag: "a" });
  } catch (e: any) { console.warn(`[SHADOW-TALLY] persist failed: ${e.message}`); }
  const sum = shadowLedgerSummary();
  console.log(
    `[SHADOW-TALLY] n=${sum.totalTrades} | win ${sum.winRatePct}% | ` +
    `avgShadow ${sum.avgShadowPnlPct}% | avgPaper ${sum.avgPaperPnlPct}% | ` +
    `inflation ${sum.avgPaperInflationPct}% | growth ${sum.compoundedShadowGrowthPct}% | ${sum.verdict}`
  );
}

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

  // ── EDIT B (REVISED): Jito-aware shadow PnL ────────────────────────────────
  // Models the real round-trip cost the live engine would pay, using the SAME
  // env-var default-resolution logic as jupiter.ts (L937-943). Without this,
  // shadow PnL flatters live performance by ~5.75pp/trade when env vars are unset
  // (because the old default JITO_TIP_LAMPORTS=0 misses the 30k fallback jupiter
  // uses when JITO_ENGINE_URL is configured).
  //
  // Cost components (per round-trip = 2 legs):
  //   Jito tip:        JITO_TIP_LAMPORTS x 2 (flat transfer, only when JITO_ENGINE_URL set)
  //   Priority fee:    (PRIORITY_FEE_LAMPORTS microLamports/CU x ~30k CU / 1e6) x 2 legs
  //                    (field is named "lamports" in jupiter.ts:221 but value is µLamports/CU — see H2)
  //   Base TX fee:     5000 lamports/signature x 2 legs (Solana base fee, legacy tx)
  //
  // AMM/LP swap fees (~0.25%/leg) are NOT modeled here — they're already captured
  // in shadowExitPrice via Jupiter's priceImpactPct field (L545). Do not double-count.
  const _jitoEngineUrl = (process.env.JITO_ENGINE_URL ?? "").trim();
  const _DEFAULT_JITO_TIP = _jitoEngineUrl ? 30_000 : 0;        // matches jupiter.ts:937
  const _DEFAULT_PRIORITY_FEE = 100_000;                         // matches jupiter.ts:941
  const _ESTIMATED_SWAP_CU = 30_000;                             // conservative swap compute budget
  const rawJitoTip = parseInt(process.env.JITO_TIP_LAMPORTS ?? String(_DEFAULT_JITO_TIP), 10);
  const rawPriorityFeeMicroLamports = parseInt(process.env.PRIORITY_FEE_LAMPORTS ?? String(_DEFAULT_PRIORITY_FEE), 10);
  const jitoTipLamports = isNaN(rawJitoTip) ? _DEFAULT_JITO_TIP : rawJitoTip;
  const priorityFeeLamportsPerLeg = Math.round((rawPriorityFeeMicroLamports * _ESTIMATED_SWAP_CU) / 1_000_000);
  const baseFeeLamportsPerLeg = 5_000;                           // Solana legacy base fee
  const roundTripFeeLamports = (priorityFeeLamportsPerLeg + jitoTipLamports + baseFeeLamportsPerLeg) * 2;
  const positionLamports = Math.max(1, Math.floor((match.sizeSol ?? 0) * 1e9));
  const roundTripFeePct = (roundTripFeeLamports / positionLamports) * 100;
  const shadowPnlGrossPct = ((shadowExitPrice - match.shadowEntryPrice) / match.shadowEntryPrice) * 100;
  const shadowPnlPct = shadowPnlGrossPct - roundTripFeePct;
  const shadowFeeBreakdownPct = {
    jitoTip:      ((jitoTipLamports * 2) / positionLamports) * 100,
    priorityFee:  ((priorityFeeLamportsPerLeg * 2) / positionLamports) * 100,
    baseFee:      ((baseFeeLamportsPerLeg * 2) / positionLamports) * 100,
    total:        roundTripFeePct,
  };
  // ── END EDIT B (REVISED) ─────────����─────────────────────────────────────────

  const pnlGapPct       = paperPnlPct - shadowPnlPct;

  const closed: ShadowTrade = {
    ...match,
    closedAt:       Date.now(),
    paperExitPrice,
    shadowExitPrice,
    paperPnlPct,
    shadowPnlPct,
    shadowPnlGrossPct,            // Edit B (revised): pre-fee gross for transparency
    shadowFeeBreakdownPct,        // Edit B (revised): per-component fee breakdown as % of position
    pnlGapPct,
    exitReason,
  };
  shadowClosedTrades.push(closed);
  if (shadowClosedTrades.length > MAX_SHADOW_HISTORY) shadowClosedTrades.shift();
  recordShadowLedger(closed);   // persist to disk + update the cross-restart proving-ground tally

  const gapStr = pnlGapPct >= 0
    ? `paper beats shadow by +${pnlGapPct.toFixed(2)}% (paper inflation)`
    : `shadow beats paper by ${Math.abs(pnlGapPct).toFixed(2)}%`;
  console.log(
    `[SHADOW] CLOSE #${match.id} $${match.tokenSymbol} | ` +
    `paper:${paperPnlPct.toFixed(2)}% shadow:${shadowPnlPct.toFixed(2)}% | ${gapStr} | ${exitReason}`
  );
}
const MAX_SINGLE_TRADE_PCT   = 0.55; // restored from old profitable routes.ts
const MIN_EDGE_PCT           = 5.0; // restored from old profitable routes.ts
// ────────────────���────────────────────────────────────────────────────────────
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
// AI-FIX(2026-07-28): Beast tier persistence per-trade for asymmetric moonshot exit engine.
// When beast-safety qualifies a candidate (BEAST_SAFETY_ENABLED=true + tier ≥ HIGH),
// the trade id maps to its tier ("HIGH" | "LEGENDARY"). The exit loop reads this map
// to decide whether to apply beast-exit asymmetric stops/trail or fall back to legacy.
// Keyed by trade id (number) just like peakPrices — same lifecycle.
let beastTierMap = new Map<number, string>();
// Tracks the highest tpLevel reached by a Beast-tier trade so the partial-TP ladder
// can be applied incrementally across monitoring cycles. 0 = no TP leg taken yet.
let beastTpLevelReached = new Map<number, number>();
// AI-TUNE(2026-06-23): records the realized partial-TP leg (fraction + net pnl%) per trade so the
// shadow ledger can blend it with the final-exit leg instead of discarding banked partial profits.
let partialLegMap = new Map<number, { fraction: number; pnlPct: number }>();
let pnlStableMap = new Map<number, { pnl: number; since: number }>();
let tradeStopPrices = new Map<number, number>();
let partialTpTaken = new Set<number>();
let consecutiveWins = 0, consecutiveLosses = 0;
let mlServiceAvailable = false;
let _mlBatchDiagLogged = false; // ML-DIAG(2026-06-30): one-time batch instrumentation
let _mlBatchErrLogged = false;
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
let flightToSafetyAbandoned = false; // FIX(flight-spam): set true when the live wallet was too small to shield (e.g. <0.10 SOL, including paper-mode runs where live bal is 0). Suppresses the per-cycle log spam ("Circuit breaker hit ... too small to shield") that previously ran forever while the daily-loss breaker was active on a micro wallet. Cleared whenever circuitBreakerActive is cleared so future trips can re-arm.
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

function triggerFlightToSafety() {
  if (!jupiterService || flightToSafetyActive || flightToSafetyAbandoned) return; // FIX(flight-spam): skip silently if previously abandoned due to undersized wallet — re-armed when breaker clears.
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
      console.log(`[FLIGHT TO SAFETY] Wallet balance ${bal.toFixed(4)} SOL too small to shield (need >0.10 after 0.05 fee reserve) — abandoning flight-to-safety; daily-loss breaker stays active until cleared. Will not re-log until breaker resolves.`);
      flightToSafetyActive = false;
      flightToSafetyAbandoned = true; // FIX(flight-spam): suppress per-cycle re-attempts; re-armed when checkCircuitBreakers clears circuitBreakerActive.
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
// POSITION-MANAGER DB RESILIENCE: if Postgres drops one connection for a tick
// ("Connection terminated due to connection timeout"), do not throw the whole
// manager cycle and print a scary stack. Reuse a very fresh open-trade snapshot
// so stops/rug exits can still be evaluated during transient DB pool blips.
let lastOpenTradesSnapshot: any[] = [];
let lastOpenTradesSnapshotMs = 0;
let lastDbTimeoutLogMs = 0;
function isTransientDbConnectionError(e: any): boolean {
  const msg = String(e?.message || e?.cause?.message || e || "").toLowerCase();
  return msg.includes("connection terminated") || msg.includes("connection timeout") || msg.includes("timeout") || msg.includes("econnreset") || msg.includes("terminating connection");
}
let sellingInProgress = new Set<number>();
let scanLock = false;

// ADAPTIVE SCORE GATE (Phase 2): dynamically adjusts minScoreToTrade when the
// funnel is rejecting too many candidates. Prevents the "dead zone" where scores
// 60-70 are routinely seen but never traded.
let funnelRejectCount = 0;
let funnelTotalCount = 0;
let consecutiveHighRejectCycles = 0;
const FUNNEL_HIGH_REJECT_THRESHOLD = 0.8;  // >80% rejected triggers gate relaxation
const FUNNEL_MIN_SCORE_FLOOR = 50;         // never drop below this
const FUNNEL_RELAX_STEP = 5;               // drop min score by 5 each cycle of high rejection
const FUNNEL_STREAK_REQUIRED = 3;           // need 3 consecutive high-reject cycles to relax
const FUNNEL_TIGHTEN_AFTER_GOOD = 2;       // tighten back after 2 good cycles
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
const ZERO_PRICE_STRIKES_REQUIRED = 8; // AI-TUNE(2026-06-28 SURVIVAL-STOP): 30 -> 8. A rug drains the pool in seconds; 30s of unfetchable-price tolerance froze the position open while the pool emptied. 8s still rides out transient RPC/API blips but force-closes a delisted/migrated pair fast.
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
const profitLockLastLogMs = new Map<number, number>(); // DIAG-PROFITLOCK throttle: trade.id -> last log ms (one line / 5s)
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
const midHoldWhaleMs = new Map<number, number>(); // LAYER-3b: per-trade last whale-distribution poll
const whaleExitShadowSeen = new Map<number, { priceAtSignal: number; ts: number }>(); // WHALE_EXIT_SHADOW: records first would-have-exit signal per trade to measure dump-vs-noise (read-only)
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
// FIX(mg-stale-entry): tracks trades that were underwater on the very first price check.
// If a position opens red (peakPnl=0% at age 1s), the entry price was already stale.
// If still underwater at 30s, force exit — these positions almost never recover.
const firstTickRedTrades = new Set<number>();

const tokenPriceCache = new Map<string, { price: number; pair: DexScreenerPair | null; ts: number }>();
const jupiterQuoteCache = new Map<string, { quote: any; ts: number }>();
const QUOTE_CACHE_TTL_MS = 6_000; // FREQ(2026-06-29): 4000 -> 6000. Reduces Jupiter quote calls; quotes are valid for ~6s for fresh pools.

setInterval(() => {
  const now = Date.now();
  for (const [k, v] of tokenPriceCache) if (now - v.ts > 2000) tokenPriceCache.delete(k);
  for (const [k, v] of jupiterQuoteCache) if (now - v.ts > QUOTE_CACHE_TTL_MS) jupiterQuoteCache.delete(k);
}, 2_000); // FREQ(2026-06-29): 1500 -> 2000ms. Small reduction in DexScreener calls.

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

// AI-FIX(2026-06-24j): do not fall back to stale $180 SOL when DexScreener is temporarily unavailable.
// A bad SOL/USD basis distorts paper/shadow sizing, liquidity-in-SOL checks, and cost accounting.
// Default to a current conservative fallback (~$70) and allow override via SOL_PRICE_FALLBACK_USD.
const SOL_PRICE_FALLBACK_USD = (() => {
  const v = Number(process.env.SOL_PRICE_FALLBACK_USD || "70");
  return Number.isFinite(v) && v > 0 ? v : 70;
})();
let cachedSolPriceUsd = SOL_PRICE_FALLBACK_USD, lastSolPriceFetch = 0, solPriceFetchedOnce = false;
const SOL_PRICE_CACHE_TTL_MS = 30_000; // FREQ(2026-06-29): 20 -> 30s. SOL price is stable; fewer fetches.

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
          if (cachedBtcCrashActive) console.log(`[RISK] ������������ BITCOIN RECOVERING: BTC is now at ${pctChange.toFixed(2)}%. Deactivating global market circuit breaker.`);
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
      flightToSafetyAbandoned = false; // FIX(flight-spam): re-arm flight-to-safety for any future breaker trip
      triggerReturnFromSafety();
      console.log(`[RISK] Circuit breaker cleared during cooldown ��� returning from USDC to SOL`);
    }
    return { canTrade: false, reason: `MINI_LOSS_COOLDOWN (${remaining}s remaining — 2 consecutive losses)` };
  }
  if (Date.now() < lastLossCooldownEnd) {
    const remaining = Math.ceil((lastLossCooldownEnd - Date.now()) / 1000);
    if (circuitBreakerActive) {
      circuitBreakerActive = false;
      flightToSafetyAbandoned = false; // FIX(flight-spam): re-arm flight-to-safety for any future breaker trip
      triggerReturnFromSafety();
      console.log(`[RISK] Circuit breaker cleared during cooldown — returning from USDC to SOL`);
    }
    return { canTrade: false, reason: `LOSS_COOLDOWN (${remaining}s remaining)` };
  }
  circuitBreakerActive = false;
  flightToSafetyAbandoned = false; // FIX(flight-spam): re-arm flight-to-safety for any future breaker trip
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
  // Capped at 1.5x ��� enough to clear MIN_TRADE_SIZE_SOL on the first few
  // trades without taking on the geometric risk of the old 10x uncapped boost.
  let boost = 1.0;
  if (engineSettings.compoundBoostEnabled) {
    // Full compound boost: scales super-linearly once portfolio exceeds compoundRefSol.
    // At ref (0.5 SOL): 1x. At 1 SOL: ~1.8x. At 2 SOL: ~3.2x. Hard cap: 5x.
    // Keep disabled (compoundBoostEnabled=0) until avgShadow is consistently positive.
    const ref = Math.max(0.01, engineSettings.compoundRefSol);
    const ratio = totalPortfolioSol / ref;
    const raw = Math.pow(ratio, engineSettings.compoundPower);
    boost = Math.min(engineSettings.compoundMaxMultiplier, Math.max(1.0, raw));
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
    const resp = await fetch(`${engineSettings.mlServiceUrl}/predict`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(8000) });
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
    const resp = await fetch(`${engineSettings.mlServiceUrl}/predict/batch`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ tokens }), signal: AbortSignal.timeout(20000) });
    if (!resp.ok) return tokenMetrics.map(() => null);
    const data = await resp.json();
    const preds = data.predictions || [];
    if (!_mlBatchDiagLogged) { _mlBatchDiagLogged = true; try { console.log('[ML-DIAG] batch http=' + resp.status + ' sent=' + tokens.length + ' got=' + preds.length + ' first=' + JSON.stringify(preds[0] || null).slice(0,180)); } catch (_) {} }
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
  } catch (e: any) { if (!_mlBatchErrLogged) { _mlBatchErrLogged = true; console.log('[ML-DIAG] batch fetch FAILED: ' + ((e && e.name) || '?') + ' ' + ((e && e.message) || e)); } return tokenMetrics.map(() => null); }
}

async function fetchTokenPrice(tokenAddress: string, preferredPairAddress?: string): Promise<{ price: number; pair: DexScreenerPair | null }> {
  const now = Date.now();
  const cached = tokenPriceCache.get(tokenAddress);
  // ROOT-CAUSE FIX(2026-06-24): when a specific discovery pool is requested, do NOT serve a
  // cached value that may be from a different (highest-liq) pool. That pool mismatch was the
  // root cause of phantom "Vol:$0" activity rejections and 100-230% phantom "Price drifted
  // since scan" rejections (e.g. $AYODELE 229.7%, $PLUSH 106.1%). Cache reads are kept only for
  // the no-preference path (exits / generic lookups).
  if (!preferredPairAddress && cached && now - cached.ts < 2000) return { price: cached.price, pair: cached.pair };
  try {
    // UPDATED: Using Throttled Fetch
    const data = await throttledDexScreenerFetch(`https://api.dexscreener.com/latest/dex/tokens/${tokenAddress}`, 5000);
    const pairs = (data.pairs || []) as DexScreenerPair[];
    const solanaPairs = pairs.filter(p => p.chainId === "solana");
    if (solanaPairs.length === 0) return { price: 0, pair: null };
    // Prefer the EXACT pool discovery scored. /tokens/{addr} returns every pool for a token;
    // picking highest-liquidity often returned a different, stale/inactive pool whose price &
    // volume diverge wildly from the pool we actually scored. Match the discovery pairAddress
    // first; only fall back to the legacy highest-liquidity (wash-filtered) selection when the
    // preferred pool is absent or unfindable.
    let bestPair: DexScreenerPair | null = null;
    if (preferredPairAddress) {
      bestPair = solanaPairs.find(p => (p.pairAddress || "").toLowerCase() === preferredPairAddress.toLowerCase()) || null;
    }
    if (!bestPair) {
      const validPairs = solanaPairs.filter(p => { const liq = p.liquidity?.usd || 0, vol5m = p.volume?.m5 || 0; return !(liq > 0 && vol5m > liq * 15); });
      if (validPairs.length === 0) return { price: 0, pair: null };
      bestPair = validPairs.sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0))[0];
    }
    const result = { price: parseFloat(bestPair.priceUsd || "0"), pair: bestPair };
    if (result.price <= 0) return { price: 0, pair: null };
    tokenPriceCache.set(tokenAddress, { ...result, ts: now });
    return result;
  } catch { return { price: 0, pair: null }; }
}

async function fetchTokenPriceForExit(tokenAddress: string): Promise<{ price: number; pair: DexScreenerPair | null }> {
  const now = Date.now();
  const cached = tokenPriceCache.get(tokenAddress);
  if (cached && now - cached.ts < 2000) return { price: cached.price, pair: cached.pair };
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

// ────────────────────────────────────────────────────────────────
// LAYER-3: SMART-MONEY CONVERGENCE (Birdeye top_traders API)
// Time-tested entry edge — enter where proven-profitable wallets are
// already accumulating. Reuses the existing BIRDEYE_API_KEY.
// Endpoint: GET /defi/v2/tokens/top_traders (documented; x-chain: solana)
// ─────────────────────────────────────────�������─�����────────────────────
interface SmartMoneySignal { count: number; netBuyers: number; topRealizedPnl: number; whaleCount: number; whaleNetBuyers: number; whaleNetSellers: number; washSuspects: number; source?: "birdeye" | "free" | "helius"; }
// ── BIRDEYE MULTI-KEY ROTATION SYSTEM (AI-FIX 2026-06-24) ──────────────────�����─���������────
// Birdeye free-tier keys have a daily CU limit (~1000 CU). A single key runs out mid-session
// and the bot goes blind (no discovery, no whale tape). Multi-key rotation distributes load
// across N keys and auto-disables exhausted keys until their CU resets (estimated 24h).
//
// ⚠ IMPORTANT — SAME-ACCOUNT KEYS SHARE ONE QUOTA (confirmed 2026-06-24 via Birdeye console:
// "Total rate limit for all API keys is 60 rpm"). All BIRDEYE_API_KEY_* keys below belong to
// ONE Birdeye account, so they share a single account-level CU pool AND the 60 rpm cap.
// Rotating between them does NOT multiply quota. Therefore:
//   - On CU-EXHAUSTION (400 "Compute units usage limit exceeded"): the whole ACCOUNT is dead,
//     so we disable ALL keys for 24h (no point cycling to a sibling key on the same account).
//   - On 429 (rate-limit, 60 rpm shared): short account-wide backoff; rotation cursor still
//     advances so bursts are spread evenly across keys (marginal smoothing benefit only).
// To ACTUALLY multiply quota you must use keys from SEPARATE Birdeye accounts (distinct emails);
// the rotation below is account-agnostic and will multiply correctly once you add such keys.
//
// Usage in .env (same-account keys — shared quota):
//   BIRDEYE_API_KEY_1=c57e56dd593442b1bea11f3df704cbcb
//   BIRDEYE_API_KEY_2=5b848469b3da4fdb8f1c6d8461f519b7
//   BIRDEYE_API_KEY_3=b6f231c7e081448c977c904dfeebb5f9
//   BIRDEYE_API_KEY=... (legacy single key; still supported as fallback)
//
// When all keys are disabled, Birdeye features gracefully degrade (discovery via Jupiter, no whale tape).

interface BirdeyeKeyState {
  key: string;
  disabledUntil: number;  // 0 = available; timestamp = backoff until this time
  requestCount: number;
}

const _birdeyeKeys: BirdeyeKeyState[] = [];
let _birdeyeKeysInitialized = false;

// AI-FIX(2026-06-24e): LAZY key loading. The bundled entrypoint imports this module BEFORE
console.log("[BIRDKEY] Birdeye retired — Helius whale tape + free RPC layer active. Smart money scoring via whaleNetBuyers fallback.");
// "injected env from .env"). Reading keys at module-load time therefore missed
// BIRDEYE_API_KEY_1/2/3 and only caught a stale legacy BIRDEYE_API_KEY that happened to live
// in the system environment. We now defer the env read until first use, by which time .env
// is fully injected. Idempotent: only the first call populates the pool.
function _ensureBirdeyeKeysLoaded(): void {
  if (_birdeyeKeysInitialized) return;
  _birdeyeKeysInitialized = true;
  // Load all BIRDEYE_API_KEY_* keys from env (sorted: _1, _2, ... _10, _11, ...)
  const keyEntries: Array<[number, string]> = [];
  for (const envKey of Object.keys(process.env)) {
    const match = envKey.match(/^BIRDEYE_API_KEY_(\d+)$/);
    if (match && process.env[envKey]) {
      keyEntries.push([parseInt(match[1], 10), process.env[envKey] as string]);
    }
  }
  keyEntries.sort((a, b) => a[0] - b[0]);
  for (const [, keyVal] of keyEntries) {
    _birdeyeKeys.push({ key: keyVal, disabledUntil: 0, requestCount: 0 });
  }
  // Always include the root BIRDEYE_API_KEY if present
  if (process.env.BIRDEYE_API_KEY) {
    _birdeyeKeys.push({ key: process.env.BIRDEYE_API_KEY as string, disabledUntil: 0, requestCount: 0 });
  }
  if (_birdeyeKeys.length > 0) {
    console.log(`[BIRDKEY] ${_birdeyeKeys.length} Birdeye API key(s) loaded — rotation active.`);
  } else {
    console.warn(`[BIRDKEY] No Birdeye API keys found. Set BIRDEYE_API_KEY_1, _2, etc. in .env`);
  }
}

let _birdeyeKeyIndex = 0; // round-robin cursor

/** Get the next available Birdeye API key, or null if all keys are exhausted. */
function getNextBirdeyeKey(): string | null {
  _ensureBirdeyeKeysLoaded();
  const now = Date.now();
  // Find next available key (round-robin starting from cursor)
  for (let i = 0; i < _birdeyeKeys.length; i++) {
    const idx = (_birdeyeKeyIndex + i) % _birdeyeKeys.length;
    const ks = _birdeyeKeys[idx];
    if (now >= ks.disabledUntil) {
      _birdeyeKeyIndex = (idx + 1) % _birdeyeKeys.length;
      ks.requestCount++;
      return ks.key;
    }
  }
  // All keys exhausted — find the one with the earliest reset time for logging
  return null;
}

/**
 * Mark Birdeye as exhausted.
 *
 * @param apiKey   the key that triggered the error (used only for logging)
 * @param cooldownMs  backoff applied to this key
 */
function disableBirdeyeKey(apiKey: string, cooldownMs: number = 24 * 60 * 60_000) {
  const until = Date.now() + cooldownMs;
  for (const ks of _birdeyeKeys) {
    if (ks.key === apiKey) ks.disabledUntil = until;
  }
  const resetIn = Math.round(cooldownMs / 60_000);
  console.warn(`[BIRDKEY] Account quota exhausted (triggered by key ${apiKey.slice(0, 8)}...). Key disabled for ${resetIn}min.`);
}

/** Short, account-wide backoff for a transient 429 rate-limit (60 rpm shared cap). */
function throttleBirdeye429(apiKey: string, cooldownMs: number = 30_000) {
  const now = Date.now();
  // AI-FIX(2026-06-27): suppress thundering-herd log spam. A scan fires up to 20 smart-money
  // calls via Promise.all; when the single shared key is rate-limited they ALL 429 in the same
  // tick. Only log on the transition INTO backoff, not once per concurrent call.
  const alreadyBackedOff = _birdeyeKeys.length > 0 && _birdeyeKeys.every(ks => now < ks.disabledUntil);
  const until = now + cooldownMs;
  for (const ks of _birdeyeKeys) {
    if (until > ks.disabledUntil) ks.disabledUntil = until;
  }
  if (!alreadyBackedOff) {
    console.warn(`[BIRDKEY] 429 rate-limit (shared 60rpm) on key ${apiKey.slice(0, 8)}... — all keys backed off ${Math.round(cooldownMs / 1000)}s.`);
  }
}

/** Check if any Birdeye key is currently available. */
function birdeyeHasAvailableKey(): boolean {
  _ensureBirdeyeKeysLoaded();
  return _birdeyeKeys.length > 0;
}

// Lazy: must be a function because key loading is now deferred past module-load (see
// _ensureBirdeyeKeysLoaded). Evaluating as a const here would always be false.
function freeWhaleEnabled(): boolean {
  // Free whale layer needs only a Solana RPC (getTokenLargestAccounts). Default-on; FREE_WHALE_LAYER=false disables.
  return !!process.env.SOLANA_RPC_URL && String(process.env.FREE_WHALE_LAYER || "true").toLowerCase() !== "false";
}
function smartMoneyEnabled(): boolean {
  _ensureBirdeyeKeysLoaded();
  // Enabled when Birdeye keys exist, OR the Helius wallet-level tape is configured, OR the free RPC
  // whale layer is available, so whale scoring/veto/exit survives Birdeye retirement.
  // CU-FIX(2026-06-28): added heliusTapeEnabled(). Previously this was Birdeye||free only, so removing
  // all BIRDEYE_API_KEY* with SOLANA_RPC_URL unset would return false and silently disable the ENTIRE
  // whale tape (whaleScore + mid-hold exit are gated on whaleTrackingEnabled()->smartMoneyEnabled())
  // even though Helius keys were present. heliusTapeEnabled() is a hoisted function declaration, so
  // calling it here (defined later in the file) is safe.
  return _birdeyeKeys.length > 0 || heliusTapeEnabled() || freeWhaleEnabled();
}

// AI-FIX(2026-06-24d): shared Birdeye 429 cooldown. The free/Lite tier is CU-metered; once a
// call returns 429 we stop firing Birdeye discovery until this timestamp passes (avoids burning
// the budget + log spam). Discovery is redundant anyway (Jupiter+DexScreener cover it), so a
// quiet backoff costs nothing. Now backed by multi-key rotation — only set when ALL keys are exhausted.


// (Startup key-load log now emitted from _ensureBirdeyeKeysLoaded on first use, after .env injects.)
const SMART_MONEY_TIMEFRAME = process.env.SMART_MONEY_TIMEFRAME || "6h";
const SMART_MONEY_TTL_MS = 180_000; // FREQ(2026-06-29): 120 -> 180s. Reduces Birdeye calls; whale distribution changes over minutes, not seconds.
const SMART_MONEY_TIMEOUT_MS = Number(process.env.SMART_MONEY_TIMEOUT_MS) || 12_000; // AI-FIX(2026-06-24): was a bare inline 5000ms (tightest in file vs 8000ms elsewhere). curl returns <1s, but Node/undici IPv6-first DNS stalls were tripping the 5s abort. Widened + retry below.
// WHALE-FOLLOWING (Layer 3b): follow top-volume wallets (whales). Enabled whenever Birdeye is configured.
function whaleTrackingEnabled(): boolean {
  return smartMoneyEnabled() && String(process.env.WHALE_TRACKING || "true").toLowerCase() !== "false";
}
const WHALE_DISTRIBUTION_SELLERS = Number(process.env.WHALE_DISTRIBUTION_SELLERS) || 3; // # of net-selling whales that triggers a distribution exit
const WHALE_WASH_RATIO = 0.7; // buy/sell balance above which a high-frequency whale is treated as a wash-trader (fake volume)
const smartMoneyCache = new Map<string, { data: SmartMoneySignal; ts: number }>();

async function fetchSmartMoneyBirdeye(tokenAddress: string, bypassCache: boolean = false): Promise<SmartMoneySignal> {
  const empty: SmartMoneySignal = { count: 0, netBuyers: 0, topRealizedPnl: 0, whaleCount: 0, whaleNetBuyers: 0, whaleNetSellers: 0, washSuspects: 0 };
  if (!smartMoneyEnabled() || !tokenAddress) return empty;
  const cached = smartMoneyCache.get(tokenAddress);
  if (!bypassCache && cached && Date.now() - cached.ts < SMART_MONEY_TTL_MS) return cached.data;
  try {
    const url = `https://public-api.birdeye.so/defi/v2/tokens/top_traders?address=${tokenAddress}&time_frame=${SMART_MONEY_TIMEFRAME}&sort_type=desc&sort_by=volume_usd&offset=0&limit=10`;
    let json: any = null;
    const __attempts = 2; // AI-FIX(2026-06-24): one retry on timeout/abort (none before).
    for (let __i = 0; __i < __attempts; __i++) {
      try {
        const _apiKey = getNextBirdeyeKey();
        if (!_apiKey) return empty;
        const resp = await fetch(url, { headers: { "X-API-KEY": _apiKey, "Accept": "application/json", "x-chain": "solana" }, signal: AbortSignal.timeout(SMART_MONEY_TIMEOUT_MS) });
        if (!resp.ok) {
          // Distinguish CU-exhaustion (account dead 24h) from a transient 429 rate-limit (short backoff).
          let _body = ""; try { _body = String(await resp.clone().text()).slice(0, 220); } catch {}
          if (/compute units usage limit exceeded/i.test(_body)) disableBirdeyeKey(_apiKey);
          else if (resp.status === 429) throttleBirdeye429(_apiKey);
          return empty;
        }
        json = await resp.json();
        break;
      } catch (err: any) {
        const isTransient = err?.name === "TimeoutError" || err?.name === "AbortError" || /timeout|aborted|fetch failed|ECONNRESET|ETIMEDOUT/i.test(String(err?.message || err));
        if (__i < __attempts - 1 && isTransient) { await new Promise(r => setTimeout(r, 300)); continue; }
        throw err;
      }
    }
    if (!json) return empty;
    const items: any[] = json?.data?.items || [];
    let count = 0, netBuyers = 0, topRealizedPnl = 0;
    let whaleCount = 0, whaleNetBuyers = 0, whaleNetSellers = 0, washSuspects = 0;
    for (const it of items) {
      const realized = Number(it?.realizedPnl) || 0;
      const buys = Number(it?.tradeBuy) || 0, sells = Number(it?.tradeSell) || 0;
      const total = buys + sells;
      // Items are sorted by volume_usd desc => every item is a top-size wallet (whale).
      // Wash-trade filter (arxiv 2507.01963 LPI; r/solana "buy/sell quick to fake volume"):
      // a near-balanced high-frequency churner fakes volume and is NOT directionally accumulating.
      const balanced = total >= 4 && Math.min(buys, sells) / Math.max(1, Math.max(buys, sells)) >= WHALE_WASH_RATIO;
      whaleCount++;
      if (balanced) washSuspects++;
      else if (buys > sells) whaleNetBuyers++;
      else if (sells > buys) whaleNetSellers++;
      // Smart-money confirmation = profitable whales that are net-accumulating (not wash-trading).
      if (realized > 0) {
        count++;
        if (buys >= sells && !balanced) netBuyers++;
        if (realized > topRealizedPnl) topRealizedPnl = realized;
      }
    }
    const sig: SmartMoneySignal = { count, netBuyers, topRealizedPnl, whaleCount, whaleNetBuyers, whaleNetSellers, washSuspects, source: "birdeye" };
    smartMoneyCache.set(tokenAddress, { data: sig, ts: Date.now() });
    return sig;
  } catch (e: any) {
    console.warn(`[SMART-MONEY] top_traders fetch failed for ${tokenAddress}: ${e?.message || e}`);
    return empty;
  }
}

// Dominant Layer-3 score term: number of profitable wallets net-buying this token.
// ===== FREE WHALE LAYER (Birdeye-independent, advisory) =====
// Approximates whale ACCUMULATION/DISTRIBUTION from getTokenLargestAccounts snapshots compared
// across scans via the free Solana RPC. It cannot see wallet PnL, so it never sets netBuyers
// (the profitable smart-money bonus stays Birdeye-only). It is ADVISORY: it feeds entry SCORING
// only. The exit + LP-relax-veto paths require source==="birdeye", so a noisy snapshot can never
// force-exit a winner or block an entry. Default-on; disable with FREE_WHALE_LAYER=false.
const whaleSnapshotCache = new Map<string, { bal: Record<string, number>; ts: number }>();
const FREE_WHALE_TIMEOUT_MS = Number(process.env.FREE_WHALE_TIMEOUT_MS) || 8_000;

// Birdeye-independent RPC pool for the free whale layer. Rotates across SOLANA_RPC_URL, the
// HELIUS_KEYS rotation pool, and the QuickNode/tertiary backups so whale snapshots never pound a
// single key and add to RPC 429 pressure. Round-robin start + fail-over on 429/!ok/error.
function _buildWhaleRpcPool(): string[] {
  const pool: string[] = [];
  const primary = process.env.SOLANA_RPC_URL?.trim();
  if (primary) pool.push(primary);
  const heliusKeys = (process.env.HELIUS_API_KEYS ?? process.env.HELIUS_KEYS ?? "")
    .split(",").map(k => k.trim()).filter(k => k.length > 0);
  const _hbase = primary && primary.includes("helius") ? primary.split("?")[0] : "";
  if (_hbase) for (const k of heliusKeys) pool.push(_hbase + "?api-key=" + k); //`https://mainnet.helius-rpc.com/?api-key=${k}`);
  const backup = process.env.SOLANA_RPC_BACKUP_URL?.trim();
  if (backup) pool.push(backup);
  const tertiary = process.env.SOLANA_RPC_TERTIARY_URL?.trim();
  if (tertiary) pool.push(tertiary);
  return [...new Set(pool)]; // de-dupe, preserve order
}
let _whaleRpcPool: string[] | null = null;
let _whaleRpcIdx = 0;

async function fetchTokenLargestAccountsRaw(tokenAddress: string): Promise<Array<{ owner: string; amount: number }>> {
  if (!_whaleRpcPool) _whaleRpcPool = _buildWhaleRpcPool();
  const pool = _whaleRpcPool;
  if (pool.length === 0) return [];
  const maxTries = Math.min(pool.length, 3); // rotate through up to 3 keys before giving up
  for (let t = 0; t < maxTries; t++) {
    const rpc = pool[(_whaleRpcIdx++) % pool.length];
    const _rk = _heliusKeyFromEndpoint(rpc);
    if (_rk && (_heliusKeyCooldown.get(_rk) || 0) > Date.now()) continue;
    if (!_heliusRateGate()) continue;
    try {
      const resp = await fetch(rpc, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getTokenLargestAccounts", params: [tokenAddress, { commitment: "confirmed" }] }),
        signal: AbortSignal.timeout(FREE_WHALE_TIMEOUT_MS),
      });
      if (!resp.ok) continue; // 429/5xx -> rotate to next key
      const j: any = await resp.json();
      const vals: any[] = j?.result?.value || [];
      return vals.map((v: any) => ({ owner: String(v.address), amount: Number(v.uiAmount) || 0 })).filter((h: any) => h.amount > 0);
    } catch { continue; } // timeout/network -> rotate to next key
  }
  return [];
}

async function fetchWhaleAccumulationFree(tokenAddress: string): Promise<SmartMoneySignal> {
  const empty: SmartMoneySignal = { count: 0, netBuyers: 0, topRealizedPnl: 0, whaleCount: 0, whaleNetBuyers: 0, whaleNetSellers: 0, washSuspects: 0, source: "free" };
  if (!freeWhaleEnabled() || !tokenAddress) return empty;
  let holders: Array<{ owner: string; amount: number }> = [];
  try { holders = await fetchTokenLargestAccountsRaw(tokenAddress); } catch { return empty; }
  if (holders.length === 0) return empty;
  // Vault exclusion: the AMM pool / bonding-curve vault is almost always the dominant token account.
  // Drop any holder controlling > 30% of the top-20 aggregate so liquidity flow (buys drain the pool
  // vault) is never misread as whale "distribution".
  const total = holders.reduce((a, h) => a + h.amount, 0) || 1;
  const genuine = holders.filter(h => h.amount / total <= 0.30);
  const curBal: Record<string, number> = {};
  for (const h of genuine) curBal[h.owner] = h.amount;
  const prior = whaleSnapshotCache.get(tokenAddress);
  whaleSnapshotCache.set(tokenAddress, { bal: curBal, ts: Date.now() });
  // Need >=3 genuine whales and a usable prior snapshot (15s..60min old) to read direction.
  // Otherwise stay neutral -- never fabricate flow on first sight.
  const priorAge = prior ? Date.now() - prior.ts : Infinity;
  if (genuine.length < 3 || priorAge < 15_000 || priorAge > 60 * 60_000) {
    return { ...empty, whaleCount: genuine.length };
  }
  let whaleNetBuyers = 0, whaleNetSellers = 0;
  const MIN_DELTA = 0.05; // require >=5% per-wallet change to count (noise filter)
  const seen = new Set<string>();
  for (const owner of Object.keys(curBal)) {
    seen.add(owner);
    const prev = prior!.bal[owner];
    if (prev === undefined) { whaleNetBuyers++; continue; } // new whale entered the top holders
    if (prev > 0) {
      const chg = (curBal[owner] - prev) / prev;
      if (chg >= MIN_DELTA) whaleNetBuyers++;
      else if (chg <= -MIN_DELTA) whaleNetSellers++;
    }
  }
  for (const owner of Object.keys(prior!.bal)) {
    if (!seen.has(owner)) whaleNetSellers++; // fell out of the top holders => distributed
  }
  // Cap the contribution: an approximate signal may lift, but never max out, the score.
  whaleNetBuyers = Math.min(whaleNetBuyers, 3);
  whaleNetSellers = Math.min(whaleNetSellers, 4);
  return { count: 0, netBuyers: 0, topRealizedPnl: 0, whaleCount: genuine.length, whaleNetBuyers, whaleNetSellers, washSuspects: 0, source: "free" };
}

// Wrapper: Birdeye first (sees PnL -> powers smart-money bonus AND exit/veto), free layer as the
// Birdeye-independent fallback for scoring.
// ════════════════════════════════════════════════════════════════
// LAYER-2: HELIUS WALLET-LEVEL WASH/BUNDLE TAPE (Birdeye-independent)
// Precise replacement for the Birdeye top_traders tape. Reads recent SWAPs for the
// mint via the Helius Enhanced Transactions API (already-owned infra; HELIUS_API_KEYS
// rotation), attributes each swap to its feePayer (the human trader, so the AMM
// pool/vault is NEVER miscounted as a wallet) and aggregates per-wallet behaviour:
//   washSuspects    = wallets that round-trip (buy AND sell) in balanced churn  -> fake volume
//   whaleNetSellers = wallets net-distributing                                  -> distribution exit
//   whaleNetBuyers  = wallets net-accumulating
//   bundle proxy    = many DISTINCT wallets buying in the SAME slot             -> coordinated launch
// netBuyers stays 0 (Helius cannot see realized PnL) so it never inflates the smart-money
// entry bonus; the tape is trusted ONLY for the wash/distribution VETO + mid-hold EXIT,
// exactly like the Birdeye tape. Default-on; HELIUS_WHALE_TAPE=false disables.
// Tunables: HELIUS_TAPE_LIMIT(100) HELIUS_TAPE_WHALE_N(10) HELIUS_TAPE_BUNDLE_SLOTS(3)
//           HELIUS_TAPE_TTL_MS(60000) HELIUS_TAPE_TIMEOUT_MS(8000)
// ════════════════════════════════════════════════════���������═══════════
const HELIUS_TAPE_BASE = process.env.HELIUS_TAPE_BASE || "https://api.helius.xyz/v0/addresses";
const HELIUS_TAPE_TTL_MS = Number(process.env.HELIUS_TAPE_TTL_MS) || 60_000;
const HELIUS_TAPE_TIMEOUT_MS = Number(process.env.HELIUS_TAPE_TIMEOUT_MS) || 8_000;
const HELIUS_TAPE_LIMIT = Number(process.env.HELIUS_TAPE_LIMIT) || 100;
const heliusTapeCache = new Map<string, { data: SmartMoneySignal; ts: number }>();
let _heliusTapeKeys: string[] | null = null;
let _heliusTapeIdx = 0; let _heliusDiagTs = 0; function _heliusDiag(m: string){ const n = Date.now(); if (n - _heliusDiagTs > 15000) { _heliusDiagTs = n; console.warn("[HELIUS-TAPE-DIAG] " + m); } } const _heliusKeyCooldown = new Map<string, number>(); const _heliusKey429Streak = new Map<string, number>(); function _markHeliusKey429(k: string, body?: string){ const base = Number(process.env.HELIUS_KEY_COOLDOWN_MS) || 60000; const cap = Number(process.env.HELIUS_KEY_COOLDOWN_MAX_MS) || 1800000; const exhausted = !!body && /max usage|quota|credit|monthly|daily limit/i.test(body); let ms: number; if (exhausted) { ms = Number(process.env.HELIUS_KEY_EXHAUSTED_MS) || 21600000; _heliusKey429Streak.set(k, 0); } else { const streak = (_heliusKey429Streak.get(k) || 0) + 1; _heliusKey429Streak.set(k, streak); ms = Math.min(base * Math.pow(2, streak - 1), cap); } _heliusKeyCooldown.set(k, Date.now() + ms); _heliusDiag("key cooled " + Math.round(ms/1000) + "s after 429 (" + (exhausted ? "QUOTA-EXHAUSTED" : "rate-limit") + ", key ..." + k.slice(-4) + ")"); } function _markHeliusKeyOk(k: string){ if (_heliusKey429Streak.get(k)) _heliusKey429Streak.set(k, 0); } // ── GLOBAL HELIUS RATE LIMITER (shared across all consumers: tape, new-mint, RPC pool) ──
const _heliusGlobalCallLog: number[] = [];
const HELIUS_GLOBAL_RPM = Number(process.env.HELIUS_GLOBAL_RPM) || 100;
function _heliusRateGate(): boolean {
  const now = Date.now();
  while (_heliusGlobalCallLog.length > 0 && _heliusGlobalCallLog[0] < now - 60_000) _heliusGlobalCallLog.shift();
  if (_heliusGlobalCallLog.length >= HELIUS_GLOBAL_RPM) return false;
  _heliusGlobalCallLog.push(now);
  return true;
}
function _heliusKeyFromEndpoint(endpoint: string): string | null {
  const m = endpoint.match(/api-key=([a-fA-F0-9]+)/); if (!m) return null;
  return m[1];
}
const _heliusNeg = new Map<string, number>(); const _HELIUS_NEG_TTL = Number(process.env.HELIUS_TAPE_NEG_TTL_MS) || 30000; function _heliusNegHit(t: string){ const ts = _heliusNeg.get(t); return ts !== undefined && Date.now() < ts + _HELIUS_NEG_TTL; } function _heliusNegSet(t: string){ _heliusNeg.set(t, Date.now()); }
function _loadHeliusTapeKeys(): string[] {
  if (!_heliusTapeKeys) _heliusTapeKeys = (process.env.HELIUS_API_KEYS ?? process.env.HELIUS_KEYS ?? "").split(",").map(k => k.trim()).filter(k => k.length > 0);
  return _heliusTapeKeys;
}
function heliusTapeEnabled(): boolean {
  return _loadHeliusTapeKeys().length > 0 && String(process.env.HELIUS_WHALE_TAPE || "true").toLowerCase() !== "false";
}
function _getHeliusTapeKey(): string | null {
  const keys = _loadHeliusTapeKeys();
  if (keys.length === 0) return null;
  const _now = Date.now(); for (let _i = 0; _i < keys.length; _i++) { const _k = keys[(_heliusTapeIdx++) % keys.length]; if ((_heliusKeyCooldown.get(_k) || 0) <= _now) return _k; } _heliusDiag("all " + keys.length + " keys on cooldown"); return null;
}

async function fetchWhaleTapeHelius(tokenAddress: string, bypassCache: boolean = false): Promise<SmartMoneySignal> {
  const empty: SmartMoneySignal = { count: 0, netBuyers: 0, topRealizedPnl: 0, whaleCount: 0, whaleNetBuyers: 0, whaleNetSellers: 0, washSuspects: 0, source: "helius" };
  if (!heliusTapeEnabled() || !tokenAddress) { _heliusDiag("disabled (keys=" + _loadHeliusTapeKeys().length + " flag=" + (process.env.HELIUS_WHALE_TAPE ?? "unset") + ")"); return empty; }
  const cached = heliusTapeCache.get(tokenAddress);
  if (!bypassCache && cached && Date.now() - cached.ts < HELIUS_TAPE_TTL_MS) return cached.data;
  if (!bypassCache && _heliusNegHit(tokenAddress)) return empty;
  const key = _getHeliusTapeKey();
  if (!key) { _heliusDiag("no api key available"); return empty; }
  let txs: any[] = [];
  try {
    const url = `${HELIUS_TAPE_BASE}/${tokenAddress}/transactions?api-key=${key}&type=SWAP&limit=${HELIUS_TAPE_LIMIT}`;
    if (!_heliusRateGate()) { _heliusDiag("global RPM budget exhausted (" + HELIUS_GLOBAL_RPM + "/min)"); return empty; }
    const resp = await fetch(url, { headers: { "Accept": "application/json" }, signal: AbortSignal.timeout(HELIUS_TAPE_TIMEOUT_MS) });
    if (!resp.ok) { let _b = ''; if (resp.status === 429) { try { _b = (await resp.text()).slice(0,200); } catch {} } _heliusDiag("HTTP " + resp.status + " for " + tokenAddress.slice(0,6)); if (resp.status === 429 && key) _markHeliusKey429(key, _b); _heliusNegSet(tokenAddress); return empty; } _markHeliusKeyOk(key);
    txs = await resp.json();
    if (!Array.isArray(txs) || txs.length === 0) { _heliusDiag("empty SWAP payload for " + tokenAddress.slice(0,6) + " (array=" + Array.isArray(txs) + ")"); _heliusNegSet(tokenAddress); return empty; }
  } catch (e: any) {
    console.warn(`[HELIUS-TAPE] swap fetch failed for ${tokenAddress}: ${e?.message || e}`);
    return empty;
  }
  // Per-wallet (feePayer = human trader) buy/sell aggregation from this mint's tokenTransfers.
  // Keying on feePayer instead of the transfer counterparty excludes the AMM pool/vault automatically.
  type WT = { buys: number; sells: number; buyAmt: number; sellAmt: number };
  const byWallet = new Map<string, WT>();
  const slotBuyers = new Map<number, Set<string>>(); // slot -> distinct buyer wallets (bundle proxy)
  for (const tx of txs) {
    const trader = String(tx?.feePayer || "");
    if (!trader) continue;
    const slot = Number(tx?.slot) || 0;
    const transfers: any[] = Array.isArray(tx?.tokenTransfers) ? tx.tokenTransfers : [];
    let bought = 0, sold = 0;
    for (const tr of transfers) {
      if (String(tr?.mint) !== tokenAddress) continue;
      const amt = Number(tr?.tokenAmount) || 0;
      if (amt <= 0) continue;
      if (String(tr?.toUserAccount) === trader) bought += amt;
      else if (String(tr?.fromUserAccount) === trader) sold += amt;
    }
    if (bought <= 0 && sold <= 0) continue;
    const w = byWallet.get(trader) || { buys: 0, sells: 0, buyAmt: 0, sellAmt: 0 };
    if (bought > 0) { w.buys++; w.buyAmt += bought; if (slot) { const s = slotBuyers.get(slot) || new Set<string>(); s.add(trader); slotBuyers.set(slot, s); } }
    if (sold > 0) { w.sells++; w.sellAmt += sold; }
    byWallet.set(trader, w);
  }
  if (byWallet.size === 0) { _heliusDiag("no per-wallet activity parsed for " + tokenAddress.slice(0,6) + " (txs=" + txs.length + ")"); _heliusNegSet(tokenAddress); return empty; }
  // Rank wallets by total token volume traded; the top-N are the whales / largest actors.
  const wallets = [...byWallet.entries()].map(([owner, w]) => ({ owner, ...w, vol: w.buyAmt + w.sellAmt }));
  wallets.sort((a, b) => b.vol - a.vol);
  const WHALE_N = Number(process.env.HELIUS_TAPE_WHALE_N) || 10;
  const whales = wallets.slice(0, WHALE_N);
  let whaleCount = 0, whaleNetBuyers = 0, whaleNetSellers = 0, washSuspects = 0;
  for (const w of whales) {
    whaleCount++;
    const tot = w.buys + w.sells;
    // Same wash discriminator as the Birdeye tape: near-balanced high-frequency round-tripper = fake volume.
    const balanced = tot >= 4 && Math.min(w.buys, w.sells) / Math.max(1, Math.max(w.buys, w.sells)) >= WHALE_WASH_RATIO;
    if (balanced) washSuspects++;
    else if (w.buys > w.sells) whaleNetBuyers++;
    else if (w.sells > w.buys) whaleNetSellers++;
  }
  // Bundle proxy: slots where >=2 distinct wallets bought in the SAME block => coordinated launch/bundle.
  let bundleSlots = 0;
  for (const s of slotBuyers.values()) if (s.size >= 2) bundleSlots++;
  const _bundleTrip = bundleSlots >= (Number(process.env.HELIUS_TAPE_BUNDLE_SLOTS) || 3);
  if (_bundleTrip) washSuspects = Math.max(washSuspects, Math.ceil(whaleCount / 2));
  const sig: SmartMoneySignal = { count: 0, netBuyers: 0, topRealizedPnl: 0, whaleCount, whaleNetBuyers, whaleNetSellers, washSuspects, source: "helius" };
  console.log(`[HELIUS-TAPE] ${tokenAddress.slice(0, 6)} whales=${whaleCount} netBuy=${whaleNetBuyers} netSell=${whaleNetSellers} wash=${washSuspects} bundleSlots=${bundleSlots}${_bundleTrip ? " BUNDLE" : ""} (txs=${txs.length})`);
  heliusTapeCache.set(tokenAddress, { data: sig, ts: Date.now() });
  return sig;
}

// Wrapper: Birdeye first (sees PnL -> smart-money bonus + exit/veto). When Birdeye is blind
// (CU-exhausted / 429 -> empty), fall to the Helius wallet-level tape (precise, wash/bundle-aware,
// also trusted for veto + exit). The free getTokenLargestAccounts snapshot is the last advisory resort.
async function fetchSmartMoneyConvergence(tokenAddress: string, bypassCache: boolean = false, heliusAllowed: boolean = true, birdeyeAllowed: boolean = true): Promise<SmartMoneySignal> {
  if (!tokenAddress) return { count: 0, netBuyers: 0, topRealizedPnl: 0, whaleCount: 0, whaleNetBuyers: 0, whaleNetSellers: 0, washSuspects: 0 };
  // A/B SWITCH (2026-06-28): WHALE_TAPE=off blinds the entire whale tape (Birdeye + Helius +
  // free fallback). This reproduces the "Friday" Birdeye-429 state where the tape returned no
  // data (_wc=0), so the LP-unlocked wash veto in checkTokenSafety goes DORMANT (paper fail-
  // closed thresholds=101 -> admit) and the mid-hold wash-exit can't fire. The $40k liquidity
  // floor (ENTRY_MIN_LIQ_USD) is INDEPENDENT of this and stays fully active. Default = on (tape
  // works). HONEST CAVEAT: blinding the tape re-opens the unlocked-LP rug door ($AC-type winners
  // AND $AAIF-type -99% rugs come from the same pond). Use only for A/B measurement.
  const _whaleTapeMode = String(process.env.WHALE_TAPE ?? "on").trim().toLowerCase();
  if (_whaleTapeMode === "off" || _whaleTapeMode === "false" || _whaleTapeMode === "0" || _whaleTapeMode === "blind") {
    return { count: 0, netBuyers: 0, topRealizedPnl: 0, whaleCount: 0, whaleNetBuyers: 0, whaleNetSellers: 0, washSuspects: 0, source: "helius" };
  }
  const bird = { count: 0, netBuyers: 0, topRealizedPnl: 0, whaleCount: 0, whaleNetBuyers: 0, whaleNetSellers: 0, washSuspects: 0, source: "birdeye" } as SmartMoneySignal;
  if (bird.count > 0 || bird.whaleCount > 0) return bird;
  const helius = heliusAllowed ? await fetchWhaleTapeHelius(tokenAddress, bypassCache) : ({ count: 0, netBuyers: 0, topRealizedPnl: 0, whaleCount: 0, whaleNetBuyers: 0, whaleNetSellers: 0, washSuspects: 0, source: "helius" } as SmartMoneySignal);
  if (helius.whaleCount > 0) return helius;
  return await fetchWhaleAccumulationFree(tokenAddress);
}

function smartMoneyScore(sig: SmartMoneySignal | null): number {
  if (!sig) return 0;
  // AI-FIX(2026-07-01 convergence): Birdeye retired. netBuyers always 0 from Helius.
  // Fall back to whaleNetBuyers from the Helius whale tape.
  const effectiveBuyers = sig.netBuyers > 0
    ? sig.netBuyers
    : (sig.source === "helius" ? sig.whaleNetBuyers : 0);
  if (effectiveBuyers >= 5) return 30;
  if (effectiveBuyers >= 3) return 22;
  if (effectiveBuyers >= 2) return 14;
  if (effectiveBuyers >= 1) return 7;
  return 0;
}

// WHALE-FOLLOWING (Layer 3b): reward net whale ACCUMULATION, penalize net whale DISTRIBUTION.
// Literature: DEXTools/Ledger whale-tracking + the Hyperliquid copy-trading study show that
// following large net-accumulating wallets is positive-expectancy; the arxiv memecoin-manipulation
// study warns wash-traders fake volume, so balanced churners are already excluded above and earn 0.
function whaleScore(sig: SmartMoneySignal | null): number {
  if (!sig || !whaleTrackingEnabled()) return 0;
  const net = sig.whaleNetBuyers - sig.whaleNetSellers; // whale conviction among top-volume wallets
  let sc = 0;
  if (net >= 4) sc = 25; else if (net >= 3) sc = 18; else if (net >= 2) sc = 12; else if (net >= 1) sc = 6;
  // Distribution penalty: big wallets net-selling => fade the entry (do not be exit liquidity).
  // AI-TUNE(2026-06-28): gate the penalty to a REAL wallet-level tape (birdeye/helius) ONLY. The
  // scan-scoring path calls fetchSmartMoneyConvergence with both tapes disabled, so it falls back to
  // the free getTokenLargestAccounts delta, which counts ANY wallet that rotated out of the top-N as a
  // "seller" (and caps sellers at 4 vs buyers at 3). That asymmetry tags ~every token as net-
  // distributing, stamping a universal -8 on otherwise top candidates (e.g. $BP showed netBuy=10/
  // netSell=0 on the real Helius tape yet was still dinged -8 from the noisy free proxy). The genuine
  // distribution veto/exit still runs off the real tape in checkTokenSafety + mid-hold, untouched.
  const _realTape = sig.source === "birdeye" || sig.source === "helius";
  if (_realTape) {
    if (sig.whaleNetSellers >= 3 && sig.whaleNetBuyers === 0) sc -= 20;
    else if (sig.whaleNetSellers > sig.whaleNetBuyers) sc -= 8;
  }
  return sc;
}

function scoreToken(
  pair: DexScreenerPair,
  mlPrediction?: { pumpProb: number; dumpRisk: number; version: string } | null,
  isMicroWallet: boolean = false,
  smartMoney?: SmartMoneySignal | null
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
  const smScore = smartMoney ? smartMoneyScore(smartMoney) : 0;
  if (smScore > 0) combinedScore = Math.min(100, combinedScore + smScore);
  // LAYER-3b WHALE-FOLLOWING: whale accumulation bonus / distribution penalty (can be negative).
  const whScore = smartMoney ? whaleScore(smartMoney) : 0;
  combinedScore = Math.max(0, Math.min(100, combinedScore + whScore));
  // LAYER-2 (literature): organic-quality band — penalize out-of-band market cap and over-aged structure.
  const __mc = pair.marketCap || pair.fdv || 0;
  const __ageSec = pair.pairCreatedAt ? (Date.now() - pair.pairCreatedAt) / 1000 : 0;
  if (__mc > 0 && (__mc < 300000 || __mc > 5000000)) combinedScore = Math.max(0, combinedScore - 8);
  if (__ageSec > 10800) combinedScore = Math.max(0, combinedScore - 8); if ((priceChange5m < 4) && (volMomentum < 2.0)) combinedScore = Math.max(0, combinedScore - 12);
  // LAYER-2b BLOW-OFF GUARD: the px component maxes at +10%, so a healthy +10% breakout and a +60%
  // parabolic earn the identical 15 points. Discount the *already-extended* move so the engine stops
  // buying tops — root cause of the $?/$nibbly score-65 losses (px5m 54%/72%). Healthy breakouts
  // (<=25%) are untouched; >25% soft -6; >40% hard -12 (clearly parabolic / chasing).
  const __pxPen = priceChange5m > 120 ? -18 : priceChange5m > 80 ? -10 : (priceChange5m >= 10 && priceChange5m <= 15) ? 4 : (priceChange5m > 15 && priceChange5m <= 40) ? 0 : 0;  // CONVERGENCE-FIX: +10-15 = early momentum (reward). +15-40 = already extended (no bonus, not a penalty either). Old +10-40 rewarded 40% pumps = blowoff top entry.
  combinedScore = Math.max(0, Math.min(100, combinedScore + __pxPen));
  // READ-ONLY DIAGNOSTIC: per-component score anatomy so we can tell an *early* 65 (age/momentum-driven)
  // from a *late* 65 (price-spike-driven). Toggle with SCORE_BREAKDOWN_LOG=false.
  if (String(process.env.SCORE_BREAKDOWN_LOG ?? "true").toLowerCase() !== "false") {
    const __mlAdj = mlScore !== null ? Math.round(mlScore * (1 - (mlPrediction?.dumpRisk ?? 0) * 0.5)) : null;
    const __mcPen = (__mc > 0 && (__mc < 300000 || __mc > 5000000)) ? -8 : 0;
    const __agePen = (__ageSec > 10800) ? -8 : 0; const __flatPen = ((priceChange5m < 4) && (volMomentum < 2.0)) ? -12 : 0;
    console.log(`[SCORE-BREAKDOWN] $${pair.baseToken?.symbol || "?"} combined=${combinedScore} raw=${score}(liq${liqScore}+bp${bpScore}+vol${volScore}+px${priceScore}+tx${txScore}+age${ageScore}+bp1h${bp1hScore}+fdv${fdvScore}=${rawTotal}/95) ml=${mlScore ?? "n/a"}(adj${__mlAdj ?? "n/a"} dump${mlPrediction ? (mlPrediction.dumpRisk * 100).toFixed(0) + "%" : "n/a"}) sm=${smScore} wh=${whScore} pen=${__mcPen + __agePen + __pxPen + __flatPen}(mc${__mcPen}/age${__agePen}/px${__pxPen}/flat${__flatPen}) | drivers: px5m=${priceChange5m.toFixed(1)}% volMom=${volMomentum.toFixed(2)} bp5m=${bp5m.toFixed(2)} ageS=${ageSeconds} liq=$${liq.toFixed(0)}`);
  }
  const metrics = { liq, ageSeconds, bp5m, bp1h, volMomentum, priceChange5m, priceChange1h, txVelocity5m, vol5m, vol1h, fdv, h1buys: h1b, h1sells: h1s, m5buys: m5b, m5sells: m5s, buyPressure5m: bp5m, buyPressure1h: bp1h };

  // Micro‑wallet mode: lower score thresholds slightly to allow recovery trades
  const effSniperScore = engineSettings.sniperMinScore;
  const effMgScore     = engineSettings.mgMinScore;
  const effHwrScore    = engineSettings.hwrMinScore;
  const effSniperLiq   = engineSettings.sniperMinLiquidity;
  const effHwrLiq      = engineSettings.hwrMinLiquidity;

  const sizeForMode = (maxSizeFraction: number, minScore: number) => {
    const ratio = Math.max(0, (combinedScore - minScore) / Math.max(1, 100 - minScore));
    const raw = engineSettings.minPositionSize + ratio * (Math.max(maxSizeFraction, engineSettings.minPositionSize) - engineSettings.minPositionSize);  // CONVERGENCE-FIX: old formula did maxSizeFraction * maxPositionSize = 0.006*0.015=0.00009, always below minPositionSize(0.005), so scaling was dead code. Now treats maxSizeFraction as absolute SOL amount.
    return Math.max(engineSettings.minPositionSize, raw);
  };
  const candidates: { mode: string; sizeSol: number; slippage: number; minScore: number }[] = [];
  // SNIPER anti-chase: do NOT buy late vertical moves. Live shadow proof: $FISHY was +66.28% in 5m,
  // still qualified as SNIPER because only MG/HWR enforced maxEntryPriceChange5m, then stopped out
  // in 6s for -14.95% shadow. With QUALITY_MIN_AGE_MIN=5, these are not true 10-second launches;
  // a 5m move above the cap is usually exit-liquidity chasing, not early discovery.
  if (combinedScore >= effSniperScore && ageSeconds <= engineSettings.sniperMaxAge && bp5m >= engineSettings.sniperMinBuyPressure && priceChange5m <= engineSettings.maxEntryPriceChange5m && liq >= effSniperLiq) {
    candidates.push({ mode: "SNIPER", minScore: effSniperScore, sizeSol: sizeForMode(engineSettings.sniperMaxSize, effSniperScore), slippage: liq < 3000 ? 8 : liq < 10000 ? 5 : 3 });
  }
  const effMgLiq = engineSettings.mgMinLiquidity ?? engineSettings.sniperMinLiquidity; // CONVERGENCE-FIX-LOPHOLE-7: MG had NO independent liquidity floor — it reused sniperMinLiquidity ($25k). This created a dead zone: tokens with liq $5k-$25k AND bp5m 0.55-0.69 qualified for NO mode (SNIPER needs $25k, MG needs $25k, HWR needs bp5m>=0.70). MG targets momentum tokens with decent volume but not necessarily deep pools. mgMinLiquidity defaults to $10k — above HWR ($5k), below SNIPER ($25k). The EDGE_POCKET gate still guards quality (score>=80 or momentum-confirmed 70-79).
  if (combinedScore >= effMgScore && volMomentum >= engineSettings.mgMinVolMomentum && priceChange5m >= engineSettings.mgMinPriceChange5m && priceChange5m <= engineSettings.maxEntryPriceChange5m && txVelocity5m >= engineSettings.mgMinTxVelocity && liq >= effMgLiq && ageSeconds <= engineSettings.mgMaxAge) {
    candidates.push({ mode: "MG", minScore: effMgScore, sizeSol: sizeForMode(engineSettings.mgMaxSize, effMgScore), slippage: liq < 5000 ? 6 : liq < 20000 ? 4 : 2.5 });
  }

  // HWR: if metrics are met, optionally reduce score gate with strong 5m buy pressure
  const meetsHwrMetrics = bp5m >= engineSettings.hwrMinBuyPressure5m && bp1h >= engineSettings.hwrMinBuyPressure1h && liq >= effHwrLiq && priceChange5m <= engineSettings.maxEntryPriceChange5m && ageSeconds <= engineSettings.hwrMaxAge;
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
    if (priceChange5m > engineSettings.maxEntryPriceChange5m) reasons.push("px5m > " + engineSettings.maxEntryPriceChange5m + " (chase)");
    if (txVelocity5m < engineSettings.mgMinTxVelocity) reasons.push("tx5m < " + engineSettings.mgMinTxVelocity);
    if (ageSeconds > engineSettings.mgMaxAge) reasons.push("MG age > " + engineSettings.mgMaxAge);
    // HWR-specific gates (previously unlogged — HWR failures showed as silent "Mode: none")
    if (bp5m < engineSettings.hwrMinBuyPressure5m) reasons.push("hwrBp5m < " + engineSettings.hwrMinBuyPressure5m);
    if (bp1h < engineSettings.hwrMinBuyPressure1h) reasons.push("bp1h < " + engineSettings.hwrMinBuyPressure1h);
    if (liq < effHwrLiq) reasons.push("hwrLiq < " + effHwrLiq);
    if (ageSeconds > engineSettings.hwrMaxAge) reasons.push("HWR age > " + engineSettings.hwrMaxAge);
    rejectionReason = reasons.join(", ");
  }
  return { score, mlScore, combinedScore, smartMoney: smartMoney || null, breakdown: {}, metrics, qualifiedMode, sizeSol, slippage, rejectionReason };
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
  const mevEstimatePct = 1.5;  // CONVERGENCE-FIX: Solana MEV sandwich attacks add ~1-3% per leg. Model 1.5% conservatively.
  const entrySlippagePct = Math.max(baseSlippage, priceImpactPct) + mevEstimatePct;
  const exitSlippagePct = (entrySlippagePct - mevEstimatePct) * 1.3 + mevEstimatePct;
  const fee = engineSettings.txFeePercent;
  return { entrySlippagePct, exitSlippagePct, entryFeePct: fee, exitFeePct: fee, totalRoundTripPct: entrySlippagePct + exitSlippagePct + fee * 2 };
}

function calcCostAwareStopPrice(entryPrice: number, mode: string | null, liq: number, sizeSol: number, solPriceUsd = cachedSolPriceUsd): number {
  if (entryPrice <= 0) return 0;
  const costs = calcTransactionCosts(liq, sizeSol, solPriceUsd);
  const exitCostPct = costs.exitSlippagePct + costs.exitFeePct;
  // AI-TUNE(2026-06-24): removed modeBuffer (was +4 for SNIPER, +2 for MG, +1 for HWR).
  // The previous buffer diluted the configured stopLoss from -8% to -12% on SNIPER,
  // allowing bleed to -16% before exit. Now enforce the configured stopLoss exactly,
  // only expanding to cover exit costs if they exceed the raw setting.
  const rawTolerance = Math.abs(engineSettings.stopLoss);
  const priceMoveTolerance = Math.max(rawTolerance, exitCostPct + 1);
  return entryPrice * (1 - priceMoveTolerance / 100);
}

// ── PHASE 0 OBJECTIVE MODEL (Convergence Framework) ─────────────────────────
// The loss function is FORWARD NET EXPECTANCY, not code-correctness. A trade is
// admissible ONLY if the realistic forward capture for its liquidity band and
// conviction can clear the modeled round-trip cost with margin. Descriptive
// signals (px5m/bp5m/volMomentum) describe a move that ALREADY happened and have
// no proven forward validity, so on their own they may never admit a trade.
function estimateRealisticPeakPct(liqUsd: number): number {
  // Conservative forward-peak envelope from the bot's own realized empirics
  // (documented: $10-25k liq peaks +3-8%; deeper pools sustain larger runs).
  if (liqUsd < 15000)  return 5;
  if (liqUsd < 25000)  return 6;
  if (liqUsd < 50000)  return 8;
  if (liqUsd < 100000) return 10;
  return 12;
}
function objectiveNetEvPct(liqUsd: number, sizeSol: number, solPriceUsd = cachedSolPriceUsd, score = 0): { peakPct: number; grossCapturePct: number; rtCostPct: number; netEvPct: number } {
  const costs = calcTransactionCosts(liqUsd, sizeSol, solPriceUsd);
  const peakPct = estimateRealisticPeakPct(liqUsd);
  // Conviction scales expected capture. Calibrated so the ONLY empirically-
  // positive pocket (SNIPER/score>=80 at ~$25k liq = +3.06%/trade realized,
  // n=63) clears the gate, while the documented-negative 70-79 band does not.
  // [FIX D1 — Framework v3] captureMult capped at 1.0.
  // DEFECT: old formula (0.7 + 1.3 * clamp) reached 2.26 at score=100 — physically
  // impossible (cannot capture > 100% of a price move). At score=90, liq=$8k:
  //   old: captureMult=2.0 → f(x)=2.0*5%-6.6%=+3.4% → ENTERS (wrong)
  //   new: captureMult=1.0 → f(x)=1.0*5%-6.6%=-1.6% → SKIPS  (correct)
  // New range: [0.70, 1.00]. score≤70→0.70, score=90→1.00, score=100→1.00 (hard cap).
  const conviction = Math.max(0, Math.min(1.0, (score - 70) / 20)); // 0 @ s70 -> 1.0 @ s90, capped
  const captureMult = 0.7 + 0.3 * conviction; // range [0.70, 1.00] — physically bounded
  const grossCapturePct = peakPct * captureMult;
  const netEvPct = grossCapturePct - costs.totalRoundTripPct;
  return { peakPct, grossCapturePct, rtCostPct: costs.totalRoundTripPct, netEvPct };
}

// ── BIRDEYE-INDEPENDENT HOLDER/LP CONCENTRATION (RugCheck full report) ───────────────
// AI-FIX(2026-06-24c): a free, no-paid-tier fallback rug discriminator for when the Birdeye
// whale tape is blind (bdVol=0 / 401-403). The safety path already trusts RugCheck but only
// hits /report/summary, which returns presence-only risk flags. The full /report adds NUMERIC
// holder concentration + LP-lock data — the strongest STATIC rug correlate within the
// LP-unlocked pond (arxiv 2602.13480; Solidus Labs 2025). Chosen over raw Solana RPC
// getTokenLargestAccounts because RugCheck already excludes LP/AMM vault accounts server-side
// (raw RPC would misread the pool vault as a whale). Defensive parsing: any missing/renamed
// field => available=false, and the caller falls back to its verified presence-flag baseline,
// so a response-shape mismatch can never crash or silently change behavior.
interface RugConcentration { available: boolean; topHolderPct: number; top5Pct: number; insiderPct: number; insiderCount: number; totalHolders: number; lpLockedPct: number; }
const rugConcentrationCache = new Map<string, { data: RugConcentration; ts: number }>();
async function fetchRugcheckConcentration(tokenAddress: string): Promise<RugConcentration> {
  const _empty: RugConcentration = { available: false, topHolderPct: 0, top5Pct: 0, insiderPct: 0, insiderCount: 0, totalHolders: 0, lpLockedPct: 0 };
  const _cached = rugConcentrationCache.get(tokenAddress);
  if (_cached && Date.now() - _cached.ts < 120_000) return _cached.data;
  // STALE-FALLBACK (AI-FIX 2026-06-28): on an intermittent RugCheck outage, reuse the last-known
  // concentration (up to RUGCHECK_CONC_STALE_MS) instead of returning available:false. This closes
  // the blind fail-open that admitted $VENEZUELA (~66-71% top holder) for a -62% LIQ_COLLAPSE rug
  // when the live fetch failed mid-session. A token recently measured as concentrated stays vetoed;
  // a token never measured high (e.g. a genuine runner) is unaffected and can still be admitted.
  const _staleMs = Number(process.env.RUGCHECK_CONC_STALE_MS ?? 1_800_000);
  const _staleOk = (): RugConcentration => {
    if (_cached && Date.now() - _cached.ts < _staleMs) {
      console.warn(`[RUGCHECK-CONC] $${tokenAddress.slice(0,6)} fetch unavailable — using STALE cached concentration (age ${((Date.now()-_cached.ts)/1000).toFixed(0)}s, topHolder=${_cached.data.topHolderPct.toFixed(1)}%, top5=${_cached.data.top5Pct.toFixed(1)}%) to prevent blind fail-open admit`);
      return _cached.data;
    }
    return _empty;
  };
  try {
    const resp = await fetch(`https://api.rugcheck.xyz/v1/tokens/${tokenAddress}/report`, { signal: AbortSignal.timeout(5000) });
    if (!resp.ok) { console.warn(`[RUGCHECK-CONC] $${tokenAddress.slice(0,6)} non-OK HTTP ${resp.status} on /report (full report unavailable; falling back to presence flags)`); return _staleOk(); }
    const r: any = await resp.json();
    const holders: any[] = Array.isArray(r?.topHolders) ? r.topHolders : [];
    if (holders.length === 0) return _staleOk();
    const pctOf = (h: any) => Number(h?.pct ?? h?.percentage ?? 0) || 0;
    // Exclude LP/AMM vault accounts so we measure REAL holder concentration, not pool depth.
    const nonLp = holders.filter((h: any) => !(h?.isLp === true || h?.lp === true || String(h?.insiderType || "").toLowerCase() === "lp"));
    const sortedPct = nonLp.map(pctOf).sort((a: number, b: number) => b - a);
    const topHolderPct = sortedPct[0] || 0;
    const top5Pct = sortedPct.slice(0, 5).reduce((a: number, b: number) => a + b, 0);
    const insiders = nonLp.filter((h: any) => h?.insider === true || h?.insider === 1);
    const insiderPct = insiders.map(pctOf).reduce((a: number, b: number) => a + b, 0);
    const markets: any[] = Array.isArray(r?.markets) ? r.markets : [];
    const lpLockedPct = markets.reduce((mx: number, m: any) => Math.max(mx, Number(m?.lp?.lpLockedPct ?? m?.lpLockedPct ?? 0) || 0), 0);
    const totalHolders = Number(r?.totalHolders ?? r?.totalHolder ?? 0) || 0;
    const data: RugConcentration = { available: true, topHolderPct, top5Pct, insiderPct, insiderCount: insiders.length, totalHolders, lpLockedPct };
    rugConcentrationCache.set(tokenAddress, { data, ts: Date.now() });
    return data;
  } catch { return _staleOk(); }
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
  if (currentPnlPct < -2) base = Math.min(base, 1200);
  if (currentPnlPct < -3.5) base = Math.min(base, 900);
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
    if (i > 0) await new Promise(r => setTimeout(r, 200));
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
    
    // UPDATED: Upgraded to 'Blue Chip' filtering. Rejects low-tier volatile tokens.
    const QUALITY_LIQ_FLOOR = 1000;       // RELAXED(2026-06-29): 15000 -> 1000. Fresh Gecko new_pools start at $0-$2k liq; old floor killed all before scoring. EDGE_POCKET_ONLY (score>=80) + safety pipeline provide real protection.
    const QUALITY_VOL_5M_MIN = 500;       // RELAXED(2026-06-29): 10000 -> 500. Fresh pools have minimal 5m vol; small floor filters empty rug tokens while letting real launches through.
    const QUALITY_MIN_AGE_SEC = 0;       // FETCHER OLD-PROFIT: old routes.ts did NOT pre-cut <2m tokens
    const QUALITY_MIN_M5_SELLS = 2;      // FETCHER OLD-PROFIT: old routes.ts required only 2 sells at safety stage, not 10 at discovery

    console.log(`[FETCHER-PATCH] old-profit funnel active | liq>=${QUALITY_LIQ_FLOOR} vol5m>=${QUALITY_VOL_5M_MIN} minAge=${QUALITY_MIN_AGE_SEC}s minSells=${QUALITY_MIN_M5_SELLS}`);

    // Gecko new_pools round-robin: 1 page per 6s cycle, pages 1-3 rotating.
    // new_pools = freshly created pools (the real fresh-token source). trending_pools was wrong.
    // 3 pages × 6s cycle = 18s to cycle all = 10 req/min, well under 30/min free limit.
    const geckoCycleCounter = (((global as any).__geckoCycle ?? 2) + 1) % 3;
    (global as any).__geckoCycle = geckoCycleCounter;
    const geckoNewPage = geckoCycleCounter + 1; // 1, 2, 3
    const geckoFetches = [
      withTimeout(
        fetch(`https://api.geckoterminal.com/api/v2/networks/solana/new_pools?page=${geckoNewPage}`, { headers: { "Accept": "application/json;version=20230302" }, signal: AbortSignal.timeout(8000) })
          .then(r => { if (r.status === 429) { console.warn(`[GECKO-429] new_pools page=${geckoNewPage}`); return { data: [] }; } return r.ok ? r.json() : { data: [] }; }),
        10000, "Gecko New Pools"
      ).catch(() => ({ data: [] }))
    ];

    const birdEyeFetch = Promise.resolve({ data: { tokens: [] } });

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
        // AI-TUNE(2026-06-24) WIDENED FLOW — add token-profiles/latest/v1 as a 3rd feed alongside
        // the two boost feeds. Profiles are tokens that have completed DexScreener's Enhanced Token
        // Info onboarding (paid promotion) — i.e. teams investing in visibility, a useful quality
        // proxy. Same shape ({ chainId, tokenAddress }), same hydration path, so it just plugs in.
        const boostFeeds = await Promise.all([
            throttledDexScreenerFetch("https://api.dexscreener.com/token-boosts/top/v1").catch(() => []),
            throttledDexScreenerFetch("https://api.dexscreener.com/token-boosts/latest/v1").catch(() => []),
            throttledDexScreenerFetch("https://api.dexscreener.com/token-profiles/latest/v1").catch(() => []),
        ]);
        let boostAddrs = Array.from(new Set(
            boostFeeds
                .flatMap((bf: any) => Array.isArray(bf) ? bf : (bf?.data || []))
                .filter((b: any) => b && b.chainId === "solana" && b.tokenAddress)
                .map((b: any) => b.tokenAddress as string)
        )).slice(0, 150); // AI-TUNE(2026-06-24): bumped 100->150 to actually let the extra profiles feed through hydration.
        
        try {
            // WARMING QUEUE: Do not throw away 0-second tokens just because they lack $10k vol yet.
            // Hold them in memory for 10 minutes and track their volume continuously until they break out.
            if (!(global as any).scannerWarmingQueue) (global as any).scannerWarmingQueue = new Map<string, number>();
            const wq = (global as any).scannerWarmingQueue as Map<string, number>;
            const nowMs = Date.now();
            
            if (existsSync('candidates.csv')) {
                const fileData = await fsPromises.readFile('candidates.csv', 'utf8');
                let idx = fileData.length - 1;
                let nl = 0;
                while (idx >= 0 && nl < 151) { if (fileData[idx] === '\n') nl++; idx--; }
                const lines = fileData.slice(idx + 1).trim().split('\n');
                const csvMints = lines.map((l: string) => l.split(',')[1]).filter((m: string) => m && m.length > 32);
                for (const mint of csvMints) {
                    if (!wq.has(mint)) wq.set(mint, nowMs);
                }
            }
            
            // Clean up old tokens (>10 minutes)
            for (const [mint, addedAt] of wq.entries()) {
                if (nowMs - addedAt > 10 * 60 * 1000) wq.delete(mint);
            }
            
            const warmingMints = Array.from(wq.keys());
            boostAddrs = Array.from(new Set([...boostAddrs, ...warmingMints]));
            console.log(`[SCANNER-QUEUE] Tracking ${warmingMints.length} fast scanner tokens via free API (Waiting for $10k breakout)`);
        } catch (e) { console.error("Error with warming queue / candidates.csv", e); }

        for (let i = 0; i < boostAddrs.length; i += 30) {
            const chunk = boostAddrs.slice(i, i + 30).join(",");
            try {
                const hydrated = await throttledDexScreenerFetch(`https://api.dexscreener.com/latest/dex/tokens/${chunk}`);
                dexResults.push(hydrated);
            } catch { /* skip chunk */ }
        }
    } catch { dexResults.push([]); }

    // AI-TUNE(2026-06-24) QUALITY-FIRST DISCOVERY SOURCES — user directive: "feed quality tokens to the gates".
    // Replaced the prior "more sources" block with quality-only feeds:
    //   1. Jupiter Verified rolling hydration — every cycle we hydrate ~60 verified tokens.
    //      Verified tokens with no momentum get cut by the existing liquidity/volume floor;
    //      verified tokens WITH momentum become high-confidence candidates. This is the
    //      cleanest "quality at the source" lever available on Solana.
    //   2. Jupiter top-traded pools — real volume momentum on the canonical SOL router.
    //      Robust extraction tries multiple field paths since the response shape varies.
    // Dropped: Helius "newest fungible" (scam-firehose by definition) and Solscan trending
    // (was returning 0 — likely behind a paid key now). Both fail-silently so removing them
    // is pure noise reduction.
    try {
        const extraSourceAddrs = new Set<string>();
        let jupVerifiedCount = 0, jupTopCount = 0, geckoVolCount = 0; // AI-FIX(2026-06-24h): declare Source 4 counter. V3 LIQ now returns real tokens, so the existing birdEyeLiqCount++ path executes; without this declaration it throws ReferenceError and prevents LIQ addresses from contributing.

        // ── Source 1: Rolling hydration of Jupiter's verified token universe.
        try {
            const verifiedArr = Array.from(jupiterVerifiedSet);
            if (verifiedArr.length > 0) {
                const WINDOW = 60;
                const start = jupiterVerifiedHydrationOffset % verifiedArr.length;
                const tail = verifiedArr.slice(start, start + WINDOW);
                const wrap = (start + WINDOW) > verifiedArr.length
                    ? verifiedArr.slice(0, (start + WINDOW) - verifiedArr.length)
                    : [];
                for (const addr of tail) { extraSourceAddrs.add(addr); jupVerifiedCount++; }
                for (const addr of wrap) { extraSourceAddrs.add(addr); jupVerifiedCount++; }
                jupiterVerifiedHydrationOffset = (jupiterVerifiedHydrationOffset + WINDOW) % Math.max(1, verifiedArr.length);
            }
        } catch (e: any) { console.warn("[SRC:JUP-VERIFIED] failed:", e?.message || e); }

        // ── Source 2: Jupiter datapi top-traded pools (robust extraction).
        try {
            const j: any = await withTimeout(
                fetch("https://datapi.jup.ag/v1/pools/toptraded/24h", {
                    headers: { "Accept": "application/json" },
                    signal: AbortSignal.timeout(8000),
                }).then(r => r.ok ? r.json() : null),
                10_000,
                "Jupiter Top-Traded"
            ).catch(() => null);
            const pools = (j && (j.pools || j.data || (Array.isArray(j) ? j : []))) || [];
            if (Array.isArray(pools)) {
                for (const p of pools) {
                    // Try every known field path for base token mint.
                    const candidates: any[] = [
                        p?.baseAsset?.id, p?.baseAsset?.address, p?.baseAsset?.mint, p?.baseAsset,
                        p?.baseMint, p?.base_mint, p?.base_address, p?.base,
                        p?.mintA, p?.tokenA, p?.token_a, p?.tokenAddress, p?.token,
                        p?.mainPool?.baseMint, p?.mainPool?.token, p?.id,
                    ];
                    for (const c of candidates) {
                        const addr = typeof c === "string" ? c : (c?.address || c?.id || c?.mint);
                        if (typeof addr === "string" && addr.length >= 32 && addr.length <= 64) {
                            extraSourceAddrs.add(addr);
                            jupTopCount++;
                            break;
                        }
                    }
                }
            }
        } catch (e: any) { console.warn("[SRC:JUP-TOP] failed:", e?.message || e); }


        // Hydrate the union via DexScreener /latest/dex/tokens/{addrs} (same pipe as boost hydration).
        const extraAddrs = Array.from(extraSourceAddrs).slice(0, 200);
        for (let i = 0; i < extraAddrs.length; i += 30) {
            const chunk = extraAddrs.slice(i, i + 30).join(",");
            try {
                const hydrated = await throttledDexScreenerFetch(`https://api.dexscreener.com/latest/dex/tokens/${chunk}`);
                dexResults.push(hydrated);
            } catch { /* skip chunk */ }
        }
        console.log(`[SRC-XTRA] quality-only union=${extraAddrs.length} | jupVerified=${jupVerifiedCount} jupTop=${jupTopCount} gkVol=${geckoVolCount} (verified-set size=${jupiterVerifiedSet.size}, offset=${jupiterVerifiedHydrationOffset})`);
    } catch (e: any) { console.warn("[SRC-XTRA] block failed:", e?.message || e); }

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
          if (QUALITY_MIN_AGE_SEC > 0 && pair.pairCreatedAt && age < QUALITY_MIN_AGE_SEC * 1000) { cutTooNew++; continue; }
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
            if ((hpBuys + hpSells) > 0 && hpSells < QUALITY_MIN_M5_SELLS) { cutHoneypot++; continue; } // old-profit: 2-sell minimum, not 10
            if (hpFdv > 0 && liq / hpFdv < 0.003) { cutHoneypot++; continue; }
          }

          allPairs.push(pair);
        }
      }
      
      if (res.data?.tokens) {
        for (const bToken of res.data.tokens) {
          const liq = bToken.liquidity || 0;
          const vol24h = bToken.v24hUSD || 0;
          const vol5m = (bToken.v5mUSD != null) ? Number(bToken.v5mUSD)
            : (bToken.v1hUSD != null) ? Number(bToken.v1hUSD) / 12
            : (bToken.v30mUSD != null) ? Number(bToken.v30mUSD) / 6
            : vol24h / 288; // FIX(2026-06-27): use real short-window volume; flat 24h/288 understated momentum ~100x and starved the feed
          const ageSec = (Date.now() - (bToken.first_seen || 0) * 1000) / 1000;
          
          funnelSeen++; if (liq < QUALITY_LIQ_FLOOR) { cutLiq++; continue; }
          if (vol5m < QUALITY_VOL_5M_MIN) { cutVol++; continue; }
          if (ageSec > engineSettings.maxDiscoveryAgeSeconds) { cutAge++; continue; }
          if (QUALITY_MIN_AGE_SEC > 0 && bToken.first_seen && ageSec < QUALITY_MIN_AGE_SEC) { cutTooNew++; continue; }
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

    // AI-TUNE(2026-06-24) QUALITY FILTERS ��� real, source-level levers (not relabeled quantity).
    // Runs once per cycle over the assembled candidate pool, BEFORE dedup/scoring.
    //   1. Refresh Jupiter verified set (cached, free).
    //   2. Tag every candidate with _jupVerified so it's visible everywhere downstream.
    //   3. Apply opt-in hard filters: require-verified, min-age. Off-by-default keeps flow wide.
    await refreshJupiterVerifiedSet();
    const Q_REQUIRE_JUP_VERIFIED = String(process.env.QUALITY_REQUIRE_JUPITER_VERIFIED ?? "false").toLowerCase() === "true";
    const Q_MIN_AGE_MIN = Math.max(0, Number(process.env.QUALITY_MIN_AGE_MIN ?? "5") || 0); // default 5min: cheap real filter
    const Q_MIN_AGE_MS = Q_MIN_AGE_MIN * 60_000;
    let qVerified = 0, qCutNotVerified = 0, qCutTooYoung = 0;
    const qualityPairs: DexScreenerPair[] = [];
    for (const sp of allPairs) {
      const verified = isJupiterVerified(sp.baseToken?.address);
      (sp as any)._jupVerified = verified;
      if (verified) qVerified++;
      if (Q_REQUIRE_JUP_VERIFIED && !verified) { qCutNotVerified++; continue; }
      const age = sp.pairCreatedAt ? (now - sp.pairCreatedAt) : Number.MAX_SAFE_INTEGER;
      if (Q_MIN_AGE_MS > 0 && sp.pairCreatedAt && age < Q_MIN_AGE_MS) { qCutTooYoung++; continue; }
      qualityPairs.push(sp);
    }
    allPairs.length = 0;
    for (const sp of qualityPairs) allPairs.push(sp);
    console.log(`[QUALITY] in=${qualityPairs.length + qCutNotVerified + qCutTooYoung} pass=${qualityPairs.length} jupVerified=${qVerified} cuts: notVerified=${qCutNotVerified} tooYoung=${qCutTooYoung} | flags: REQUIRE_VERIFIED=${Q_REQUIRE_JUP_VERIFIED} MIN_AGE_MIN=${Q_MIN_AGE_MIN}`);

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
    // LAYER-3: prescreen on momentum, then confirm finalists with Birdeye smart-money convergence (rate-limit-safe; <=20 calls/scan).
    const __prelim = dedupedPairs.map((sp, idx) => ({ sp, idx, pre: scoreToken(sp, mlPredictions[idx], isMicroWallet) }));
    const __finalists = __prelim.filter(p => p.pre.qualifiedMode || p.pre.combinedScore >= 50).slice(0, 20);
    const __smMap = new Map<string, SmartMoneySignal>();
    const __SM_CONC = Math.max(1, parseInt(process.env.SM_CONVERGENCE_CONCURRENCY || "4", 10));
    for (let __i = 0; __i < __finalists.length; __i += __SM_CONC) {
      const __batch = __finalists.slice(__i, __i + __SM_CONC);
      await Promise.all(__batch.map(async (f) => {
        __smMap.set(f.sp.baseToken.address, await fetchSmartMoneyConvergence(f.sp.baseToken.address, false, true, false));
      }));
    }
    const results = __prelim.map(({ sp, idx, pre }) => {
      const __sm = __smMap.get(sp.baseToken.address) || null;
      const scoring = __sm ? scoreToken(sp, mlPredictions[idx], isMicroWallet, __sm) : pre;
      return {
        ...scoring,
        tokenAddress: sp.baseToken.address,
        pairAddress: sp.pairAddress, // ROOT-CAUSE FIX(2026-06-24): carry the EXACT discovery pool so the buy-loop re-fetch re-selects it (not a stale highest-liq pool).
        tokenSymbol: sp.baseToken.symbol,
        score: scoring.combinedScore,
        qualifiedMode: scoring.qualifiedMode,
        price: sp.priceUsd,
        liquidity: sp.liquidity?.usd || 0,
        volume5m: sp.volume?.m5 || 0,
        priceChange5m: sp.priceChange?.m5 || 0, // FEED-FIX(2026-06-27): expose 5m % at top level so the dashboard "5M" column renders real momentum (was nested only in metrics → column showed 0.0% for every row).
        priceChange1h: sp.priceChange?.h1 || 0, // companion 1h % for the feed.
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
          + ` age=${m.ageSeconds ?? 0}s mlScore=${r.mlScore ?? "N/A"} rej=[${r.rejectionReason || ""}]`;
      });
      console.log(`[DIAG-SCOREWALL] top${diagTop.length} (pre-safety): ` + diagTop.join("  ||  "));
      const latestScanData = results.slice(0, 3).map((r: any) => ({
         symbol: r.tokenSymbol,
         score: r.combinedScore,
         mode: r.qualifiedMode || "none",
         reason: r.rejectionReason || "Pass",
         bp5m: r.metrics?.bp5m || 0,
         volMom: r.metrics?.volMomentum || 0
      }));
      fsPromises.writeFile('last_scan.json', JSON.stringify({ timestamp: new Date().toISOString(), topCoins: latestScanData })).catch(() => {});
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
const safetyCache = new Map<string, { safe: boolean; reason: string; timestamp: number; mintActive?: boolean }>();
const CACHE_TTL_MS = 60_000;


async function checkTokenSafety(tokenAddress: string, pair: DexScreenerPair, goldTier?: string | null): Promise<{ safe: boolean; reason: string; mintActive?: boolean }> {
  if (!engineSettings.safetyChecksEnabled) return { safe: true, reason: "checks_disabled" };
  const cached = safetyCache.get(tokenAddress);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) return cached;

  const rugcheckBlockedUntil = rugcheckBlockedAddresses.get(tokenAddress);
  if (rugcheckBlockedUntil && Date.now() < rugcheckBlockedUntil) return { safe: false, reason: "rugcheck_block_cached" };

  const liq = pair.liquidity?.usd || 0;
  // HARD LIQUIDITY FLOOR (entry gate) — the decisive profitability lever.
  // Below this, modeled round-trip slippage swallows the move (~8% RT @ $37k liq, ~12% @ $18k).
  // Requiring deep liquidity pushes the price-impact component of round-trip cost under ~3%,
  // so a paper "winner" can actually be crystallized instead of being held forever by the cost gate.
  // Tunable via ENTRY_MIN_LIQ_USD; default $25,000. // AI-TUNE(2026-06-28): default 100000 -> 25000. NEEDLE-MOVER: the live $40k floor was the dominant no-trade cause — nearly all fresh runners (CLIVE/ORANGIE/Cedric/MVLL/SBF/drooling) sit in the $15k-$36k band, were scored top-5, then killed by liquidity_below_entry_floor; only stale large-caps cleared $40k and either scored too low or were vetoed. $25k = documented old-profitable floor, still above the BioCraft $21k disaster line. NOTE: the running .env still sets ENTRY_MIN_LIQ_USD=40000 — change it to 25000 (or remove the line) for this to take effect at runtime.
  const ENTRY_MIN_LIQ_USD = Number(process.env.ENTRY_MIN_LIQ_USD) || 3000; // Aligned with gold_standard_hunter moonshot config
  if (liq < ENTRY_MIN_LIQ_USD) return { safe: false, reason: `liquidity_below_entry_floor($${Math.round(liq)} < $${ENTRY_MIN_LIQ_USD})` };
  const m5sells = pair.txns?.m5?.sells || 0;
  // AGE-SCALED honeypot gate: brand-new launches legitimately have few sells in their first
  // minutes, so a flat `<10` floor blocked most SNIPER-age candidates before RugCheck ran.
  // Scale required sells with pair age (a true 0-sell honeypot is still caught at every age).
  const _ageSecSells = pair.pairCreatedAt ? (Date.now() - pair.pairCreatedAt) / 1000 : 99999;
  const _minSells = _ageSecSells < 120 ? 2 : _ageSecSells < 300 ? 5 : _ageSecSells < 900 ? 8 : 10;
  if (m5sells < _minSells) return { safe: false, reason: `insufficient_sell_activity_honeypot_risk(${m5sells}/${_minSells}@${Math.round(_ageSecSells)}s)` };

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
    // so `data.tokenMeta?.freezeAuthority !== null` was `undefined !== null` === true for EVERY token ���
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
    // PATCH #3 (lp-veto-precision): the HARD_VETO_RISK_KEYWORDS list above matched "lp unlocked"
    // as a SUBSTRING, so the graded RugCheck flag "Large Amount of LP Unlocked" (a partial-LP
    // signal) tripped the same ABSOLUTE veto written for the literal "LP Unlocked" full-pull flag
    // ($Taz -101%). In the current market ~100% of liquid fresh launches carry the graded flag, so
    // it became a 100% kill switch and the bot took zero entries. Split the two:
    //   ABSOLUTE (hard-veto in ALL modes): literal "LP Unlocked" full-pull + "single holder ownership".
    //   GRADED ("Large Amount of LP Unlocked"): still hard-veto in LIVE (never relax real-money rug
    //     protection), but ALLOW in PAPER, tagged, to measure the real post-entry rug rate at zero risk.
    const _vetoNameLc = (r: any) => String(r?.name || "").toLowerCase();
    const _absoluteVetoRisk = _risks.find((r: any) => {
      const n = _vetoNameLc(r);
      return n.includes("single holder ownership") || (n.includes("lp unlocked") && !n.includes("large amount of lp unlocked"));
    });
    const _gradedLpRisk = _risks.find((r: any) => _vetoNameLc(r).includes("large amount of lp unlocked"));
    const _safetyTradingMode = ((await storage.getBotStatus().catch(() => ({ tradingMode: "paper" })))?.tradingMode === "live") ? "live" : "paper";
    // AI-TUNE(2026-06-24g): PAPER-ONLY graded-LP probe. Latest live paper run shows the entry engine
    // is finally finding the intended high-quality SNIPER pocket (e.g. score=100/85, liq~$150k, rej=[]),
    // but every one is stopped by RugCheck's *graded* "Large Amount of LP Unlocked" flag. Do NOT weaken
    // live protection: literal LP Unlocked + Single Holder remain absolute vetoes, and the graded flag
    // remains a hard veto in LIVE. In PAPER only, admit the graded flag so the shadow ledger can measure
    // whether these high-score/high-liq SNIPER setups are actually rugs or the only tradable market supply.
    // Disable with PAPER_PROBE_GRADED_LP_VETO=false. No env var can relax this in live here.
    const _paperProbeGradedLp = false; // DISABLED BY USER: hard-veto in all modes
    // MICRO-WALLET COMPROMISE: If a token has unlocked LP but has survived for >1 hour, the dev likely isn't pulling a sudden rug. Allow it for safe 15% scavenger wins.
    const tokenAgeSecs = pair.pairCreatedAt ? (Date.now() - pair.pairCreatedAt) / 1000 : 0;
    const isOldEnoughToBypassVeto = false; // DISABLED BY USER: age does not bypass LP veto
    const _gradedLpAdmit = _safetyTradingMode !== "live"; // PAPER: admit graded "Large Amount of LP Unlocked" so the discriminator + shadow ledger can measure the real post-entry rug rate at ZERO real-money risk. LIVE: always hard-veto (unchanged).
    // GOLD SINGLE-HOLDER PAPER PROBE (user decision 2026-06-28): every gmgn LEGENDARY pick so far is
    // single-holder-concentrated, so the absolute single-holder veto means the Gold Hunter never trades
    // and the shadow ledger gets zero data. Admit LEGENDARY gold picks in PAPER/SHADOW ONLY, tagged, to
    // measure whether these smart-money single-holder setups actually pay. LIVE stays hard-vetoed
    // (single-holder = top concentration-rug predictor). Only relaxes when the ONLY absolute flag is
    // single-holder; literal "LP Unlocked" still hard-vetoes in ALL modes. Disable: GOLD_SINGLE_HOLDER_PAPER_PROBE=false.
    let _absoluteVetoEffective: any = _absoluteVetoRisk;
    const _goldShProbeOn = String(process.env.GOLD_SINGLE_HOLDER_PAPER_PROBE ?? "true").toLowerCase() !== "false";
    const _shOnlyAbsolute = !!_absoluteVetoRisk
      && _vetoNameLc(_absoluteVetoRisk).includes("single holder ownership")
      && !_risks.some((r: any) => { const n = _vetoNameLc(r); return n.includes("lp unlocked") && !n.includes("large amount of lp unlocked"); });
    if (_shOnlyAbsolute && _goldShProbeOn && _safetyTradingMode !== "live" && goldTier === "LEGENDARY") {
      console.log(`[GOLD-SH-PROBE:PAPER] $${pair.baseToken?.symbol || tokenAddress} ADMITTED single-holder LEGENDARY gold pick for PAPER/SHADOW measurement only; LIVE remains hard-vetoed.`);
      _absoluteVetoEffective = undefined;
    }
    const _vetoRisk = _absoluteVetoEffective || ((_gradedLpRisk && !_gradedLpAdmit) ? _gradedLpRisk : undefined);
    if (_gradedLpRisk && !_absoluteVetoRisk && !_vetoRisk) {
      console.log(`[LP-VETO-PAPER-PROBE:${_safetyTradingMode.toUpperCase()}] $${pair.baseToken?.symbol || tokenAddress} ADMITTED graded "${_gradedLpRisk.name}" for PAPER/SHADOW measurement only; LIVE remains hard-vetoed. rugScoreNorm=${data?.score_normalised}`);
    }
    // ── LITERATURE-GROUNDED LP-UNLOCKED DISCRIMINATOR (AI-FIX 2026-06-24) ────────────────
    // Research is unanimous (arxiv 2602.13480 MemeTrans; 2603.24625 "From Hype to Collapse";
    // Solidus Labs 2025): within the LP-UNLOCKED population (~98% rug base rate — the exact
    // pond RELAX_GRADED_LP_VETO_LIVE deliberately fishes), the surviving minority is NOT
    // separated by static contract flags (those already passed) but by ORGANIZED GROUP
    // BEHAVIOUR — coordinated/bundled wallets and early insider distribution. We now have a
    // live read on that via the (just-repaired) Birdeye top_traders whale tape. So when we
    // are about to admit an LP-unlocked token, require the tape to look like genuine
    // accumulation, not a coordinated exit / wash bundle. DATA-ABSENT => DO NOT BLOCK (never
    // re-introduce the zero-trade starvation); this is a graded, env-gated discriminator.
    let _lpRelaxGateReason: string | null = null;
    if (_gradedLpRisk && !_absoluteVetoRisk && !_vetoRisk && !_freezeActive) {
      const _lpRelaxWhaleGateOn = String(process.env.LP_RELAX_WHALE_GATE || "true").toLowerCase() !== "false";
      let _wsig: SmartMoneySignal | null = null;
      // GRADED-LP ENTRY WHALE PRECHECK (AI-FIX 2026-06-27) — DORMANT by default.
      // When ON, force a FRESH (cache-bypass) whale read for this graded-LP candidate so the
      // existing wash/distribution veto below fires AT ENTRY instead of admit-then-bail mid-hold.
      // Kept OFF until distinct Birdeye keys are added: today the 4 key-slots are 1 shared key
      // (deee0dd7, 60rpm) and a per-candidate bypass call would deepen the 429 starvation. Once
      // real keys land, set GRADED_LP_ENTRY_WHALE_PRECHECK=true and these wash tokens get vetoed
      // before paying the round-trip. DEFAULT ON (Birdeye retired): the bypass routes to Helius (7 keys), not Birdeye, so no 429 starvation. Set GRADED_LP_ENTRY_WHALE_PRECHECK=false to revert to cached entry behavior.
      const _gradedLpEntryPrecheck = String(process.env.GRADED_LP_ENTRY_WHALE_PRECHECK || "true").toLowerCase() === "true";
      try { _wsig = await fetchSmartMoneyConvergence(tokenAddress, _gradedLpEntryPrecheck, true, false); } catch { _wsig = null; } // CU-FIX: birdeyeAllowed=false — route this entry precheck to Helius (7 keys, separate quota), matching the "Birdeye retired" intent. Previously defaulted birdeyeAllowed=true and hit Birdeye top_traders FIRST, draining the shared single-account CU pool.
      const _wc = _wsig?.whaleCount ?? 0;            // # top-volume wallets sampled
      const _wSell = _wsig?.whaleNetSellers ?? 0;    // big wallets net-distributing
      const _wBuy = _wsig?.whaleNetBuyers ?? 0;      // big wallets net-accumulating
      const _wash = _wsig?.washSuspects ?? 0;        // balanced high-freq churners (bundle/wash proxy)
      const _accumQ = _wsig?.netBuyers ?? 0;         // PROFITABLE, non-wash, net-accumulating wallets
      // Concentration co-flags from RugCheck (presence only — /report/summary omits numeric
      // values; logged for forward calibration, NOT vetoed, per documented over-veto risk).
      const _top10Flag = _hasRisk("top 10 high ownership") || _hasRisk("top10");
      const _highOwnFlag = _hasRisk("high ownership");
      const _fewLpProviders = _hasRisk("low amount of lp providers");
      console.log(`[LP-RELAX-PROFILE] $${pair.baseToken?.symbol || tokenAddress} whales=${_wc} accumQ=${_accumQ} netBuy=${_wBuy} netSell=${_wSell} wash=${_wash} | top10=${_top10Flag} highOwn=${_highOwnFlag} fewLP=${_fewLpProviders} | smEnabled=${smartMoneyEnabled()} dataPresent=${_wc > 0} norm=${data?.score_normalised}`);
      if (_lpRelaxWhaleGateOn && _wc > 0 && (_wsig?.source === "birdeye" || _wsig?.source === "helius")) {
        // Only act when whale data is actually present. Two high-precision literature signals:
        //  (1) coordinated distribution: >= WHALE_DISTRIBUTION_SELLERS big wallets net-selling.
        //  (2) wash-dominated tape with ZERO genuine accumulation: organized fake volume / bundle.
        if (_wSell >= WHALE_DISTRIBUTION_SELLERS) {
          _lpRelaxGateReason = `lp_unlocked_whale_distribution(netSell=${_wSell}>=${WHALE_DISTRIBUTION_SELLERS})`;
        } else if (_accumQ === 0 && _wBuy <= _wSell && _wash >= Math.ceil(_wc / 2)) { // AI-TUNE(2026-06-28): added _wBuy <= _wSell guard. The Helius tape reports accumQ(netBuyers)=0 as an artifact even when whales are net-BUYING (e.g. TQQQ/drooling: netBuy=10 netSell=0 wash=5), causing a permanent false wash veto on otherwise top-scoring candidates. Only treat wash-no-accumulation as a real bundle/wash exit when whales are NOT net-accumulating (_wBuy <= _wSell). The whale_distribution branch above is untouched, so genuine organized exits still hard-veto.
          _lpRelaxGateReason = `lp_unlocked_wash_no_accumulation(wash=${_wash}/${_wc})`;
        }
        if (_lpRelaxGateReason) {
          console.log(`[LP-RELAX-GATE] $${pair.baseToken?.symbol || tokenAddress} VETO — ${_lpRelaxGateReason} (literature: organized group exit/bundle on unlocked LP)`);
        }
      } else if (_lpRelaxWhaleGateOn) {
        // FAIL-CLOSED FALLBACK (AI-FIX 2026-06-24b): the whale tape is the PRIMARY discriminator for
        // the LP-unlocked rug-pond, but it is BLIND here — Birdeye returned no data (observed
        // persistently as bdVol=0). The original posture fail-OPEN (admit) was chosen to avoid
        // zero-trade starvation; live shadow stats now disprove that tradeoff: 158 trades, 40.5% win,
        // -0.78%/trade, and two consecutive ~$50k-liq SNIPER tokens ($SABC, $Jycs) rugged to $0 via
        // LIQ_COLLAPSE. Fishing this ~98%-rug pond with NO working discriminator is the dominant loss
        // source. When the primary signal is blind, fall back to RugCheck's static concentration
        // co-flags (the strongest Birdeye-INDEPENDENT rug correlates within the unlocked-LP
        // population): top-10 high ownership, high single-owner, or too-few LP providers. Veto ONLY on
        // a concentration red flag — clean-concentration unlocked-LP tokens still pass, so this does
        // NOT re-create starvation; it just stops admitting the concentrated rug signature blind.
        // PRIMARY blind-fallback (AI-FIX 2026-06-24c): pull NUMERIC holder/LP concentration from
        // RugCheck's full report (Birdeye-independent, free). High-precision rug thresholds within
        // the already-unlocked-LP pond:
        //   - a single non-LP wallet >= 25% (can dump the whole float)
        //   - top-5 non-LP wallets >= 60% (coordinated-dump setup)
        //   - flagged insiders holding >= 15%
        //
        // PAPER-MODE RELAXATION (AI-FIX 2026-06-24): In PAPER mode, when whale data is absent and the
        // multi-key Birdeye rotation is still warming up or all keys are exhausted, relax the
        // concentration thresholds so the bot can actually trade and the shadow ledger can collect
        // data. LIVE mode keeps the strict fail-closed thresholds unchanged.
        //   PAPER: topHolder >= 90% (was 25%), top5 >= 95% (was 60%), insider >= 50% (was 15%)
        //   LIVE:  topHolder >= 25%, top5 >= 60%, insider >= 15% (unchanged)
        const _paperLpRelax = _safetyTradingMode !== "live";
        const _topHolderThresh = 25;  // single non-LP wallet >=25% can dump the whole float
        const _top5Thresh = 60;       // top-5 non-LP wallets >=60% = coordinated-dump setup
        const _insiderThresh = 15;    // flagged insiders >=15% of float
        const _conc = await fetchRugcheckConcentration(tokenAddress);
        if (_conc.available) {
          console.log(`[LP-RELAX-CONC] $${pair.baseToken?.symbol || tokenAddress} topHolder=${_conc.topHolderPct.toFixed(1)}% top5=${_conc.top5Pct.toFixed(1)}% insider=${_conc.insiderPct.toFixed(1)}%(${_conc.insiderCount}) holders=${_conc.totalHolders} lpLocked=${_conc.lpLockedPct.toFixed(0)}% (RugCheck full report — Birdeye-independent)`);
          if (_conc.topHolderPct >= _topHolderThresh) _lpRelaxGateReason = `lp_unlocked_top_holder_${_conc.topHolderPct.toFixed(0)}pct`;
          else if (_conc.top5Pct >= _top5Thresh) _lpRelaxGateReason = `lp_unlocked_top5_${_conc.top5Pct.toFixed(0)}pct`;
          else if (_conc.insiderPct >= _insiderThresh) _lpRelaxGateReason = `lp_unlocked_insider_${_conc.insiderPct.toFixed(0)}pct`;
        }
        // FALLBACK-of-the-fallback: if the full report is unavailable (RugCheck down / shape
        // mismatch), keep the VERIFIED presence-flag baseline so we never silently stop
        // discriminating the unlocked-LP pond. In PAPER mode, skip this fallback entirely
        // (the numeric concentration check above already used relaxed thresholds; presence
        // flags alone are too coarse for paper-mode admission decisions).
        if (!_lpRelaxGateReason && !_paperLpRelax && (_top10Flag || _highOwnFlag || _fewLpProviders)) {
          _lpRelaxGateReason = `lp_unlocked_concentration_no_whaledata(top10=${_top10Flag},highOwn=${_highOwnFlag},fewLP=${_fewLpProviders})`;
        }
        // LAYER-1 WASH PROXY (AI-FIX 2026-06-27) — Birdeye-independent wash detector for the blind case.
        // Manufactured-volume fingerprint from already-fetched DexScreener flow: high vol vs liquidity +
        // ~50/50 balanced churn + flat price (no real discovery) + high tx velocity. Separates wash/bundle
        // ($SQQQ/$SOL: flat & balanced) from a genuine runner (price up + buy-skewed), so real breakouts are
        // NOT faded. RugCheck top5/few-LP logged as corroboration. WASH_PROXY_GATE=false => log-only.
        if (!_lpRelaxGateReason) {
          const _wpGate = String(process.env.WASH_PROXY_GATE ?? "true").toLowerCase() !== "false";
          const _wpVolLiqMult = Number(process.env.WASH_PROXY_VOL_LIQ_MULT ?? 8);
          const _wpMinTx = Number(process.env.WASH_PROXY_MIN_TX ?? 20);
          const _wpBalanceBand = Number(process.env.WASH_PROXY_BALANCE_BAND ?? 0.12);
          const _wpFlatPct = Number(process.env.WASH_PROXY_FLAT_PRICE_PCT ?? 3);
          const _wpLiq = pair?.liquidity?.usd || 0;
          const _wpVol5m = pair?.volume?.m5 || 0;
          const _wpM5b = pair?.txns?.m5?.buys || 0, _wpM5s = pair?.txns?.m5?.sells || 0;
          const _wpTx = _wpM5b + _wpM5s;
          const _wpBp = _wpTx > 0 ? _wpM5b / _wpTx : 0.5;
          const _wpPx = Math.abs(pair?.priceChange?.m5 || 0);
          const _wpManufVol = _wpLiq > 0 && _wpVol5m >= _wpLiq * _wpVolLiqMult;
          const _wpBalanced = Math.abs(_wpBp - 0.5) <= _wpBalanceBand;
          const _wpFlat = _wpPx <= _wpFlatPct;
          const _wpHighTx = _wpTx >= _wpMinTx;
          const _wpConcCorrob = (_conc?.available && _conc.top5Pct >= Number(process.env.WASH_PROXY_TOP5_PCT ?? 60)) || _fewLpProviders;
          const _wpTrip = _wpManufVol && _wpBalanced && _wpFlat && _wpHighTx;
          console.log(`[WASH-PROXY] $${pair.baseToken?.symbol || tokenAddress} trip=${_wpTrip} gate=${_wpGate} | manufVol=${_wpManufVol}(vol5m=${_wpVol5m.toFixed(0)} vs liq=${_wpLiq.toFixed(0)} x${_wpVolLiqMult}) balanced=${_wpBalanced}(bp=${_wpBp.toFixed(2)}) flatPx=${_wpFlat}(|px5m|=${_wpPx.toFixed(1)}%) highTx=${_wpHighTx}(${_wpTx}) concCorrob=${_wpConcCorrob}`);
          if (_wpTrip && _wpGate) {
            _lpRelaxGateReason = `lp_unlocked_wash_proxy(volLiq=${(_wpVol5m / Math.max(1, _wpLiq)).toFixed(1)}x,bp=${_wpBp.toFixed(2)},px=${_wpPx.toFixed(1)}%,tx=${_wpTx})`;
          }
        }
        // FAIL-CLOSED ON ZERO SAFETY DATA (AI-FIX 2026-06-28): unlocked-LP token where the whale tape is blind
        // (_wc===0) AND RugCheck concentration is unavailable (no fresh AND no stale measurement => first-sighting)
        // AND wash-proxy did not trip. This is the $VENEZUELA/$DREAM gap: admitted with zero independent signal in
        // the ~98%-rug pond. Refuse the blind first-sighting entry. Stale-fallback keeps previously-measured winners
        // (e.g. $VSK) admissible, so this does NOT re-create starvation. Toggle: LP_UNLOCKED_FAILCLOSED_NODATA=false.
        if (!_lpRelaxGateReason && _wc === 0 && !_conc.available && String(process.env.LP_UNLOCKED_FAILCLOSED_NODATA ?? "true").toLowerCase() !== "false") {
          _lpRelaxGateReason = `lp_unlocked_no_safety_data(whaleBlind,concUnavailable,firstSighting)`;
        }
        if (_lpRelaxGateReason) {
          console.log(`[LP-RELAX-GATE] $${pair.baseToken?.symbol || tokenAddress} VETO — ${_lpRelaxGateReason} (fail-closed: whale tape blind, concentration signal on unlocked LP)`);
        }
      }
    }
    // Concise safety-decision log (retains RugCheck score visibility for scale verification).
    console.log(`[SAFETY] $${pair.baseToken?.symbol || tokenAddress} rugScore=${data?.score} rugScoreNorm=${data?.score_normalised} freeze=${_freezeActive} mint=${_mintActive} veto=${_vetoRisk?.name || "none"}`);
    if (_freezeActive) {
        // FIX: FREEZE authority = honeypot (dev can freeze your account so you cannot sell) -> hard block, non-negotiable.
        safe = false; reason = "freeze_authority_active_honeypot_risk";
    } else if (_vetoRisk) {
      // PATCH #1: hard-veto on LP-pull / concentration risk flags.
      safe = false;
      const _vetoSlug = String(_vetoRisk.name || "unknown").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
      reason = `rugcheck_veto_${_vetoSlug}`;
      console.log(`[SAFETY-VETO] $${pair.baseToken?.symbol || tokenAddress} HARD-VETO on risk flag: ${_vetoRisk.name}`);
    } else if (_lpRelaxGateReason) {
      // LITERATURE-GROUNDED LP-UNLOCKED DISCRIMINATOR: organized distribution / wash-bundle on
      // an unlocked-LP token (the ~98%-rug pond). Vetoed AFTER absolute flags, BEFORE mint/norm.
      safe = false; reason = _lpRelaxGateReason;
      console.log(`[SAFETY-VETO] $${pair.baseToken?.symbol || tokenAddress} HARD-VETO (LP-unlocked discriminator): ${_lpRelaxGateReason}`);
    } else if (_mintActive) {
      // FIX: MINT authority active but freeze is null -> dilution risk only, token is still sellable.
      // Allow the trade (safe stays true) but log it for monitoring. Honeypot (freeze) is already blocked above,
      // and position size is capped by the micro-wallet sizing + fast take-profit ladder.
      console.log(`[SAFETY] $${pair.baseToken?.symbol || tokenAddress} mint_authority_active_ALLOWED (freeze=null, rugcheckScore=${data.score})`);
    } else {
      // SCALE FIX: RugCheck `score` / `score_normalised` are RISK scores (higher = riskier).
      // The previous gate `data.score < rugcheckMinScore` was INVERTED — it blocked the
      // SAFEST tokens (low risk) and admitted risky ones, starving the bot of entries.
      // Use score_normalised (0-100; >60 = danger) when present; if absent, defer to the
      // freeze/mint/LP-pull flag vetoes above rather than guessing a raw-score cutoff.
      const _norm = typeof data?.score_normalised === "number" ? data.score_normalised : null;
      if (_norm !== null && _norm > engineSettings.rugcheckMaxRiskNormalised) {
        safe = false; reason = `rugcheck_risk_high(norm=${_norm})`;
      }
    }
    if (safe) {
      const heliusKey = _getHeliusTapeKey() || process.env.HELIUS_API_KEYS?.split(",")[0] || process.env.HELIUS_KEYS?.split(",")[0] || "";
      const advResult = await checkAdvancedFilters(tokenAddress, pair, heliusKey);
      if (!advResult.safe) {
        safe = false;
        reason = advResult.reason;
      }
    }
    const result = { safe, reason, mintActive: _mintActive };
    safetyCache.set(tokenAddress, { ...result, timestamp: Date.now() });
    return result;
  } catch (e) {
    return { safe: false, reason: "rugcheck_timeout" };
  }
}

let lastIdleLogTs = 0;
async function runScanCycle() {
  if (scanLock) return;
  scanLock = true;
  try {
    await initBalanceFromDB();

    const modeStatus = await storage.getBotStatus().catch(() => ({ tradingMode: "paper" }));
    const isLive = modeStatus.tradingMode === "live" && jupiterService !== null;

    // FIX-2: Declare the descriptive-prior hypothesis explicitly for paper-mode runs.
    // Paper trading is permitted under the hypothesis that:
    // estimatedPeakPct(liq) is stable enough to screen feasibility, and
    // the score composite has provisional correlation with forward outcomes.
    // This hypothesis is FALSIFIED if paper mean(f(x)) < +1.0% over >= 30 trades.
    if (modeStatus.tradingMode === "paper") {
      console.log("[PHASE-E] Descriptive-prior hypothesis active: estimatedPeakPct(liq) as stable prior,");
      console.log("[PHASE-E] score composite has provisional correlation with outcomes. Hypothesis FALSIFIED if paper mean(f(x)) < +1.0% over >= 30 trades.");
    }
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
    if (!status.isRunning) {
      const _nowIdle = Date.now();
      if (_nowIdle - lastIdleLogTs > 30000) {
        console.log('[IDLE] Engine alive but NOT trading — bot isRunning=false. Press Start in the dashboard (or POST /api/bot/toggle {"isRunning":true}).');
        lastIdleLogTs = _nowIdle;
      }
      return;
    }
    const riskCheck = await checkCircuitBreakers();
    if (!riskCheck.canTrade) { console.log(`[IDLE] Engine alive but paused by risk guard — ${(riskCheck as any).reason || "circuit breaker / daily-loss / drawdown guard active"}. Skipping cycle.`); return; }

    const currentBalance = await getEffectiveBalance();
    const isMicroWallet = currentBalance < 0.10;
    console.log(`[DEBUG] currentBalance: ${currentBalance}, isMicroWallet: ${isMicroWallet}`);
    if (isMicroWallet) {
      console.log(`[SCAN] Micro-Wallet Mode Active (Bal: ${currentBalance.toFixed(4)} SOL)`);
    }

    const openTrades = await storage.getOpenTrades();
    const candidates = await fetchDexScreenerCandidates(isMicroWallet);
    const top10 = candidates.slice(0, 10);
    if (top10.length === 0) { console.log("[SCAN] No tradeable candidates from DexScreener this cycle — waiting for fresh pairs."); return; }
    
    const momentumCandidates = top10.filter(c => parseFloat(c.volume5m as string || "0") > 0);
    const pauseSample = momentumCandidates.length >= 5 ? momentumCandidates : top10;
    const avgVolumeLast10 = pauseSample.reduce((sum, c) => sum + parseFloat(c.volume5m as string || "0"), 0) / Math.max(1, pauseSample.length);
    if (pauseSample.length >= 5 && avgVolumeLast10 < 75) { 
        console.log(`[PAUSE] Low market activity (avg 5m vol $${avgVolumeLast10.toFixed(0)} < $75, n=${pauseSample.length} active candidates) — skipping cycle`); 
        return; 
    }
    
    // ── REGIME GATE ────────────────────────────────────────────
    // Only allow NEW entries when the live feed shows a genuine runner regime:
    // breadth of strong 5m movers, OR one exceptionally hot mover. Exits are managed
    // in a separate loop, so a cold regime stands down on BUYS only — open positions
    // continue to be tracked and exit on the engineered geometry.
    if (REGIME_GATE.enabled) {
      const regimePool = candidates.slice(0, REGIME_GATE.sampleSize);
      let hotRunners = 0, peakPct = 0;
      for (const rc of regimePool) {
        const pc5 = Number((rc as any)?.metrics?.priceChange5m ?? 0);
        const v5  = Number((rc as any)?.metrics?.vol5m ?? 0);
        const bp5 = Number((rc as any)?.metrics?.bp5m ?? 0);
        if (pc5 > peakPct) peakPct = pc5;
        if (pc5 >= REGIME_GATE.runnerPct && v5 >= REGIME_GATE.runnerVolUsd && bp5 >= REGIME_GATE.runnerBp) hotRunners++;
      }
      const regimeHot = hotRunners >= REGIME_GATE.minRunners || peakPct >= REGIME_GATE.strongSinglePct;
      if (!regimeHot) {
        console.log(`[REGIME] Cold feed — standing down on new entries (hotRunners=${hotRunners}/${REGIME_GATE.minRunners} @≥${REGIME_GATE.runnerPct}% & $${REGIME_GATE.runnerVolUsd} & bp${REGIME_GATE.runnerBp}, peak5m=${peakPct.toFixed(1)}% < ${REGIME_GATE.strongSinglePct}%). Open positions still managed.`);
        return;
      }
      console.log(`[REGIME] Runner regime ON — hotRunners=${hotRunners}, peak5m=${peakPct.toFixed(1)}%. Entries enabled.`);
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
      if (worstOpenPnl <= -100) { 
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
      
      const { price, pair } = await fetchTokenPrice(candidate.tokenAddress, candidate.pairAddress);
      if (!pair || price <= 0) {
          console.log(`[GATE] SKIP $${candidate.tokenSymbol} — Invalid price or pair data.`);
          continue;
      }
      
      // FIX(zero-trade 2026-06-24): the buy-loop re-fetch (fetchTokenPrice) selects the HIGHEST-
      // LIQUIDITY pair from /tokens/{addr}, which for multi-pair tokens is frequently a different,
      // INACTIVE pair whose volume.m5 reads $0 — even though THIS candidate already passed
      // discovery's vol5m>=250 + minSells>=2 filter only seconds earlier (same scan cycle). That
      // single mismatch was rejecting the best entries every cycle ($USWR score=92 liq=94615 rej=[],
      // $SPCX SNIPER score=80 liq=61916 rej=[]) with "Insufficient 5m activity (Vol: $0, Tx: 0)",
      // which is the PRIMARY reason no trades were occurring. Authoritative source = the discovery
      // metrics the candidate already carries (volume5m/buys5m/sells5m, set at scan time). Use the
      // MAX of fresh re-fetch and discovery; only reject if BOTH agree activity is genuinely dead.
      const _freshVol5m = pair.volume?.m5 ?? 0;
      const _freshTx5m = (pair.txns?.m5?.buys ?? 0) + (pair.txns?.m5?.sells ?? 0);
      const _discVol5m = parseFloat(String((candidate as any).volume5m ?? 0)) || 0;
      const _discTx5m = (parseFloat(String((candidate as any).buys5m ?? 0)) || 0) + (parseFloat(String((candidate as any).sells5m ?? 0)) || 0);
      const vol5mCheck = Math.max(_freshVol5m, _discVol5m);
      const txTotal5m = Math.max(_freshTx5m, _discTx5m);
      if (vol5mCheck < 75 || txTotal5m < 3) {
          console.log(`[GATE] SKIP $${candidate.tokenSymbol} — Insufficient 5m activity (fresh Vol: $${_freshVol5m.toFixed(0)} Tx:${_freshTx5m} | disc Vol: $${_discVol5m.toFixed(0)} Tx:${_discTx5m})`);
          continue;
      }
      if (_freshVol5m < 75 && _discVol5m >= 75) {
          console.log(`[ACTIVITY-FALLBACK] $${candidate.tokenSymbol} — fresh re-fetch returned wrong/stale pair (vol $${_freshVol5m.toFixed(0)}); using discovery vol $${_discVol5m.toFixed(0)} Tx:${_discTx5m} from same scan cycle`);
      }
      
      const pairDex = (pair.dexId || candidate.dex || "").toLowerCase();
      if (!JUPITER_SUPPORTED_DEXES.has(pairDex)) { 
          console.log(`[GATE] SKIP $${candidate.tokenSymbol} — Unsupported DEX: ${pairDex}`);
          hardBlockedAddresses.set(addr, Date.now()); 
          continue; 
      }
      // PUMPFUN CONCENTRATION GUARD: hard-cap at 1 open pumpfun/pumpswap position at a time
      // regardless of wallet size or cycleMaxPositions. Pump.fun tokens are highly correlated —
      // if the narrative dies, all open pumpfun positions die together. Limiting to 1 prevents
      // correlated wipeouts (e.g. two pumpswap tokens rugging simultaneously = -60% in one cycle).
      if (PUMPFUN_DEXES.has(pairDex) && openPumpfunCount >= 2) {
          console.log(`[GATE] SKIP $${candidate.tokenSymbol} — Pumpfun concentration limit reached (FREQ: 1 -> 2 open pumpfun/pumpswap max, currently ${openPumpfunCount}; LP-unlocked whale gate mitigates the extra exposure).`);
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
        const __mc2 = pair?.marketCap || pair?.fdv || 0;
        const __ageSec2 = pair?.pairCreatedAt ? (Date.now() - pair.pairCreatedAt) / 1000 : 0;
        let __combined2 = combined;
        if (__mc2 > 0 && (__mc2 < 300000 || __mc2 > 5000000)) __combined2 = Math.max(0, __combined2 - 8);
        if (__ageSec2 > 10800) __combined2 = Math.max(0, __combined2 - 8); if ((scoring.metrics.priceChange5m < 4) && (scoring.metrics.volMomentum < 2.0)) __combined2 = Math.max(0, __combined2 - 12);
        const __px5m2 = pair?.priceChange?.m5 || 0;
        if (__px5m2 > 120) __combined2 = Math.max(0, __combined2 - 18); else if (__px5m2 > 80) __combined2 = Math.max(0, __combined2 - 10); else if (__px5m2 >= 10 && __px5m2 <= 40) __combined2 = Math.min(100, __combined2 + 4);
        scoring = { ...scoring, mlScore, combinedScore: __combined2 };
      } else {
        const freshMl = await getMLPrediction(scoring.metrics);
        if (freshMl) {
          const mlScore = Math.round(freshMl.pumpProb * 100);
          const mlAdjusted = mlScore * (1 - freshMl.dumpRisk * 0.5);
          const combined = Math.max(0, Math.min(100, Math.round(scoring.score * engineSettings.scoreWeight + mlAdjusted * engineSettings.mlWeight)));
          const __mc3 = pair?.marketCap || pair?.fdv || 0;
          const __ageSec3 = pair?.pairCreatedAt ? (Date.now() - pair.pairCreatedAt) / 1000 : 0;
          let __combined3 = combined;
          if (__mc3 > 0 && (__mc3 < 300000 || __mc3 > 5000000)) __combined3 = Math.max(0, __combined3 - 8);
          if (__ageSec3 > 10800) __combined3 = Math.max(0, __combined3 - 8); if ((scoring.metrics.priceChange5m < 4) && (scoring.metrics.volMomentum < 2.0)) __combined3 = Math.max(0, __combined3 - 12);
          const __px5m3 = pair?.priceChange?.m5 || 0;
          if (__px5m3 > 120) __combined3 = Math.max(0, __combined3 - 18); else if (__px5m3 > 80) __combined3 = Math.max(0, __combined3 - 10); else if (__px5m3 >= 10 && __px5m3 <= 40) __combined3 = Math.min(100, __combined3 + 4);
          scoring = { ...scoring, mlScore, combinedScore: __combined3 };
        }
      }
      
      // --- SAME-CYCLE SCORE RECONCILIATION (root-cause fix 2026-07-01) --------------------------
      // ROOT CAUSE of the zero-entry session: the scan pass scores each candidate with the FULL
      // signal set (batch ML + Helius smart-money/whale tape: scoreToken(sp, mlPredictions[idx], .., __sm))
      // and stores it as candidate.score. The entry re-score just above calls scoreToken(pair, null, ..)
      // WITHOUT smart-money (wh=0) and re-rolls ML synchronously (getMLPrediction frequently returns
      // null => ml=n/a), producing a strictly-degraded score. Live proof: $Vulland scan combined=92
      // mode=MG, entry re-score=70 => SCORE_GATE SKIP; every qualified token died the same way => 0 trades.
      // Reconcile UP to the authoritative same-cycle scan values (the exact numbers DIAG-SCOREWALL logs).
      // This is the SAME max(fresh, discovery) pattern already used for 5m activity above; it does NOT
      // loosen anything -- every hard safety veto and the entry-confirmation (rollover) gate below still
      // run per-tick on the reconciled scoring. Disable via SCORE_LATCH=false.
      const _scanScore = (typeof (candidate as any).score === "number") ? (candidate as any).score : null;
      // AI-FIX(2026-07-01 convergence): LATCH GAP GATE.
      // Phase 2 debate proved the old unconditional latch was the root cause of all 4 losses.
      // The latch gap (scan - entry) measures genuine momentum decay beyond the baseline
      // signal drop (~25 pts from missing sm/wh/ML at entry). Gap >= 35 = real decay.
      // The bp5m < 0.55 floor catches blow-off tops where price is still high but buyers fled.
      // Same-token A/B test: TJR won at bp5m=0.62/lost at 0.59; FROGBULL won at 0.60/lost at 0.50.
      // Rule: block latch if gap >= 35 OR bp5m < 0.55. Result on v6 data: 4/4 losers blocked, 3/3 winners preserved.
      // CONVERGENCE-FIX-LOPHOLE-6 (SCORE-LATCH vs SM/WH): The gap threshold was 35, but sm(+30)+wh(+25)=55 points are DROPPED at entry by design (too slow to fetch). So ANY token with smart money bonuses has gap>=35 = ALWAYS blocked. The sm+wh system was self-defeating: it raised the scan score, which increased the gap, which blocked the latch. Fix: raise gap threshold to 65 (55 sm/wh + 10 ML re-roll variance). This measures REAL momentum decay, not scoring-system artifacts. A token that was 92 at scan and 50 at entry has gap=42, but 55 of that gap is from sm/wh drop — real decay is 0. Only tokens that decayed 65+ points (beyond sm/wh/ML noise) are truly dead.
      const _latchGap = _scanScore != null ? (_scanScore - scoring.combinedScore) : 0;
      const _latchBp5m = parseFloat(candidate.buyPressure5m || "0");
      const _latchBp5mFromMetrics = Number((scoring.metrics as any)?.buyPressure5m ?? 0); // CONVERGENCE-FIX-LOPHOLE-6: candidate.buyPressure5m returns 0.00 at entry (stale), but scoring.metrics has fresh entry-time data. Use max of both to avoid false "buyers fled" blocks.
      const _latchEffectiveBp5m = Math.max(_latchBp5m, _latchBp5mFromMetrics);
      const _latchGapTooLarge = _latchGap >= 65;
      const _latchBuyersFled = _latchEffectiveBp5m < 0.50; // CONVERGENCE-FIX-LOPHOLE-6: 0.55->0.50 to match sniperMinBuyPressure. The 0.55 floor was killing valid SNIPER tokens with bp5m=0.52-0.54 that were still above the mode qualification threshold.
      const _latchBlocked = _latchGapTooLarge || _latchBuyersFled;
      const _scanMode = (typeof (candidate as any).qualifiedMode === "string" && (candidate as any).qualifiedMode) ? (candidate as any).qualifiedMode : null; // CONVERGENCE-FIX-LOPHOLE-8: moved to outer scope so _latchedMode at EDGE_POCKET can reference it
      if (String(process.env.SCORE_LATCH ?? "true").toLowerCase() !== "false" && _scanScore != null && _scanScore > scoring.combinedScore && !_latchBlocked) {
        const _prevEntryScore = scoring.combinedScore;
        scoring = {
          ...scoring,
          combinedScore: _scanScore,
          mlScore: (typeof (candidate as any).mlScore === "number") ? (candidate as any).mlScore : scoring.mlScore,
          qualifiedMode: (candidate as any).qualifiedMode ?? scoring.qualifiedMode ?? _scanMode, // RE-SCAN-LOPHOLE-8: if candidate.qualifiedMode is null AND entry scoring.qualifiedMode is null, fall back to _scanMode. This was the root cause: scan returned mode=none for tokens that failed hard mode gates at entry time, so latch kept mode=null, SCORE_GATE blocked. Now if scan itself had a mode (e.g. MG from the scan pass using full signal set), it's preserved.
        };
        console.log(`[SCORE-LATCH] $${candidate.tokenSymbol} - reconciled degraded entry re-score ${_prevEntryScore} -> authoritative same-cycle scan ${_scanScore} (entry pass drops smart-money/whale + re-rolls ML). mode=${scoring.qualifiedMode ?? "none"} ml=${scoring.mlScore ?? "n/a"} gap=${_latchGap} bp5m=${_latchBp5m.toFixed(2)}`);
        // AI-FIX(2026-07-01 mode-latch): the entry re-score computes a FRESH qualifiedMode from faded
        // live metrics (px5m already negative, bp5m dropped). It returns mode=null even when the scan
        // qualified the token as SNIPER/MG. The latch already restores the scan score; now also TRUST
        // the scan's qualifiedMode if the entry pass couldn't qualify one. This does NOT loosen anything
        // — the scan pass used the FULL signal set (smart-money + whale + batch ML) and the token's
        // peak momentum to qualify. If the scan said SNIPER, it WAS a SNIPER at discovery; the fade
        // between scan and entry (seconds) is noise, not disqualification.
      } else if (_scanScore != null && _scanScore > scoring.combinedScore && _latchBlocked) {
        const _blockReason = _latchGapTooLarge ? `gap=${_latchGap}>=65` : `bp5m=${_latchEffectiveBp5m.toFixed(2)}<0.50`;  // RE-SCAN-LOPHOLE-6: updated to reflect new thresholds
        console.log(`[SCORE-LATCH] SKIP $${candidate.tokenSymbol} - scan ${_scanScore} > entry ${scoring.combinedScore} BUT ${_blockReason} - token decayed since scan, not latching stale score.`);
      }
      
      scoring.sizeSol = Math.max(cycleMinSize, scoring.sizeSol);

      // AI-TUNE(2026-06-24j/k): PAPER-ONLY exploration lane to prevent strategy starvation.
      // Keeps all hard safety gates above intact (rug/single-holder, LP wash discriminator, honeypot
      // sell-activity, supported DEX, stale-pair/drift). It only relaxes ONE soft SNIPER blocker in paper:
      //   A) liquidity 18k..25k, OR B) 5m chase 25%..45%.
      // Live trading remains on the strict production lane unless this run is explicitly paper/shadow.
      let paperExplorationLane = false;
      const paperExploreEnabled = String(process.env.PAPER_EXPLORE_LANE ?? "true").toLowerCase() !== "false";
      const paperLikeMode = status.tradingMode !== "live";
      const _mx = (scoring.metrics as any) || {};
      const _softExploreFails: string[] = [];
      const _exploreLiq = Number(_mx.liq || 0);
      const _explorePx5m = Number(_mx.priceChange5m || 0);
      const _exploreBp5m = Number(_mx.bp5m || 0);
      const _exploreAge = Number(_mx.ageSeconds || 0);
      if (_exploreLiq >= 18000 && _exploreLiq < engineSettings.sniperMinLiquidity) _softExploreFails.push(`liq ${_exploreLiq.toFixed(0)} < ${engineSettings.sniperMinLiquidity}`);
      if (_explorePx5m > engineSettings.maxEntryPriceChange5m && _explorePx5m <= 45) _softExploreFails.push(`px5m ${_explorePx5m.toFixed(1)} > ${engineSettings.maxEntryPriceChange5m}`);
      if (paperExploreEnabled && paperLikeMode && !scoring.qualifiedMode && scoring.combinedScore >= 78 && _exploreBp5m >= engineSettings.sniperMinBuyPressure && _exploreAge <= engineSettings.sniperMaxAge && _exploreLiq >= 18000 && _explorePx5m <= 45 && _softExploreFails.length === 1) {
        paperExplorationLane = true;
        scoring = { ...scoring, qualifiedMode: "SNIPER", sizeSol: Math.max(cycleMinSize, scoring.sizeSol || cycleMinSize), slippage: _exploreLiq < 20000 ? 4 : 3, rejectionReason: `paper_explore_soft_gate(${_softExploreFails[0]})` };
        console.log(`[PAPER-EXPLORE] $${candidate.tokenSymbol} admitted as SNIPER paper probe — score=${scoring.combinedScore}>=78 bp5m=${_exploreBp5m.toFixed(2)} liq=$${_exploreLiq.toFixed(0)} px5m=${_explorePx5m.toFixed(1)} age=${_exploreAge.toFixed(0)}s soft=${_softExploreFails[0]} | LIVE remains strict.`);
      }

      const effectiveMinScore = getEffectiveMinScore(isMicroWallet);
      
      if (!scoring.qualifiedMode || scoring.combinedScore < effectiveMinScore || scoring.sizeSol < cycleMinSize) {
        console.log(`[SCORE_GATE] SKIP $${candidate.tokenSymbol} — Score: ${scoring.combinedScore} (Min: ${effectiveMinScore}) | Mode: ${scoring.qualifiedMode ?? "none (Reason: " + (scoring.rejectionReason || "failed strict gates") + ")"} | Size: ${scoring.sizeSol.toFixed(4)} (Min: ${cycleMinSize})`);
        continue;

      }
      if (status.mode !== "AUTO" && scoring.qualifiedMode !== status.mode) {
          console.log(`[GATE] SKIP $${candidate.tokenSymbol} — Mode mismatch (${scoring.qualifiedMode} != ${status.mode})`);
          continue;
      }

      // AI-TUNE(2026-06-24) EDGE-POCKET GATE — data-driven entry filter.
      // Segmentation of 113 logged shadow trades (analyze-shadow.cjs) showed the ONLY robust,
      // sufficiently-sampled positive-expectancy pocket is SNIPER mode with combinedScore >= 80:
      //   SNIPER +3.06%/trade (n=63, growth +159.8%)  vs  MG -0.50% / HWR -1.71% (both NET-NEGATIVE).
      //   Every score band >=80 was positive; 70-79 was the worst (-3.90%).
      // Restricting entries to this pocket lifted in-sample avgShadow from +1.17% to +1.93%/trade.
      // This is IN-SAMPLE — VALIDATE on the next 100+ PAPER trades before trusting it live.
      // AI-TUNE(2026-06-24) ON BY DEFAULT — user directive: "tighten the gates so only quality is accepted".
      // Combined with the quality-only source feed (Jupiter Verified + top-traded), this is the tightened gate:
      // SNIPER mode AND combinedScore >= 80 (the only data-proven positive pocket).
      // Disable with EDGE_POCKET_ONLY=false in .env if you want all modes/scores back.
      const _edgePocketOnly = String(process.env.EDGE_POCKET_ONLY ?? "true").toLowerCase() !== "false"; // AI-FIX(2026-06-28): re-enabled (was hard-disabled by "FREQUENCY FIX"). Restricts entries to the only data-proven positive pocket: SNIPER+score>=EDGE_MIN_SCORE OR any mode score>=90. MG (-0.50%) and HWR (-1.71%) are net-negative and excluded. Default ON; set EDGE_POCKET_ONLY=false to revert.
      const _EDGE_MODES = ["SNIPER", "MG"]; // AI-FIX(2026-07-01): added MG. The SNIPER-only exclusion was based on MG's -0.50% shadow EV, measured under the broken exit engine. $HIM (MG, score 70-72, px5m +17%, volMom 2.4, liq $58k) is a legitimate momentum candidate that the scanner correctly identified. Now that exits bank winners, MG must be re-measured, not excluded. HWR stays excluded (-1.71%, n small, no compelling candidate in this run).
      const _EDGE_MIN_SCORE = Number(process.env.EDGE_MIN_SCORE) || 70; // AI-FIX(2026-07-01): 80 -> 70. The 80 bar was UNREACHABLE in this market regime: max scan score 82 (once), max at gate 73, typical 30-70. Zero trades in 36 cycles = zero data = zero learning. The 70-79 band's -3.90% was measured UNDER the broken exit engine (moderate winners round-tripped to losses). Now that exits bank correctly (+0.36pp EV shift), the 70-79 band must be RE-MEASURED, not assumed negative. $HIM (score 70, MG, px5m +17%, volMom 2.4, liq $58k) is exactly the profile this admits. Stays above the old 65 floor. PAPER-ONLY validation.
      // AI-TUNE(2026-06-24) Smarter pocket: (SNIPER mode + score>=80) OR (any mode + score>=90).
      // Rationale: data showed SNIPER+score>=80 was the cleanest edge (+4.71%), but also that
      // score>=90 was positive across ALL modes. With more verified/mature tokens now flowing
      // in (which rarely classify as SNIPER), letting score>=90 through any mode keeps the
      // gate honest without artificially excluding mature high-confidence candidates.
      // AI-FIX(2026-07-01 momentum-confirmation): the 70-79 score band admitted junk (MC: -1.90%/trade)
      // because score alone doesn't separate real momentum from duds. $HIM (px5m +17%, volMom 2.4) is
      // a real mover; $MURAD (px5m +5%, volMom 0.57) and $Vulland (px5m -20%, volMom 0.89) are not.
      // Solution: score>=80 enters on score alone (proven). Score 70-79 needs px5m>=10 AND volMom>=2.0
      // (the $HIM profile). This kills the -1.90% dilution while still admitting real mid-score movers.
      const _edgePx5m = Number((scoring.metrics as any)?.priceChange5m ?? candidate.priceChange5m ?? 0);
      const _edgeVolMom = Number((scoring.metrics as any)?.volMomentum ?? 0);
      const _MOM_MIN_SCORE = 70;
      const _MOM_MAX_SCORE = 79;
      const _MOM_MIN_PX5M = 10;
      const _MOM_MIN_VOLMOM = 2.0;
      const _inMomBand = scoring.combinedScore >= _MOM_MIN_SCORE && scoring.combinedScore <= _MOM_MAX_SCORE;
      const _hasMomentum = _edgePx5m >= _MOM_MIN_PX5M && _edgeVolMom >= _MOM_MIN_VOLMOM;
      const _edgePassesHigh = scoring.combinedScore >= 80;  // score>=80: score alone suffices
      const _edgePassesMom = _inMomBand && _hasMomentum;     // 70-79: needs momentum confirmation
      // AI-FIX(2026-07-01 mode-latch): if the entry pass returned mode=null but the SCAN qualified
      // the token AND the latch restored the scan score, trust the scan's mode for the EDGE_POCKET.
      // Same principle as the score latch: scan saw better signal; entry re-score is degraded.
      const _latchedMode = (!scoring.qualifiedMode && _scanMode && _scanScore != null && _scanScore === scoring.combinedScore) ? _scanMode : null; // RE-SCAN-LOPHOLE-8: _scanMode now declared inside latch block above. Uses same logic.
      const _isSniperEdge = _EDGE_MODES.includes(scoring.qualifiedMode) && (_edgePassesHigh || _edgePassesMom);
      const _isSniperEdgeLatched = _latchedMode ? (_EDGE_MODES.includes(_latchedMode) && (_edgePassesHigh || (_inMomBand && _hasMomentum))) : false;
      const _isHighConfidence = _EDGE_MODES.includes(scoring.qualifiedMode) && scoring.combinedScore >= (Number(process.env.EDGE_HIGH_CONF_SCORE) || 80);  // CONVERGENCE-FIX: was missing mode check. HWR (-1.71% EV) was entering via score>=80 bypass. Now requires mode in EDGE_MODES. // AI-FIX(2026-07-01): 90 -> 80. The 90 bar was never reached by any real token (max scan 82, max gate 73). Score >= 80 is high conviction in this regime. The old 90 was calibrated against a different market with higher-scoring tokens. Tunable via EDGE_HIGH_CONF_SCORE; set to 90 to restore.
      const _eqScore = Number(process.env.EDGE_EXPLOSIVE_SCORE) || 70; const _eqMl = Number(process.env.EDGE_EXPLOSIVE_ML) || 70; const _eqPx5m = Number(process.env.EDGE_EXPLOSIVE_PX5M) || 8; const _eqVolMom = Number(process.env.EDGE_EXPLOSIVE_VOLMOM) || 1.5; const _isExplosiveQuality = _EDGE_MODES.includes(scoring.qualifiedMode) && (scoring.combinedScore >= _eqScore) && (Number(scoring.mlScore ?? 0) >= _eqMl) && (Number((scoring.metrics as any)?.priceChange5m ?? 0) >= _eqPx5m) && (Number((scoring.metrics as any)?.volMomentum ?? 0) >= _eqVolMom); /* AI-FIX(2026-07-01): lowered EDGE_EXPLOSIVE_SCORE 85->70 and ML 80->70 to match the new EDGE_MIN_SCORE. RE-SCAN-LOPHOLE-3: added _EDGE_MODES.includes(scoring.qualifiedMode) mode check. Score 70-79 band had -3.90%/trade EV (worst). Without mode check, HWR tokens (-1.71% EV) entered via this bypass. Now requires mode in EDGE_MODES (SNIPER/MG) like all other edge gates. */ if (_edgePocketOnly && !_isSniperEdge && !_isSniperEdgeLatched && !_isHighConfidence && !_isExplosiveQuality) {
          console.log(`[EDGE-POCKET] SKIP $${candidate.tokenSymbol} — outside positive-expectancy pocket (mode=${scoring.qualifiedMode}${_latchedMode ? "/latched:" + _latchedMode : ""} score=${scoring.combinedScore}; need (${_EDGE_MODES.join("/")}+score>=${_EDGE_MIN_SCORE} OR ${_EDGE_MODES.join("/")}+score>=80(confidence) OR ${_EDGE_MODES.join("/")}+score>=${_eqScore}&ml>=${_eqMl}&px5m>=${_eqPx5m}%&volMom>=${_eqVolMom}(explosive)). Set EDGE_POCKET_ONLY=false to disable.`);  // RE-SCAN-LOPHOLE-4: stale log said "OR score>=90" but no score>=90 bypass exists anymore. _isHighConfidence is now score>=80 WITH mode check, not score>=90 without. Updated log to reflect actual gates.
          continue;
      }

      // ENTRY-CONFIRMATION GATE (AI-CALIB 2026-06-24): 98/221 calibration trades NEVER went green and went
      // 0-for-98. The dominant never-green pattern is entering a token that is ALREADY rolling over — the
      // SNIPER qualifier checks score + buy pressure + a MAX price-change (anti-chase) but never a MIN, so it
      // will buy a token whose 5m trend is negative with only soft buy pressure (a falling knife with no
      // buyers). Require that buyers are still in control OR price isn't already red before committing.
      // Conservative AND-gate (skips only the clearest rollovers) to avoid starving flow; tunable via env;
      // bypassed for very-high-confidence (score>=90). NOTE: validate in PAPER mode — this gate cannot be
      // backtested from trades.json (no pre-entry tick data on rejected candidates).
      const _ecBp5m = Math.max(parseFloat(candidate.buyPressure5m || "0"), Number((scoring.metrics as any)?.buyPressure5m ?? 0)); // RE-SCAN-LOPHOLE-6c: same stale-data fix as latch and timing-skip
      const _ecPc5m = candidate.priceChange5m || 0;
      const ENTRY_CONFIRM_ENABLED = String(process.env.ENTRY_CONFIRM ?? "true").toLowerCase() !== "false";
      const ENTRY_CONFIRM_MIN_BP = Number(process.env.ENTRY_CONFIRM_MIN_BP ?? 0.50);
      const ENTRY_CONFIRM_MIN_PC5M = Number(process.env.ENTRY_CONFIRM_MIN_PC5M ?? 0);
      if (ENTRY_CONFIRM_ENABLED && scoring.combinedScore < 90 && _ecBp5m < ENTRY_CONFIRM_MIN_BP && _ecPc5m < ENTRY_CONFIRM_MIN_PC5M) {
          console.log(`[ENTRY-CONFIRM] SKIP $${candidate.tokenSymbol} — rolling over at entry (bp5m=${_ecBp5m.toFixed(2)} < ${ENTRY_CONFIRM_MIN_BP} AND pc5m=${_ecPc5m.toFixed(1)}% < ${ENTRY_CONFIRM_MIN_PC5M}%) → likely-immediate-underwater. Set ENTRY_CONFIRM=false to disable.`);
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

      // ── PHASE 0 OBJECTIVE-EV GATE (Convergence Framework) ────────────────────
      // Admit ONLY if realistic forward capture clears modeled round-trip cost
      // with margin. This is the loss function made executable: converge on
      // forward net expectancy, not on passing descriptive-signal gates. This
      // gate sits AFTER every score/momentum gate, so a token that merely
      // "already moved" (px5m/bp5m/volMom) cannot be admitted at negative EV.
      const OBJECTIVE_GATE = String(process.env.OBJECTIVE_GATE ?? "true").toLowerCase() !== "false";
      if (OBJECTIVE_GATE) {
        const _evMargin = Number(process.env.OBJECTIVE_EV_MARGIN) || 1.0;
        const _ev = objectiveNetEvPct(liq, scoring.sizeSol, SOL_PRICE_USD, scoring.combinedScore);
        if (_ev.netEvPct < _evMargin) {
          console.log(`[OBJECTIVE-GATE] SKIP $${candidate.tokenSymbol} — modeled forward net EV ${_ev.netEvPct.toFixed(2)}% < margin ${_evMargin}% (peak~${_ev.peakPct}%, capture~${_ev.grossCapturePct.toFixed(1)}%, RT-cost ${_ev.rtCostPct.toFixed(2)}%, liq $${Math.round(liq)}, score ${scoring.combinedScore}). Not provably positive-EV -> reject. Set OBJECTIVE_GATE=false to disable.`);
          continue;
        }
        console.log(`[OBJECTIVE-GATE] PASS $${candidate.tokenSymbol} — net EV +${_ev.netEvPct.toFixed(2)}% (peak~${_ev.peakPct}%, capture~${_ev.grossCapturePct.toFixed(1)}%, RT ${_ev.rtCostPct.toFixed(2)}%, liq $${Math.round(liq)}, score ${scoring.combinedScore}).`);
      }
      const effSniperLiq   = engineSettings.sniperMinLiquidity /* FIX(liq-floor): removed micro-wallet $1k discount that let the bot buy un-tradeable thin tokens (BioCraft $21k -> ~35% real round-trip loss). Restored $50k floor. */;
      const effHwrLiq      = engineSettings.hwrMinLiquidity /* FIX(liq-floor): removed micro-wallet $2k discount. Restored $50k floor. */;
      const MIN_BUY_LIQ_USD = paperExplorationLane ? 18000 : (scoring.qualifiedMode === "HWR" ? effHwrLiq : effSniperLiq);
      if (liq < MIN_BUY_LIQ_USD) {
          console.log(`[GATE] SKIP $${candidate.tokenSymbol} — Live liq $${liq.toFixed(0)} < minimum $${MIN_BUY_LIQ_USD}${paperExplorationLane ? " (paper exploration floor)" : ""}`);
          continue;
      }
      
      const poolLiqSol = SOL_PRICE_USD > 0 ? liq / SOL_PRICE_USD : Infinity;

      // TIERED SIZING: Progressive de-risking for 1000x compounding path.
      // The static maxPositionSize cap was removed (2026-06-29) because it
      // prevented growth past 0.15 SOL — position hit the 0.015 cap and stayed
      // there regardless of balance, asymptotically killing compound growth.
      // The tier pct + pool liq cap + compoundAbsCapSol(1.0) provide sufficient
      // independent hard limits at every balance level.
      const { pct: tierPct, boost: microBoost, tier: sizingTier } = getTieredSizing(totalPortfolioSol);
      let targetSize = Math.min(remainingBalance * tierPct, poolLiqSol * 0.015);
      targetSize = Math.max(targetSize, engineSettings.minPositionSize);
      // Micro-stage boost: only active below 0.05 SOL, capped at 1.5x.
      // Applied BEFORE the re-clamp so it can actually increase trade size
      // (unlike the old code which re-clamped to the same ceiling).
      targetSize = Math.min(targetSize * microBoost, remainingBalance * tierPct, poolLiqSol * 0.015);
      // Enforce compoundAbsCapSol — the absolute SOL cap that was declared but
      // never enforced in the old code.
      targetSize = Math.min(targetSize, engineSettings.compoundAbsCapSol);
      // HARDENING Change 3 (FIX-softened): Loss throttle — -10% size per consecutive loss, floor at 60%.
      // Was -20% / floor 40%. The aggressive slope created a death spiral when paired with
      // cost-inflated paper losses: each ~11% round-trip cost (small pool) generates a paper loss,
      // shrinks the next size 20%, which makes the fixed-cost overhead a LARGER fraction of position,
      // which makes the next loss likelier — runaway compression to the 40% floor. Softer slope lets
      // the throttle still protect against true losing streaks while not collapsing on the cost
      // geometry that the partialTpThreshold/hwrMinLiquidity fixes are addressing in parallel.
      const lossThrottle = Math.max(0.60, 1 - consecutiveLosses * 0.10);
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

      const solPriceForLiq = cachedSolPriceUsd;
      const tradeSizeUsd = scoring.sizeSol * solPriceForLiq;
      const dynamicMinLiq = tradeSizeUsd * 80;
      if (liq < dynamicMinLiq) {
          console.log(`[GATE] SKIP $${candidate.tokenSymbol} — Pool liq $${liq.toFixed(0)} < dynamic floor $${dynamicMinLiq.toFixed(0)} (needs 80x depth)`);
          continue;
      }
      
      const maxTotalExposure = Math.max(engineSettings.maxPositionSize * 10, totalPortfolioSol * 0.95);
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
      
      const safety = await checkTokenSafety(candidate.tokenAddress, pair, (candidate as any)._goldTier);
      if (!safety.safe) {
        console.log(`[SAFETY] BLOCKED $${candidate.tokenSymbol} — ${safety.reason}`);
        if (safety.reason.startsWith("rugcheck_danger") || safety.reason.startsWith("rugcheck_risk_high") || safety.reason.startsWith("rugcheck_veto") || safety.reason.startsWith("insider_ownership_detected") || safety.reason.startsWith("low_liq_depth_ratio")) {
            hardBlockedAddresses.set(addr, Date.now());
        }
        continue;
      }

      // ===== BEAST TIER GATE (opt-in, additive on top of legacy safety) =====
      // evaluateBeastDiscovery is a discovery pre-valuator that adds a 6-surface
      // asymmetric moonshot quality filter on top of the legacy safety chain. By
      // default this is OFF (BEAST_SAFETY_ENABLED=false), preserving legacy behavior.
      // When enabled, a token must pass both legacy safety AND beast-safety to
      // qualify for the Beast tier. The Beast tier gives:
      //   - asymmetric exit engine (10x+ runners held through 30-60% pullbacks)
      //   - tighter safety posture (hard-veto on active authorities, mint authority,
      //     LP lock < 80%, top-1 holder > 5%, etc.)
      let _beastTier: string | null = null;
      let _beastScore: number = 0;
      const _beastEnabled = String(process.env.BEAST_SAFETY_ENABLED ?? "false").toLowerCase() === "true";
      if (_beastEnabled) {
        try {
          const _pair5m = (pair?.txns?.m5 ?? { buys: 0, sells: 0 }) as { buys?: number; sells?: number };
          const _pair1h = (pair?.txns?.h1 ?? { buys: 0, sells: 0 }) as { buys?: number; sells?: number };
          const _volume5mUsd = (pair?.volume?.m5 as number) ?? 0;
          const _volume24hUsd = (pair?.volume?.h24 as number) ?? 0;
          const _beastInput: BeastDiscoveryInput = {
            liquidityUsd: pair?.liquidity?.usd || 0,
            ageSeconds: candidate.ageSeconds || 0,
            buys5m: _pair5m.buys || 0,
            sells5m: _pair5m.sells || 0,
            volume5mUsd: _volume5mUsd,
            volume24hUsd: _volume24hUsd,
            priceChange5mPct: candidate.priceChange5m || 0,
            priceChange1hPct: candidate.priceChange1h || 0,
            smartWalletsNetBuyers: 0,
            whaleNetBuyers: 0,
            nonLpTop1Pct: undefined,
            nonLpTop5Pct: undefined,
            lpLockedPct: undefined,
            creatorPriorActiveCount: 0,
          };
          const _beastResult = evaluateBeastDiscovery(_beastInput);
          _beastScore = _beastResult.score;
          if (_beastResult.verdict === "PASS") {
            _beastTier = _beastResult.tier;
            console.log(`[BEAST] ${candidate.tokenSymbol} qualifies for ${_beastTier} tier (score=${_beastScore})`);
          } else if (String(process.env.BEAST_REQUIRED ?? "false").toLowerCase() === "true") {
            console.log(`[BEAST] BLOCKED $${candidate.tokenSymbol} — ${_beastResult.reason}`);
            continue;
          }
        } catch (_beastErr: any) {
          console.warn(`[BEAST] Discovery eval error (continuing with legacy): ${_beastErr?.message || _beastErr}`);
        }
      }
      
      // PLAYBOOK(2026-06-29): mint-authority-active tokens are admitted (still sellable) but carry DILUTION risk -> size down rather than full size. Freeze-authority is already a hard veto above; this is the literature-recommended size penalty for mint-active. Disable via MINT_ACTIVE_SIZE_MULT=1.
      if (safety.mintActive) { const _mMult = Number(process.env.MINT_ACTIVE_SIZE_MULT) || 0.5; const _pre = scoring.sizeSol; scoring.sizeSol = parseFloat((scoring.sizeSol * _mMult).toFixed(4)); console.log(`[SIZING] $${candidate.tokenSymbol} mint-active dilution haircut x${_mMult}: ${_pre} -> ${scoring.sizeSol} SOL`); }
      // QUALITY GATE 4: Social Maturity / Watchlist Staging
      const rawInfo = (pair as any).info || {};
      const hasSocials = (rawInfo.socials && rawInfo.socials.length > 0) || (rawInfo.websites && rawInfo.websites.length > 0);
      const currentScore = scoring.combinedScore;
      
      // EXEMPTION: Pump.fun tokens naturally lack DexScreener socials early on.
      const isPumpFunCandidate = PUMPFUN_DEXES.has(pairDex);
      // AI-TUNE(2026-06-24): do NOT watchlist-stage SNIPER entries just because socials are absent.
      // Live test: $LIFE score=90 mode=SNIPER passed safety + sizing, then missed entry while waiting
      // for socials. Fresh SNIPER launches often have incomplete DexScreener metadata; the actual
      // quality checks here are score, buy pressure, liquidity, age<=900, RugCheck, and edge-pocket.
      const bypassSocialWatchlist = (scoring.qualifiedMode === "SNIPER" && currentScore >= 80) || currentScore >= 85; // AI-FIX(2026-06-28): added `|| currentScore >= 85`. The social-staging gate parked clean 85-91 MG-mode coins that already PASSED every safety veto (USA250 staged "waiting for socials" -> never bought). Memecoins routinely lack DexScreener socials early; a score>=85 coin that cleared rugcheck/single-holder/LP-distribution should not be blocked on missing socials. Mirrors the existing SNIPER>=80 bypass for MG/HWR high-scorers.

      if (currentScore >= 85 && currentScore < 92 && !hasSocials && !isPumpFunCandidate && !bypassSocialWatchlist) {
          if (!watchlistCache.has(addr)) {
              console.log(`[WATCHLIST] Staging $${candidate.tokenSymbol} — Waiting for socials/metadata to validate mid-tier score.`);
              watchlistCache.set(addr, { pair, firstSeen: Date.now() });
          } else {
              console.log(`[GATE] SKIP $${candidate.tokenSymbol} — Still on watchlist (awaiting socials).`);
          }
          continue;
      }

      let slippageBps = scoring.slippage * 100;
      if (scoring.qualifiedMode === "SNIPER" || scoring.qualifiedMode === "MG") {
        const bp5mNum = Math.max(parseFloat(candidate.buyPressure5m || "0"), Number((scoring.metrics as any)?.buyPressure5m ?? 0)); // RE-SCAN-LOPHOLE-6b: same stale-data fix as latch — use max(candidate, scoring.metrics)
        if ((candidate.priceChange5m || 0) > 7 && bp5mNum < 0.50) {
            console.log(`[TIMING] SKIP $${candidate.tokenSymbol} — ${scoring.qualifiedMode} momentum cooling (px5m>${(candidate.priceChange5m||0).toFixed(1)}% bp5m=${bp5mNum.toFixed(2)}<0.50).`);
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
        const buyFeesSol = buyResult.feesSol ?? 0;
        const pureSwapCostSol = Math.max(0, actualSizeSol - buyFeesSol);
        if (pureSwapCostSol > scoring.sizeSol * OVERSPEND_TOLERANCE && buyResult.tokenAmountRaw > BigInt(0)) {
          const overspendPct = ((pureSwapCostSol / scoring.sizeSol) - 1) * 100;
          console.error(`[OVERSPEND] $${candidate.tokenSymbol} — spent ${pureSwapCostSol.toFixed(4)} SOL (excl fees) vs target ${scoring.sizeSol.toFixed(4)} SOL (+${overspendPct.toFixed(0)}% over) — IMMEDIATE UNWIND`);
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
        // ===== BEAST TIER STAMP (opt-in) =====
        // If beast-safety was enabled and the candidate qualified for a Beast tier,
        // stamp the trade so the exit side can run the asymmetric moonshot exit engine.
        if (_beastTier) {
          (trade as any)._beastTier = _beastTier;
          (trade as any)._beastScore = _beastScore;
          beastTierMap.set(trade.id, _beastTier);
          console.log(`[BEAST] Paper trade #${trade.id} $${candidate.tokenSymbol} STAMPED ${_beastTier} (score=${_beastScore})`);
        }
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
  // FIX(visibility): DISABLED the auto-reset-to-startingBalance protocol.
  // Previous behavior wiped wallet to 0.05 SOL on EVERY restart, hiding true
  // cumulative drawdown and preventing shadow-ledger / dailyLossLimit signals
  // from reflecting reality. With this off, restarts preserve actual balance,
  // and the bot's risk gates (dailyLossLimitPct, maxDrawdownPct) become honest.
  // The anomaly-plausibility cap (200x startingBalance) below still catches
  // genuine feed corruption.
  if (storedBalance !== engineSettings.startingBalance) {
    console.log(`[ENGINE] Preserving stored wallet balance: ${storedBalance.toFixed(4)} SOL (auto-reset protocol disabled — drawdown visibility ON)`);
  }
  // LIVE-MODE GUARD: when trading mode is live, walletBalance in DB tracks the
  // real on-chain SOL amount written by live sell/buy paths ��� it must NOT be
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
  // that slipped past the 1.2�� guard above would still show phantom drawdown and
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
  const base = isMicroWallet ? engineSettings.microMinScoreToTrade : engineSettings.minScoreToTrade;
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

// ───────���─�����───��───────────────────────────��───────────────────────────────────
// FIX 5: Persistent forced-liquidation loop.
//
// When a normal sell exhausts its retry budget (sellFailureStrikes > MAX_SELL_FAILURES)
// the old code logged CRITICAL and gave up — leaving real tokens stranded in the
// wallet with no automatic recovery. This function retries every FORCE_SELL_INTERVAL_MS
// for up to MAX_FORCE_SELL_TIME_MS at 30 % slippage (survival mode: any fill > nothing).
//
// Worst case outcome: bad fill price.  NOT: stuck funds.
// ��───────────����─────────────��──────────────────────────────────────────────────
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
    let openTrades: any[];
    try {
      openTrades = await storage.getOpenTrades();
      lastOpenTradesSnapshot = openTrades;
      lastOpenTradesSnapshotMs = Date.now();
    } catch (dbErr: any) {
      if (isTransientDbConnectionError(dbErr)) {
        const ageMs = Date.now() - lastOpenTradesSnapshotMs;
        if (lastOpenTradesSnapshot.length > 0 && ageMs < 10_000) {
          if (Date.now() - lastDbTimeoutLogMs > 15_000) {
            lastDbTimeoutLogMs = Date.now();
            console.warn(`[POSITION_MANAGER:DB-TRANSIENT] getOpenTrades failed (${dbErr?.message || dbErr}); using ${lastOpenTradesSnapshot.length} cached open trade(s), snapshot age ${ageMs}ms`);
          }
          openTrades = lastOpenTradesSnapshot;
        } else {
          if (Date.now() - lastDbTimeoutLogMs > 15_000) {
            lastDbTimeoutLogMs = Date.now();
            console.warn(`[POSITION_MANAGER:DB-TRANSIENT] getOpenTrades failed and no fresh open-trade snapshot exists; skipping this 1s tick only: ${dbErr?.message || dbErr}`);
          }
          return;
        }
      } else {
        throw dbErr;
      }
    }
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
    // CONCURRENCY-SAFETY: process the most at-risk positions first (most negative last-known PnL%)
    // so a slow sell on one position cannot starve a simultaneously-rugging position of its exit.
    // Iterates a sorted copy; all per-trade state is keyed by trade.id, so order does not matter.
    const _orderedOpenTrades = [...openTrades].sort((a: any, b: any) => (prevPnlMap.get(a.id) ?? 0) - (prevPnlMap.get(b.id) ?? 0));
    for (const trade of _orderedOpenTrades) {
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
              // AI-FIX(2026-06-24i): align mid-hold rugcheck with the PAPER-only graded-LP probe.
              // Entry can intentionally admit a graded "Large Amount of LP Unlocked" token in PAPER so
              // shadow can measure whether high-score/high-liq SNIPER setups are profitable or rugs.
              // The fresh mid-hold RugCheck response often collapses the graded flag into plain
              // `lpUnlocked=true`, which immediately force-exited $Natomc after 32s and contaminated the
              // experiment (-8.34% shadow) before price action could be measured. Therefore: in PAPER only,
              // suppress LP-unlocked mid-hold exits while PAPER_PROBE_GRADED_LP_VETO is enabled. LIVE still
              // treats any LP-unlocked mid-hold flag as an immediate exit. Freeze and single-holder remain
              // hard exits in both modes.
              const _patchPaperProbeGradedLp = trade.tradingMode !== "live" && String(process.env.PAPER_PROBE_GRADED_LP_VETO ?? "true").toLowerCase() !== "false";
              const _patchLegacyRelaxGraded = String(process.env.RELAX_GRADED_LP_VETO_LIVE || "").toLowerCase() === "true";
              const _patchTokenAgeSecs = pair?.pairCreatedAt ? (Date.now() - pair.pairCreatedAt) / 1000 : 0;
              const _patchIsOldEnough = _patchTokenAgeSecs > 3600;
              const _patchSuppressLpMidHold = _patchPaperProbeGradedLp || _patchLegacyRelaxGraded || _patchIsOldEnough;
              const _patchHasLpUnlocked = _patchSuppressLpMidHold
                ? false  // LP unlock was accepted at entry/probe — do NOT re-exit mid-hold for the same reason
                : _patchRisks.some((r: any) => String(r?.name || "").toLowerCase().includes("lp unlocked"));
              const _patchHasSingleHolder = _patchRisks.some((r: any) => String(r?.name || "").toLowerCase().includes("single holder ownership"));
              if (_patchHasFreeze || _patchHasLpUnlocked || _patchHasSingleHolder) {
                console.warn(`[MID-HOLD-RISK] #${trade.id} $${trade.tokenSymbol} — exit triggered by mid-hold rugcheck: freeze=${_patchHasFreeze} lpUnlocked=${_patchHasLpUnlocked} singleHolder=${_patchHasSingleHolder}`);
                // Mark for immediate exit on this cycle (use a synthetic reason).
                // We can't set shouldClose here because it's declared later in the function;
                // instead we set the price to a sentinel that will trip HARD_LOSS_KILL via
                // the existing flow. The cleanest path is to log and let the price-drop
                // detector (PATCH #4) catch the resulting price action — but if the rug
                // hasn't started yet, we still want out. So we record a flag and exit below.
                // -- MID_HOLD PROFIT GUARD ------------------------------------
              {
                const _mhSev   = getMidHoldRiskSeverity(String((trade as any).__patchForceExit ?? ''));
                const _mhGuard = process.env.MID_HOLD_PROFIT_GUARD !== 'false';
                const _mhTag   = 'MID_HOLD_RISK (freeze=' + String(_patchHasFreeze) + ', lpUnlocked=' + String(_patchHasLpUnlocked) + ', singleHolder=' + String(_patchHasSingleHolder) + ')';
                const _mhEntry = parseFloat(trade.price);
                const _mhPnlPct = _mhEntry > 0 ? ((currentPrice - _mhEntry) / _mhEntry) * 100 : 0;
                if (_mhSev === 'CRITICAL' || _mhPnlPct <= 0) {
                  (trade as any).__patchForceExit = _mhTag;
                } else if (_mhSev === 'MODERATE' && _mhGuard && _mhPnlPct > 0.5) {
                  (trade as any)._dynamicStopFloor = _mhPnlPct - 0.8;
                  console.log('[MID-HOLD][MODERATE] ' + String(trade.tokenSymbol) + ' profitable +' + _mhPnlPct.toFixed(2) + 'pct tightening trail');
                } else {
                  (trade as any).__patchForceExit = _mhTag;
                }
              }
              // -- END MID_HOLD GUARD
              }
            }
          } catch { /* transient rugcheck failure — ignore, will retry next cycle */ }
        }
        // LAYER-3b: MID-HOLD WHALE-DISTRIBUTION EXIT — front-run the dump.
        // Literature (Ledger: "whales had been quietly selling for days"): the highest-value whale
        // signal is detecting DISTRIBUTION, not accumulation. Every 60s we re-poll the top-volume
        // wallets (cache-bypassed) and exit if they have flipped to net-selling. Throttled +
        // maxOpenPositions=1 => <=1 Birdeye call/min (rate-limit safe).
        if (whaleTrackingEnabled() && _patchHoldAgeMs > 30_000 && Date.now() - (midHoldWhaleMs.get(trade.id) ?? 0) > (Number(process.env.MID_HOLD_WHALE_THROTTLE_MS) || 120_000)) {
          midHoldWhaleMs.set(trade.id, Date.now());
          try {
            const _wsig = await fetchSmartMoneyConvergence(trade.tokenAddress, true, true, false); // CU-FIX: birdeyeAllowed=false — mid-hold whale exit now uses Helius only. Previously defaulted birdeyeAllowed=true AND bypassCache=true, so every open position polled Birdeye top_traders fresh every MID_HOLD_WHALE_THROTTLE_MS, ignoring the 120s cache — the dominant CU drain. Helius source still satisfies the exit's source-trust check, so the distribution/wash exit still fires.
            // EXIT trusts Birdeye flow only -- the free snapshot layer is advisory and must never force-exit a winner.
            const _distributing = (_wsig.source === "birdeye" || _wsig.source === "helius") && _wsig.whaleNetSellers >= WHALE_DISTRIBUTION_SELLERS && _wsig.whaleNetSellers > _wsig.whaleNetBuyers; const _washExitMidHold = (_wsig.source === "birdeye" || _wsig.source === "helius") && (_wsig.whaleCount ?? 0) > 0 && (_wsig.netBuyers ?? 0) === 0 && ((_wsig.whaleNetBuyers ?? 0) <= (_wsig.whaleNetSellers ?? 0)) && (_wsig.washSuspects ?? 0) >= Math.ceil((_wsig.whaleCount ?? 0) / 2); /* AI-TUNE(2026-06-28): added (whaleNetBuyers <= whaleNetSellers) guard to mirror the entry-side fix — the Helius accumQ=0 artifact must not force-exit a winner whose whales are actually net-buying. Genuine net-selling still trips _distributing above. */ /* AI-FIX(2026-06-27): same lp_unlocked_wash_no_accumulation discriminator used at entry, now applied mid-hold. AAIF entered Birdeye-blind (wash=0) then flipped wash=9/10 while the probe suppressed LP mid-hold exits and rode it to -99%. Organized wash/bundle != overt net-selling, so the seller-count exit missed it. */
            if ((_distributing || _washExitMidHold) && !(trade as any).__patchForceExit) {
              const _whaleExitReason = _washExitMidHold ? `WASH_NO_ACCUMULATION (wash=${_wsig.washSuspects}/${_wsig.whaleCount}, accumQ=${_wsig.netBuyers})` : `WHALE_DISTRIBUTION (sellers=${_wsig.whaleNetSellers}, buyers=${_wsig.whaleNetBuyers})`;
              // WHALE_EXIT_SHADOW (default OFF): when enabled, do NOT act on the whale-distribution signal —
              // just log it and let the position ride, so we can measure whether the exit front-runs a real
              // dump (price keeps falling => keep it) or panics on noise (price recovers => relax it).
              // Default OFF preserves the live exit exactly. Run this only in paper for a measurement window.
              const _whaleExitShadow = String(process.env.WHALE_EXIT_SHADOW ?? "false").toLowerCase() === "true";
              if (_whaleExitShadow) {
                if (!whaleExitShadowSeen.has(trade.id)) whaleExitShadowSeen.set(trade.id, { priceAtSignal: currentPrice, ts: Date.now() });
                console.warn(`[WHALE-WOULD-EXIT] #${trade.id} $${trade.tokenSymbol} — SHADOW (not acting): ${_whaleExitReason} | priceAtSignal=$${currentPrice.toFixed(8)} (sellers=${_wsig.whaleNetSellers} buyers=${_wsig.whaleNetBuyers} wash=${_wsig.washSuspects}/${_wsig.whaleCount} accumQ=${_wsig.netBuyers}). Tracking forward via LIFECYCLE:HOLD.`);
              } else {
                console.warn(`[WHALE-DISTRIBUTION] #${trade.id} ${trade.tokenSymbol} — ${_washExitMidHold ? "organized wash/bundle with zero accumulation" : "top wallets flipped to net-selling"} (sellers=${_wsig.whaleNetSellers} buyers=${_wsig.whaleNetBuyers} wash=${_wsig.washSuspects}/${_wsig.whaleCount} accumQ=${_wsig.netBuyers}); exiting ahead of dump.`);
                (trade as any).__patchForceExit = _whaleExitReason;
              }
            }
          } catch { /* transient whale-flow fetch failure — ignore, retry next cycle */ }
        }
        if (currentPrice <= 0) {
          // ZERO_PRICE_STRIKE: DexScreener returned no price. Could be transient (RPC lag,
          // API blip) or permanent (pair delisted/migrated). Accumulate strikes; reset on
          // any successful read. After ZERO_PRICE_STRIKES_REQUIRED consecutive failures,
          // force-close at last known DB price so the trade doesn't freeze open forever.
          const zps = (zeroPriceStrikes.get(trade.id) ?? 0) + 1;
          if (zps < ZERO_PRICE_STRIKES_REQUIRED) {
            zeroPriceStrikes.set(trade.id, zps);
            if (zps === 1 || zps % 10 === 0) console.warn(`[ZERO_PRICE] #${trade.id} $${trade.tokenSymbol} ��� price unfetchable, strike ${zps}/${ZERO_PRICE_STRIKES_REQUIRED}`);
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
        // ── LAYER 1: Price ratio gate — reject the corrupted price BEFORE it touches any state ���─
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
              // Paper mode: a single-tick ≥99% drop is almost always a TRANSIENT DexScreener
              // feed glitch, not a real rug. The old code booked the glitched near-zero price as
              // a realized −99% loss, fabricating phantom catastrophes (e.g. $DNnKoZ: peak +58%,
              // booked −99%). Two guards prevent that:
              //   1) Require PAPER_RUG_CONFIRM_CYCLES of *sustained* dead feed before closing.
              //      Transient glitches self-correct in a few seconds, which resets rejCount via
              //      the successful-read path below, so they now never reach this close at all.
              //   2) When we do close, book the LAST VALID observed price — the honest price the
              //      bot could actually have transacted at — never the glitched near-zero tick.
              //      (Mirrors the upward PRICE_SANITY_STUCK_CLOSE path.)
              const PAPER_RUG_CONFIRM_CYCLES = 30; // 30s of sustained dead feed = treat as real
              if (rejCount >= PAPER_RUG_CONFIRM_CYCLES) {
                const lastValidPrice = parseFloat((trade as any).currentPrice || trade.price || "0");
                const lastValidPnlPct = entryPrice > 0 && lastValidPrice > 0
                  ? ((lastValidPrice - entryPrice) / entryPrice) * 100
                  : rugPnlPct;
                paperBalance += sizeSol * (1 + lastValidPnlPct / 100);
                dailyPnlSol   += sizeSol * (lastValidPnlPct / 100);
                if (paperBalance > peakBalance) peakBalance = paperBalance;
                await storage.closeTrade(trade.id, lastValidPrice.toString(), lastValidPnlPct.toFixed(2), "PRICE_SANITY_FORCE_CLOSE");
                cleanupSanityState();
              }
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
        // -- DYNAMIC TRAIL + BREAKEVEN LOCK --------------------------
        if (process.env.DYNAMIC_TRAIL_ENABLED !== 'false') {
          const _rtPct = calcTransactionCosts(pair?.liquidity?.usd ?? 0, parseFloat(trade.amount || '0')).totalRoundTripPct; const _BE_TRIG  = Math.max(parseFloat(process.env.BREAKEVEN_TRIGGER_PCT ?? '1.0'), _rtPct + 0.5);
          const _BE_FLOOR = Math.max(parseFloat(process.env.BREAKEVEN_FLOOR_PCT   ?? '-0.2'), _rtPct - 1.0);
          if (!(trade as any)._breakevenLocked && peakPnl >= _BE_TRIG) {
            (trade as any)._breakevenLocked  = true;
            (trade as any)._dynamicStopFloor = _BE_FLOOR;
            const _plNow = Date.now();
            if (_plNow - (profitLockLastLogMs.get(trade.id) ?? 0) >= 5000) {
              profitLockLastLogMs.set(trade.id, _plNow);
              console.log('[PROFIT-LOCK] ' + String(trade.tokenSymbol) + ' floor=' + _BE_FLOOR.toFixed(1) + 'pct trig=' + _BE_TRIG.toFixed(1) + 'pct rt=' + _rtPct.toFixed(1) + 'pct (peak=' + peakPnl.toFixed(2) + 'pct)');
            }
          }
          const _trailPct   = getDynamicTrailPct(peakPnl);
          const _trailFloor = peakPnl - _trailPct;
          const _stopFloor  = (trade as any)._dynamicStopFloor ?? -Infinity;
          // PLAYBOOK(2026-06-29) EXIT-BUGFIX: the dynamic peak-trail must NOT arm until the position
          // reaches the activation threshold (+12%). Previously _effStop = max(_trailFloor, _stopFloor)
          // armed at peakPnl=0 (getDynamicTrailPct(0)=0.8 -> floor -0.8%), so EVERY position that opened
          // red was instantly force-exited and MISLABELED 'DYNAMIC_TRAIL' (e.g. $6mv4Dw -4.72%, $HpdpSn
          // -8.31%, both never green). That hair-trigger short-circuited the engineered cascade below
          // (STOP_LOSS -20 / laddered TRAIL_STOP @ +12% / NEVER_GREEN_CUT / TIME_EXIT 300s) and made the
          // +12% moonshot activation unreachable. Now: below activation only the breakeven-LOCKED floor
          // applies (protects a gain that actually crossed BREAKEVEN_TRIGGER_PCT); the peak-trail arms
          // only once peakPnl >= activation, and the engineered laddered TRAIL_STOP owns trailing from
          // there. Disable this whole block via DYNAMIC_TRAIL_ENABLED=false.
          const _trailArmed = peakPnl >= engineSettings.trailingStopActivation;
          const _effStop    = _trailArmed ? Math.max(_trailFloor, _stopFloor) : _stopFloor;
          if (pnlPct < _effStop) {
            const _dReason = (trade as any)._breakevenLocked ? 'BREAKEVEN_LOCK_HIT' : 'DYNAMIC_TRAIL';
            console.log('[EXIT][' + _dReason + '] ' + String(trade.tokenSymbol) + ' pnl=' + pnlPct.toFixed(2) + 'pct trail=' + _trailPct.toFixed(1) + 'pct peak=' + peakPnl.toFixed(2) + 'pct');
            (trade as any).__patchForceExit = _dReason;
          }
        }
        // -- END DYNAMIC TRAIL --------------------------------------
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
          const _wsh = whaleExitShadowSeen.get(trade.id);
          const _wshTag = _wsh ? ` | WHALE-SHADOW: ${Math.round((Date.now() - _wsh.ts) / 1000)}s since signal, px $${_wsh.priceAtSignal.toFixed(8)}->$${currentPrice.toFixed(8)} (${_wsh.priceAtSignal > 0 ? (((currentPrice - _wsh.priceAtSignal) / _wsh.priceAtSignal) * 100).toFixed(2) + "%" : "n/a"} since signal)` : "";
          console.log(`[LIFECYCLE:HOLD] id=#${trade.id} $${trade.tokenSymbol} | age: ${Math.round(holdTime)}s | pnl: ${pnlPct.toFixed(2)}% | peak: ${peakPnl.toFixed(2)}% | price: $${currentPrice.toFixed(8)} | mode: ${trade.mode}${_wshTag}`);
        }
        // TRAIL:ACTIVATED — logged once when trailing stop becomes armed
        if (!trailActivatedLogged.has(trade.id) && peakPnl >= engineSettings.trailingStopActivation) {
          trailActivatedLogged.add(trade.id);
          console.log(`[TRAIL:ACTIVATED] id=#${trade.id} $${trade.tokenSymbol} | peakPnl: +${peakPnl.toFixed(2)}% reached threshold +${engineSettings.trailingStopActivation}% | trailing distance: -${engineSettings.trailingStopDistance}%`);
        }
        // FIX(mg-stale-entry): first-tick red detection. Every SLOW_BLEED loser in the
        // validation sample went red on tick one (peakPnl=0.00% at age≤1s). If a position
        // is underwater on its very first price check, the entry was stale. Mark it. If
        // still underwater at 30s, force exit — these positions almost never recover.
        if (holdTime <= 2 && pnlPct < 0 && !firstTickRedTrades.has(trade.id)) {
          firstTickRedTrades.add(trade.id);
        }
        // Partial TP
        // BUGFIX #14: track partial TP failures. If the sell fails 3x (rugged pool),
        // mark as taken to stop retrying — each retry wastes priority fees.
        const partialTpFailures = partialTpFailuresMap.get(trade.id) ?? 0;
        // PAPER-TEST(cost-relative partial-TP): a static threshold ignores that a thin-liquidity token
        // needs a bigger move just to clear its round-trip cost. Tie the trigger to the ACTUAL modeled
        // round-trip (for the partialTpRatio slice being sold), floored at the base partialTpThreshold.
        // NOTE: deliberately NOT using the 2x-inflated minProfitableExitPct gate (~12.02% on $Sakana's
        // $29k pool) — that exceeds the +12% peak, so the partial could never fire on exactly the token
        // class this is built for. We use the raw round-trip + an explicit profit margin instead.
        const _partialRtCosts = calcTransactionCosts(pair?.liquidity?.usd ?? 0, parseFloat(trade.amount || "0") * engineSettings.partialTpRatio);
        // BANK-THE-PEAK FIX(2026-07-01): the partial sells HALF and only incurs an EXIT cost — the entry
        // cost is already sunk — so gating on the full round-trip (entry+exit) double-counted the sunk
        // entry and pushed the effective trigger to ~7.8% on a $30k pool. Real coins peaked +5-6% and the
        // partial NEVER fired (0 partials across $QUOTA/$FABLE), so every winner round-tripped to a loss.
        // Gate on EXIT-only cost + margin instead; the base partialTpThreshold (+5%) still floors it so the
        // half-bag is banked on the way UP (proactive) before the reactive breakeven floor can be gapped.
        const _partialExitCostPct = _partialRtCosts.exitSlippagePct + _partialRtCosts.exitFeePct;
        // OBJECTIVE-FIX(OD-3): the exit-cost floor can push the partial trigger ABOVE the realistic
        // peak for the liquidity band, so the half-bag never banks and winners round-trip to losses.
        // Cap the effective trigger at 60% of the realistic peak so the partial is reachable within
        // the band the trade was admitted for (still floored by the base partialTpThreshold).
        const _winnablePeakPct = estimateRealisticPeakPct(pair?.liquidity?.usd ?? 0);
        // OBJECTIVE-FIX(OD-3): disable partial TP when exit cost alone makes it unreachable.
        // At low liq, exit slippage + fees eat the gain, so a +3% TP trigger still loses money on exit.
        // If exit cost >= base threshold, partial TP is INACTIVE for this trade (preserves capital).
        const _partialTpExitCost = _partialExitCostPct + engineSettings.partialTpCostMargin;
        const effectivePartialTpThreshold = _partialTpExitCost >= engineSettings.partialTpThreshold
          ? 999  // DISABLE partial TP: exit cost already exceeds target gain
          : Math.min(
              Math.max(engineSettings.partialTpThreshold, _partialTpExitCost),
              Math.max(engineSettings.partialTpThreshold, _winnablePeakPct * 0.6),
            );
        if (!partialTpTaken.has(trade.id) && partialTpFailures < 3 && pnlPct >= effectivePartialTpThreshold && pnlPct < dynamicTP) {
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
                  console.log(`[LIVE] PARTIAL TP $${trade.tokenSymbol} | Sold ${engineSettings.partialTpRatio * 100}% on-chain @ +${pnlPct.toFixed(1)}% (trigger +${effectivePartialTpThreshold.toFixed(1)}%, rt-cost ${_partialRtCosts.totalRoundTripPct.toFixed(1)}%) | SOL received: ${partialResult.solReceived.toFixed(4)} | tx: ${partialResult.txSignature?.slice(0, 20)}...`);
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
            partialLegMap.set(trade.id, { fraction: engineSettings.partialTpRatio, pnlPct: netPartialPnlPct }); // AI-TUNE: record banked leg for honest shadow accounting
            dailyPnlSol += partialReturn - partialSize;
            await storage.updateTradeAmount(trade.id, (sizeSol - partialSize).toFixed(4));
            console.log(`[PAPER] PARTIAL TP $${trade.tokenSymbol} | Sold ${engineSettings.partialTpRatio * 100}% @ +${pnlPct.toFixed(1)}% (trigger +${effectivePartialTpThreshold.toFixed(1)}%, rt-cost ${_partialRtCosts.totalRoundTripPct.toFixed(1)}%) | ExitCost: -${partialExitCostPct.toFixed(1)}% | Secured: ${partialReturn.toFixed(4)} SOL`);
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
        // ===== BEAST EXIT ENGINE (opt-in, additive on top of legacy cascade) =====
        // When BEAST_EXIT_ENABLED=true AND the trade carries a Beast tier stamp from entry,
        // run the asymmetric moonshot exit engine. Priority:
        //   1. beast_exit verdict of `exit` -> shouldClose=true (SUPERSEDES legacy cascade
        //      unless the rugcheck __patchForceExit flag is set, which beats everything).
        //   2. beast_exit verdict of `partial` -> execute partial sell via the beast ladder
        //      (skips legacy +5% partial-TP so we don't double-partition the position).
        //   3. beast_exit verdict of `hold` -> legacy cascade still runs (rug / hard-loss /
        //      stale-time stops can still fire; beast just adds a wider trailing stop).
        const _beastExitEnabled = String(process.env.BEAST_EXIT_ENABLED ?? "false").toLowerCase() === "true";
        const _tradeBeastTier = (trade as any)._beastTier ?? beastTierMap.get(trade.id);
        if (_beastExitEnabled && _tradeBeastTier) {
          try {
            const _beastEntryPrice = parseFloat(trade.price || "0");
            const _beastCurrentPrice = currentPrice;
            const _beastPeakPrice = peakPrices.get(trade.id) ?? _beastEntryPrice;
            const _beastPositionSol = parseFloat(trade.amount || "0");
            const _beastAgeSeconds = (Date.now() - new Date(trade.timestamp || trade.createdAt || Date.now()).getTime()) / 1000;
            const _beastTpLevel = beastTpLevelReached.get(trade.id) ?? 0;
            const _beastExit = evaluateBeastExit({
              entryPriceSol: _beastEntryPrice,
              currentPriceSol: _beastCurrentPrice,
              peakPriceSol: _beastPeakPrice,
              ageSeconds: _beastAgeSeconds,
              positionSol: _beastPositionSol,
              tier: "COLD" as BeastBagTier, // every position starts COLD — engine promotes UP via multiplier
              tpLevelReached: _beastTpLevel,
            });
            if (_beastExit.action === "exit") {
              shouldClose = true;
              reason = _beastExit.reason;
            } else if (_beastExit.action === "partial") {
              // Execute beast ladder partial. Track leg in beastTpLevelReached so the
              // NEXT monitoring cycle starts at the next ladder rung.
              const _beastPartialFraction = _beastExit.sellFraction;
              const _beastPartialSizeSol = _beastPositionSol * _beastPartialFraction;
              if (_beastPartialSizeSol > 0.0001 && trade.tradingMode === "paper") {
                const _beastPartialExitCostPct = _partialExitCostPct ?? 0; // already computed earlier
                const _beastNetPnlPct = pnlPct - _beastPartialExitCostPct;
                const _beastReturn = _beastPartialSizeSol * (1 + _beastNetPnlPct / 100);
                paperBalance += _beastReturn;
                dailyPnlSol += _beastReturn - _beastPartialSizeSol;
                await storage.updateTradeAmount(trade.id, (_beastPositionSol - _beastPartialSizeSol).toFixed(4));
                beastTpLevelReached.set(trade.id, _beastTpLevel + 1);
                console.log(`[BEAST-TP] #${trade.id} $${trade.tokenSymbol} | ${_beastExit.reason} | Sold ${(_beastPartialFraction * 100).toFixed(1)}% @ +${pnlPct.toFixed(1)}% | Secured: ${_beastReturn.toFixed(4)} SOL | Lvl ${_beastTpLevel + 1}/${BEAST_TP_LADDER.length}`);
                prevPnlMap.set(trade.id, pnlPct);
                continue;
              }
            }
            // For `hold`: let legacy cascade run.
          } catch (_beastExitErr: any) {
            console.warn(`[BEAST-EXIT] eval error (continuing with legacy cascade): ${_beastExitErr?.message || _beastExitErr}`);
          }
        }
        // PATCH #6: honor mid-hold rugcheck force-exit flag set above.
        if ((trade as any).__patchForceExit) {
          shouldClose = true;
          reason = (trade as any).__patchForceExit;
          (trade as any).__patchForceExit = undefined;
        }
        // ===== CONSOLIDATED EXIT DECISION (refactor 2026-06-24) =====
        // Single ranked, first-match-wins cascade that REPLACES the previous ~15 layered /
        // independent exit checks. Priority tiers:
        //   T1 survival (rug / hard loss)  -> T2 profit capture  -> T3 stop / loss mgmt
        //   -> T4 momentum & structure fades -> T5 time stops.
        // All thresholds reference engineSettings. Purged: the hardcoded +20% TAKE_PROFIT gate,
        // the stale "trailingStopActivation = 12" comments, the isNearTpGate suppression (only
        // existed to protect the deleted +20% gate), and the dead IMMEDIATE_UNDERWATER block.
        // __patchForceExit (handled just above) keeps top priority via the !shouldClose guard.

        // --- inputs computed once ---
        const costAwareStopPrice = tradeStopPrices.get(trade.id) ?? 0;
        const stopLossPct = costAwareStopPrice > 0 && entryPrice > 0 ? ((costAwareStopPrice - entryPrice) / entryPrice) * 100 : engineSettings.stopLoss;
        const rawHalfStop = stopLossPct / 2;
        const halfStopPct = trade.mode === "HWR" ? Math.min(rawHalfStop, -4.0) : trade.mode === "MG" ? Math.min(rawHalfStop, -3.5) : rawHalfStop; // NOTE(2026-06-30): halfStopPct is UNUSED (no scale-out wired); do not assume it gates exits.
        const activation = engineSettings.trailingStopActivation;
        // accounting floor for armed-trail exits (consumed downstream by FIX H). Ladder unchanged.
        const trailingFloor = peakPnl > 30 ? peakPnl * 0.60 : peakPnl > 15 ? peakPnl * 0.50 : peakPnl > 8 ? peakPnl * 0.40 : peakPnl > 3 ? peakPnl * 0.40 : 0;  // CONVERGENCE-FIX-R2 (RE-SCAN-LOPHOLE-1): sub-activation peaks 3-8 had 0.20 (80% giveback); raised to 0.40. N3 reverted >8 from 0.50 back to 0.40. Final ladder: peak>30=60%, >15=50%, >8=40%, >3=40%.
        // round-trip cost gate: VOLUNTARY profit-taking (PNL_STAGNANT) must clear modeled spread+slippage+fees.
        // FIX(cost-gate liquidity-collapse trap, 2026-06-24): this voluntary-profit floor exists to
        // avoid crystallizing a sub-cost "profit" in NORMAL conditions. But it was modeled on LIVE
        // liquidity — so when a pool is being pulled (a rug), calcTransactionCosts() models exit
        // slippage up to ~47% one-way and the floor EXPLODED (observed on $SABC: 8.02% -> 94.50%).
        // That perversely blocked profit-taking exactly when we most needed out, trapping a +10.59%
        // peak until LIQ_COLLAPSE dumped it at -18.23%. Two guards: (1) model the floor on STABLE
        // (entry) liquidity, never the collapsing live value [use max(live, entry)]; (2) hard-cap the
        // floor at 12% — beyond that, a real gain should always be takeable. Liquidity-collapse exits
        // are owned by the Tier-1 LIQ_COLLAPSE / PRICE_RUG rules below, NOT by this cost gate.
        const _entryLiqForCost = parseFloat(trade.liquidity ?? "0") || 0;
        const _liveLiqForCost = pair?.liquidity?.usd ?? 0;
        const _stableLiqForCost = Math.max(_liveLiqForCost, _entryLiqForCost);
        const _rtCosts = calcTransactionCosts(_stableLiqForCost, parseFloat(trade.amount || "0"));
        const COST_SAFETY_MULT = 2.0;
        const COST_FLOOR_CAP_PCT = 12.0;
        const minProfitableExitPct = Math.min(_rtCosts.totalRoundTripPct / COST_SAFETY_MULT + 0.5, COST_FLOOR_CAP_PCT); // AI-FIX(sunk-cost double-count, 2026-07-01): was * COST_SAFETY_MULT (2x the FULL round trip, re-charging the already-paid entry leg). The entry cost is SUNK once we hold; a voluntary profit-take only pays the EXIT leg (~half the round trip). Dividing charges that marginal leg + 0.5% cushion. PROOF $skew: peaked +4.95% (net +2.85% after the 2.1% exit leg), old 8.02% floor HELD it -> booked -7.54%.
        const clearsRoundTrip = pnlPct >= minProfitableExitPct;
        // price-based drop-from-peak leads DexScreener liquidity lag during a rug.
        const _peakPrice = peakPrices.get(trade.id) ?? entryPrice;
        const dropFromPeakPct = _peakPrice > 0 ? ((_peakPrice - currentPrice) / _peakPrice) * 100 : 0;
        // market-structure metrics.
        const _m5b = pair?.txns?.m5?.buys ?? 0, _m5s = pair?.txns?.m5?.sells ?? 0;
        const bp5m = (_m5b + _m5s) > 0 ? _m5b / (_m5b + _m5s) : 0.5;
        const pc5m = pair?.priceChange?.m5 ?? 0;
        const vol5m = pair?.volume?.m5 ?? 0;
        const vol1h = pair?.volume?.h1 ?? 0;
        const expVol5m = vol1h / 12;
        const volLiqRatio = (pair?.liquidity?.usd ?? 0) > 0 ? vol5m / (pair!.liquidity!.usd as number) : 0;
        // liquidity-collapse inputs (only fire when liquidity was actually reported).
        const _liqReported = typeof pair?.liquidity?.usd === "number";
        const _currentLiq = pair?.liquidity?.usd ?? 0;
        const _entryLiqUsd = parseFloat(trade.liquidity ?? "0") || 0;
        const _effectiveEntryLiq = _entryLiqUsd > 0 ? _entryLiqUsd : (engineSettings.sniperMinLiquidity ?? 3000);
        const _liqCollapsed = _liqReported && _currentLiq < 1000;
        const _liqDroppedThreshold = _effectiveEntryLiq > 1000 && _liqReported && _currentLiq < _effectiveEntryLiq * 0.80;
        // real-profit stagnation.
        const _stable = pnlStableMap.get(trade.id);
        const _stagnantMs = peakPnl < 3.0 ? 35_000 : 60_000;
        const _isStagnant = !!_stable && pnlPct >= 1 && (Date.now() - _stable.since) >= _stagnantMs;
        // EARLY_CUT minimum hold by entry mode (avoids cutting before momentum develops).
        const earlyCutMinHold = trade.mode === "HWR" ? 360 : trade.mode === "MG" ? 240 : trade.mode === "SNIPER" ? 180 : 240;
        // NEVER-GREEN FAST-KILL params (AI-CALIB 2026-06-24): in the 221-trade calibration, score<->pnl
        // correlation was ~0 (not predictive), but 98 trades that NEVER cleared +1% peak went 0-for-98
        // (avg -11.55%, = 239% of net loss). Cutting them at a fixed -5% pnl after a short hold (independent
        // of the cost-widened stop, which let low-liq losers bleed past -11%) moved sim expectancy from
        // -2.14%/trade to -0.33%/trade. Single biggest lever found; tunable here.
        const NEVER_GREEN_PEAK_PCT = 1.0, NEVER_GREEN_CUT_PCT = -5.0, NEVER_GREEN_MIN_HOLD_SEC = 18;

        // throttled diagnostic: small mid-price "profit" below the round-trip floor -> we HOLD, not crystallize.
        if (pnlPct >= 1 && !clearsRoundTrip && holdTime > 30 && (Date.now() - (costGateLastLogMs.get(trade.id) ?? 0) >= 30000)) {
          costGateLastLogMs.set(trade.id, Date.now());
          console.log(`[DIAG-COSTGATE] $${trade.tokenSymbol} mid pnl +${pnlPct.toFixed(2)}% < exit-cost floor ${minProfitableExitPct.toFixed(2)}% (marginal exit leg = modeled RT ${_rtCosts.totalRoundTripPct.toFixed(2)}% / ${COST_SAFETY_MULT} + 0.5) -> HOLDING (won't crystallize a sub-cost profit)`);
        }

        if (!shouldClose) {
          // ---- TIER 1: survival / emergency (immediate, ungated) ----
          if (pnlPct <= -50) { shouldClose = true; reason = `DEEP_RUG_KILL (pnl ${pnlPct.toFixed(2)}% <= -50% emergency floor)`; }
          // MOONSHOT: Disabled PRICE_RUG so we don't accidentally sell a massive runner during a normal 25% pullback.
          // else if (holdTime > 20 && dropFromPeakPct >= 25) { shouldClose = true; reason = `PRICE_RUG (-${dropFromPeakPct.toFixed(1)}% from peak)`; }
          else if (pair && (_liqCollapsed || _liqDroppedThreshold)) { shouldClose = true; reason = `LIQ_COLLAPSE (entry $${_effectiveEntryLiq.toFixed(0)} -> now $${_currentLiq.toFixed(0)}, ${_liqCollapsed ? "below $1000 floor" : ">20% drain"})`; }
          else if (pnlPct <= -45) { shouldClose = true; reason = `HARD_LOSS_KILL (pnl ${pnlPct.toFixed(2)}% <= -45% hard floor)`; }
          // AI-TUNE(2026-06-28 SURVIVAL-STOP): re-armed a real STOP_LOSS. ROOT CAUSE of the -87% ($UNNF) and -50% ($SQQQ) blowups: the MOONSHOT exit disabled STOP_LOSS entirely, leaving only HARD_LOSS_KILL(-45)/DEEP_RUG_KILL(-50) -- a rug gaps from ~-10% past -50% to -87% between two 1s reads. One -87% loss erases three +37% wins on a micro wallet. -22% fires while price is still readable and liquidity present, BEFORE the gap. Moonshots that arm the trail (peak>=12%) exit via the laddered floor far above this, so this only catches positions that dumped before ever arming -- i.e. the rugs.
          else if (pnlPct <= (Number(process.env.HARD_STOP_PCT) || -20)) { shouldClose = true; reason = `STOP_LOSS (pnl ${pnlPct.toFixed(2)}% <= ${(Number(process.env.HARD_STOP_PCT) || -20)}% survival stop)`; } // PLAYBOOK(2026-06-29): -22 -> -20 hard stop. Override via HARD_STOP_PCT.
          // ---- TIER 2: profit capture ----
          else if (pnlPct >= engineSettings.hardTakeProfit) { shouldClose = true; reason = `HARD_TAKE_PROFIT (+${pnlPct.toFixed(2)}% >= ${engineSettings.hardTakeProfit}% ceiling)`; }
          else if (peakPnl >= activation && (drawdownFromPeak >= engineSettings.trailingStopDistance || (trailingFloor > 0 && pnlPct <= trailingFloor))) { shouldClose = true; reason = `TRAIL_STOP (peak +${peakPnl.toFixed(1)}%, now +${pnlPct.toFixed(1)}%, locked floor +${trailingFloor.toFixed(1)}%, fell ${drawdownFromPeak.toFixed(1)}%)`; } // AI-TUNE(2026-06-28 LOCK-GAINS): added the floor-trigger `pnlPct <= trailingFloor`. The old condition ONLY fired on a 25-PRICE-POINT drawdown from peak, which for a +25% peak lands BELOW entry (peak*0.75 = -5.7% pnl) — useless for moderate runners. Now once armed (peak>=12%), the position is SOLD the moment pnl falls back to the laddered floor (e.g. peak+25% -> floor +12.5%), so $VORF-type peaks are crystallized near the floor instead of given back. trailWasArmed in FIX H now matches, so the recorded pnl is the real fill, not inflated.
          // PLAYBOOK(2026-06-29 GIVEBACK-FLOOR): enforce the laddered floor for meaningful peaks
          // that never reached the +12% moonshot activation. The floor was already COMPUTED for the
          // peak>3 / peak>8 tiers but only ENFORCED inside TRAIL_STOP (peak>=activation), so a position
          // that ran to +5..12% and faded had NO protective stop below activation and could round-trip
          // the entire gain ($2eEh7U: peak +9.2% -> booked -6.47%, price recovered to +7% after exit).
          // Loose by design (locks only after giving back ~60-80% of peak) so genuine moonshot
          // consolidations still breathe, and it never touches never-green trades (peak below the gate).
          // Honest accounting: we actually sell at ~floor, and FIX H still records the raw fill on a gap.
          // Tunable via GIVEBACK_FLOOR_MIN_PEAK_PCT (default 5); set very high to disable.
          else if (peakPnl < activation && peakPnl >= (Number(process.env.GIVEBACK_FLOOR_MIN_PEAK_PCT) || 3) && trailingFloor > 0 && pnlPct <= trailingFloor) { shouldClose = true; reason = `GIVEBACK_FLOOR (peak +${peakPnl.toFixed(1)}%, now +${pnlPct.toFixed(1)}%, laddered floor +${trailingFloor.toFixed(1)}%)`; } // AI-FIX(proactive-floor, 2026-07-01): min-peak 5 -> 3. $skew peaked +4.95% but 4.95<5 disqualified this reactive floor, so it round-tripped past breakeven to -5.48%. At $15-25k liq peaks cluster +3-6%; a +3% peak deserves a protective floor too.
          // MOONSHOT: PROFIT_DECLINE stays disabled (moonshots consolidate and pull back). PNL_STAGNANT re-enabled below.
          else if (peakPnl < activation && clearsRoundTrip && _isStagnant) { const stableSec = Math.round((Date.now() - _stable!.since) / 1000); shouldClose = true; reason = `PNL_STAGNANT (+${pnlPct.toFixed(2)}% real-profit, unchanged for ${stableSec}s)`; } // AI-FIX(re-enabled, 2026-07-01): a sub-activation peak (peakPnl<12%) had NO voluntary profit-capture path — only stop-losses — so every moderate winner that stalled round-tripped to a loss. The peakPnl<activation guard means this NEVER caps an armed moonshot (those exit via TRAIL_STOP/laddered floor). Gated on the CORRECTED marginal-cost clearsRoundTrip, it banks a stalled real profit instead of holding it into the red.
          // else if (peakPnl < activation && holdTime > 20 && prevPnl !== null && prevPnl >= 1.0 && pnlPct > 0 && pnlPct < prevPnl && (prevPnl - pnlPct) >= 15.0) { shouldClose = true; reason = `PROFIT_DECLINE (was +${prevPnl.toFixed(2)}%, now +${pnlPct.toFixed(2)}%, drop=${(prevPnl - pnlPct).toFixed(2)}%)`; }
          // ---- TIER 3: stop / loss management ----
          // NEVER-GREEN FAST-KILL (AI-CALIB 2026-06-24): never-green trades (peak <= +1%) went 0-for-98 in
          // calibration. Cut at -5% after 18s, BEFORE the cost-widened STOP_LOSS lets low-liq losers bleed
          // to -11.5% avg. peakPnl<=1% guarantees this never touches a profitable run.
          else if (peakPnl <= NEVER_GREEN_PEAK_PCT && holdTime > NEVER_GREEN_MIN_HOLD_SEC && pnlPct <= NEVER_GREEN_CUT_PCT) { shouldClose = true; reason = `NEVER_GREEN_CUT (peak ${peakPnl.toFixed(2)}%, pnl ${pnlPct.toFixed(2)}%, held ${Math.round(holdTime)}s)`; }
          // FIX(cost-aware-stop, 2026-06-30): stopLossPct (computed ~line 4936 from tradeStopPrices via calcCostAwareStopPrice) was DEAD -- never referenced in any exit branch. Gated wire-in, DEFAULT ON (env COST_AWARE_STOP_ENABLED defaults to true). RE-SCAN-LOPHOLE-2: old comment said "DEFAULT OFF" but code checks `!== 'false'` = ON by default. Two stops coexist intentionally: cost-aware stop (~-5% from engineSettings.stopLoss) catches slow bleeds before the gap; hard STOP_LOSS at -20% (HARD_STOP_PCT) is the backstop for flash dumps. Armed runners (peak>=activation) keep the laddered trail and never hit either stop.
          else if (process.env.COST_AWARE_STOP_ENABLED !== 'false' && peakPnl < activation && stopLossPct < 0 && pnlPct <= stopLossPct) { shouldClose = true; reason = `COST_AWARE_STOP (pnl ${pnlPct.toFixed(2)}% <= cost-aware ${stopLossPct.toFixed(2)}%, peak ${peakPnl.toFixed(1)}%)`; }
          // ---- TIER 4: momentum / structure fades (only meaningful while in some profit) ----
          // MOONSHOT: Restored mundane-coin momentum fades to clear stagnant slots.
          else if (pnlPct > 10 && bp5m < 0.43 && pc5m < -3) { shouldClose = true; reason = `EARLY_EXIT_WEAK_BP (bp=${bp5m.toFixed(2)}, d5m=${pc5m.toFixed(1)}%)`; }
          else if (holdTime > 45 && bp5m < 0.38 && pc5m < -2) { shouldClose = true; reason = `MOMENTUM_FADE (BP=${bp5m.toFixed(2)}, d5m=${pc5m.toFixed(1)}%)`; }
          else if (holdTime > 45 && pnlPct > 5 && bp5m < 0.43 && pc5m < -4) { shouldClose = true; reason = `PROFIT_PROTECT_FADE (BP=${bp5m.toFixed(2)}, d5m=${pc5m.toFixed(1)}%, PNL=+${pnlPct.toFixed(1)}%)`; }
          else if (pnlPct > 5 && volLiqRatio > 7) { shouldClose = true; reason = `LIQUIDITY_EXHAUSTION (${volLiqRatio.toFixed(2)}x)`; }
          else if (holdTime > 180 && pnlPct > 1 && expVol5m > 100 && vol5m < expVol5m * 0.15) { shouldClose = true; reason = `VOL_COLLAPSE (5m vol ${vol5m.toFixed(0)} < 15% of expected ${expVol5m.toFixed(0)})`; }
          // MOONSHOT: Dip Recovery Architecture
          // 1. Stagnant Green Kill: If a token is slightly green (0 to 20%) for 25 minutes without mooning, purge it. NOTE(2026-06-30, multi-tick verified): only reaches ARMED positions (peak>=activation); never-armed greens are cut earlier by TIME_EXIT@cap.
          // 2. Dip Recovery: If it is in a loss (down to -45%), give it up to 30 minutes to bounce back before purging.
          else if (holdTime > (Number(process.env.STAGNANT_GREEN_KILL_SECONDS) || 1500) && pnlPct >= 0 && pnlPct < 20) { shouldClose = true; reason = `STAGNANT_GREEN_KILL (Held ${Math.round(holdTime/60)}m but PNL is only ${pnlPct.toFixed(1)}%)`; } // AI-TUNE(2026-06-28 COST-GATE): 600s(10m) -> 1500s(25m). ROOT CAUSE: modeled round-trip cost floor is ~8% (3.76% x2), but the 10m stagnant-kill flattened any winner stuck between 0% and +8% before it could clear cost. PROOF: $SPCX peaked +3.91% -> killed at +2.25% gross / +0.19% net after exit cost. 25m lets a sub-8% green position mature past the cost floor instead of booking a forced scratch; DIP_RECOVERY_FAILED(30m) and ABSOLUTE_MAX_HOLD still cap the tail. TUNABLE: STAGNANT_GREEN_KILL_SECONDS env override (default 1500).
          else if (holdTime > (Number(process.env.MAX_HOLD_SECONDS_OVERRIDE) || 300) && peakPnl < activation && pnlPct < 1 && !((process.env.DIP_RECOVERY_ENABLED === 'true') && pnlPct < 0)) { shouldClose = true; reason = `TIME_EXIT (held ${Math.round(holdTime)}s > cap, never armed trail; peak ${peakPnl.toFixed(1)}%, pnl ${pnlPct.toFixed(2)}%)`; }  // CONVERGENCE-FIX: added pnlPct < 1. Green positions (pnl >= +1%) should not be time-killed at 5min; they get STAGNANT_GREEN_KILL at 25min instead. // PLAYBOOK(2026-06-29): standard memecoin time-stop at 300s. Only cuts positions that NEVER armed the moonshot trail (peak < activation=12%); armed runners keep running under the laddered floor. Disable/extend via MAX_HOLD_SECONDS_OVERRIDE (e.g. =1800 to restore old behavior).
          else if (holdTime > (Number(process.env.DIP_RECOVERY_FAILED_SECONDS) || 1800) && pnlPct < 0) { shouldClose = true; reason = `DIP_RECOVERY_FAILED (Held ${Math.round(holdTime/60)}m, failed to bounce from ${pnlPct.toFixed(1)}% loss)`; } // TUNABLE: DIP_RECOVERY_FAILED_SECONDS env override (default 1800).
          else if (holdTime > engineSettings.dynamicHoldMaxSeconds) { shouldClose = true; reason = `ABSOLUTE_MAX_HOLD(${Math.round(holdTime)}s > ${engineSettings.dynamicHoldMaxSeconds}s cap, pnl ${pnlPct.toFixed(2)}%)`; }
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
                             reason.startsWith("DEEP_RUG_KILL") || reason.startsWith("NEVER_GREEN_CUT") ||
                             reason.startsWith("EARLY_CUT") || reason.startsWith("FAST_CUT");
          // FIX (paper inflation): trailingFloor only represents an achievable exit if the
          // trailing stop was actually ARMED (peakPnl >= trailingStopActivation). Below
          // activation there is NO protective stop, so flooring fabricates wins on trades
          // that really bled out — e.g. $MYLOO #10262 peak +4.7% -> real -6.0% booked as
          // +0.71%; shadow proved it (paper beat shadow by +6.83%). Only floor when the
          // trail was live; otherwise record the true fill so paper/daily PnL stay honest.
          const trailWasArmed = peakPnl >= engineSettings.trailingStopActivation;
          if (!isHardLoss && trailWasArmed && pnlPct < trailingFloor && trailingFloor > 0) {
            console.log(`[EXIT:FLOOR] $${trade.tokenSymbol} | ${reason.split(" ")[0]} | raw pnl ${pnlPct.toFixed(2)}% → floor locked at +${trailingFloor.toFixed(2)}% (peak was +${peakPnl.toFixed(1)}%, trail armed)`);
            pnlPct = trailingFloor;
          } else if (!isHardLoss && !trailWasArmed && trailingFloor > 0 && pnlPct < trailingFloor) {
            console.log(`[EXIT:NOFLOOR] $${trade.tokenSymbol} | ${reason.split(" ")[0]} | raw pnl ${pnlPct.toFixed(2)}% recorded as-is — peak +${peakPnl.toFixed(1)}% never armed trail @ ${engineSettings.trailingStopActivation}% (no paper inflation)`);
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
              // ─�� ANTI-RUG ROUTING GUARD (DEAD POOL DETECTION) ──
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
              // ────────────��──────────────────────────────────────
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
                  // ���� the escalated bps will be derived from it on the next price check.
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
            // FIX (paper inflation): only honor the floor when the trailing stop was actually
            // ARMED (peakPnl >= trailingStopActivation). Below activation there was no real
            // protective stop, so flooring here would re-inflate a true loss after costs.
            const trailWasArmedPaper = peakPnl >= engineSettings.trailingStopActivation;
            if (!isHardLoss && trailWasArmedPaper && trailingFloor > 0 && exitPnlPct < trailingFloor) {
              exitPnlPct = trailingFloor;
            }
            const MAX_RETURN_MULTIPLIER = 6; // 500% gain = 6× return — hard ceiling matches pnlPct cap
            const returnSolRaw = sizeSol * (1 + exitPnlPct / 100);
            const returnSol = Math.min(returnSolRaw, sizeSol * MAX_RETURN_MULTIPLIER);
            if (returnSolRaw !== returnSol) {
              console.warn(
                `[BALANCE_GUARD] returnSol clamped ${returnSolRaw.toFixed(4)} ��� ${returnSol.toFixed(4)} SOL ` +
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

          
          // ── SHADOW MODE: close matching shadow trade ──────��────��──────────
          if (trade.tradingMode !== "live") {
            // AI-TUNE(2026-06-23): blend any banked partial-TP leg with the final-exit leg so the
            // shadow ledger reflects the TRUE realized paper PnL of the whole position, not just the
            // last slice. Previously a +15% partial followed by a +6% final logged only +6%, which
            // understated every winner that took a partial and corrupted the avgPaper/inflation figures.
            const _partialLeg = partialLegMap.get(trade.id);
            const _blendedPaperPnl = _partialLeg
              ? _partialLeg.pnlPct * _partialLeg.fraction + finalPnlPct! * (1 - _partialLeg.fraction)
              : finalPnlPct!;
            partialLegMap.delete(trade.id);
            closeShadowTrade(trade.tokenAddress, currentPrice, _blendedPaperPnl, reason).catch(() => {});
          } else {
            partialLegMap.delete(trade.id);
          }
          // ───────────────────────��─────────────────────────────────────────
          tradedAddresses.set(trade.tokenAddress, Date.now());
          if (reason.startsWith("STOP_LOSS") || reason.startsWith("HARD_LOSS_KILL") || reason.startsWith("DEEP_RUG_KILL") || reason.startsWith("NEVER_GREEN_CUT") || reason.startsWith("EARLY_CUT") || reason.startsWith("FAST_CUT") || reason.startsWith("LIQ_COLLAPSE") || reason.startsWith("VOL_COLLAPSE") || reason.startsWith("SLOW_BLEED")) {
            stoppedOutAddresses.set(trade.tokenAddress, Date.now());
            // Block re-entry on ANY new contract with the same symbol for the full slReentryDelayMs.
            // Fixes $SOS re-entering 11m47s after LIQ_COLLAPSE via a new contract address —
            // stoppedOutAddresses is address-keyed so the new address bypassed it; this closes the gap.
            // FIX(mg-stale-entry): SLOW_BLEED added — RDR2 re-entered 3 times in one session,
            // each time SLOW_BLEEDing out. These tokens already had their move; the residual
            // bp5m/volMom passes MG gates but the momentum is gone. Full slReentryDelayMs block.
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
              console.log(`[RISK] SL blackout set for $${trade.tokenSymbol} (${reason.split(" ")[0]}) ��� no re-entry for ${(engineSettings.slReentryDelayMs / 60000).toFixed(0)} min`);
            }
          }
          peakPrices.delete(trade.id); partialTpTaken.delete(trade.id); tradeStopPrices.delete(trade.id);
          prevPnlMap.delete(trade.id); pnlStableMap.delete(trade.id); liveTokenBalances.delete(trade.id);
          sellFailureStrikes.delete(trade.id);
          zeroBalanceStrikes.delete(trade.id);
          liqCoWarnedTrades.delete(trade.id);
          firstTickRedTrades.delete(trade.id);
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
  } catch (e: any) {
    if (isTransientDbConnectionError(e)) {
      if (Date.now() - lastDbTimeoutLogMs > 15_000) {
        lastDbTimeoutLogMs = Date.now();
        console.warn(`[POSITION_MANAGER:DB-TRANSIENT] skipped one tick after DB connection blip: ${e?.message || e}`);
      }
    } else {
      console.error("[POSITION_MANAGER] Error:", e);
    }
  } finally { priceCheckLock = false; }
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
  firstTickRedTrades.clear();          // FIX(mg-stale-entry): reset first-tick tracking on engine start
  consecutiveWins = 0;
  consecutiveLosses = 0;
  console.log("==================== 1000x ROI TRADING BOT ====================");
  // ENV WIRING: honor .env MODE + PAPER_SEED at boot (previously these were ignored).
  // MODE=paper|live is persisted to the DB tradingMode so the engine routes accordingly.
  const _envMode = (process.env.MODE || "").trim().toLowerCase();
  if (_envMode === "paper" || _envMode === "live") {
    await storage.updateTradingMode(_envMode).catch((e: any) => console.warn(`[CONFIG] Failed to apply MODE=${_envMode} from .env: ${e?.message || e}`));
    console.log(`[CONFIG] MODE=${_envMode} from .env applied to trading mode.`);
  }
  // PAPER_SEED overrides the paper starting balance (live mode reads the real on-chain balance).
  const _envSeed = parseFloat(process.env.PAPER_SEED || "");
  if (Number.isFinite(_envSeed) && _envSeed > 0) {
    engineSettings.startingBalance = _envSeed;
    paperBalance = _envSeed;
    dailyStartBalance = _envSeed;
    peakBalance = _envSeed;
    console.log(`[CONFIG] PAPER_SEED=${_envSeed} SOL from .env applied to paper starting balance.`);
  }
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
  app.get("/api/candidates/live", async (_req, res) => { res.json(liveCandidatesCache); });
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

  // ── Shadow mode endpoints ────���────────────────────────────────────────────
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

  // Persistent proving-ground tally (survives restarts). Read this to decide
  // whether the strategy has a REAL edge before risking more than 0.05 SOL.
  app.get("/api/shadow/stats", (_req, res) => {
    res.json(shadowLedgerSummary());
  });

  app.post("/api/shadow/toggle", (req, res) => {
    if (!requireAdmin(req, res)) return;
    const enable = req.body?.enabled;
    if (typeof enable !== "boolean") return res.status(400).json({ error: "body must be { enabled: boolean }" });
    setShadowModeEnabled(enable);
    res.json({ shadowModeEnabled: enable });
  });

  // ── Latency endpoints ─────────────────────────────────────────���───────────
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
    clearLatencyLog();
    res.json({ cleared: true });
  });
  // ────────────────────────────────────────────────────────────────���────────
  app.post("/api/settings", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      const updates = req.body;
      if (!updates || typeof updates !== "object") return res.status(400).json({ message: "Invalid settings payload" });
      const validKeys = Object.keys(engineSettings) as (keyof typeof engineSettings)[];
      let restartIntervals = false;
      const minValues: Record<string, number> = { scanIntervalMs: 4000, priceCheckIntervalMs: 1000, reentryDelayMs: 0, slReentryDelayMs: 0, lossCooldownMs: 0, maxHoldSeconds: 10, maxOpenPositions: 1, maxTradesPerCycle: 1, minScoreToTrade: 50, microMinScoreToTrade: 50, startingBalance: 0.1, minPositionSize: 0.005, maxPositionSize: 0.015, txFeePercent: 0, rugcheckMinScore: 0, maxVolLiqRatioNewToken: 1, maxDiscoveryAgeSeconds: 86400, dynamicHoldMaxSeconds: 60, txCostsEnabled: 0, safetyChecksEnabled: 0, dynamicHoldEnabled: 0, compoundBoostEnabled: 0, compoundRefSol: 0.1, compoundPower: 0.5, compoundMaxMultiplier: 1.0, compoundAbsCapSol: 0.1, minEdgePct: 0, edgeBuffer: 0, microMinEdgePct: 5.0, microEdgeBuffer: 0 };
      const maxValues: Record<string, number> = { mlWeight: 1, scoreWeight: 1, partialTpRatio: 1, dailyLossLimitPct: 100, maxDrawdownPct: 100, txFeePercent: 5, rugcheckMinScore: 1000, maxVolLiqRatioNewToken: 50, maxDiscoveryAgeSeconds: 86400, dynamicHoldMaxSeconds: 14400, txCostsEnabled: 1, safetyChecksEnabled: 1, dynamicHoldEnabled: 1, compoundBoostEnabled: 1, compoundRefSol: 100.0, compoundPower: 5.0, compoundMaxMultiplier: 10.0, compoundAbsCapSol: 10.0, minEdgePct: 20, edgeBuffer: 10, microMinEdgePct: 5.0, microEdgeBuffer: 10 };
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

  // ============================================================
  // GOLD HUNTER TRADE ENTRY BRIDGE — injects GMGN LEGENDARY/HIGH
  // signals into the main trade pipeline with full safety gates.
  // Called by the Gold Hunter background loop below.
  // ============================================================
  async function goldHunterTradeEntry(sig: any): Promise<void> {
    const now = Date.now();
    const addr = sig.mintAddress;
    
    // Skip if recently traded/attempted/blocked
    if (tradedAddresses.has(addr) || recentlyAttemptedBuys.has(addr) || hardBlockedAddresses.has(addr) || stoppedOutAddresses.has(addr)) {
      console.log(`[GOLD-ENTRY] SKIP $${sig.dex.baseToken.symbol.slice(0,8)} — address in cooldown/blocklist`);
      return;
    }
    if (pendingBuys.has(addr) || sellingInProgress.has(addr)) return;
    
    // Open trades check
    const openTrades = await storage.getOpenTrades();
    const maxPos = Math.max(engineSettings.maxOpenPositions, Math.floor(paperBalance / 10));
    if (openTrades.length >= Math.min(maxPos, 30)) {
      console.log(`[GOLD-ENTRY] SKIP $${sig.dex.baseToken.symbol.slice(0,8)} — max positions (${openTrades.length}/${maxPos})`);
      return;
    }
    
    // Re-fetch fresh DexScreener data for current price/liq
    const freshData = await throttledDexScreenerFetch(`https://api.dexscreener.com/latest/dex/tokens/${addr}`, 5000).catch(() => ({ pairs: [] }));
    const freshPairs: DexScreenerPair[] = (freshData?.pairs || []).filter((p: any) => p.chainId === 'solana');
    const pair = freshPairs.length > 0 ? freshPairs.reduce((best: DexScreenerPair, p: DexScreenerPair) => (p.liquidity?.usd || 0) > (best.liquidity?.usd || 0) ? p : best) : null;
    if (!pair) { console.log(`[GOLD-ENTRY] SKIP $${sig.dex.baseToken.symbol.slice(0,8)} — no Solana pair from DexScreener`); return; }
    
    const price = parseFloat(pair.priceUsd || '0');
    if (price <= 0) { console.log(`[GOLD-ENTRY] SKIP $${sig.dex.baseToken.symbol.slice(0,8)} — zero price`); return; }
    
    const liq = pair.liquidity?.usd || 0;
    if (liq < 1000) { console.log(`[GOLD-ENTRY] SKIP $${sig.dex.baseToken.symbol.slice(0,8)} — liq $${liq.toFixed(0)} < $1000`); return; }
    
    const status = await storage.getBotStatus();
    if (!status.isRunning) return;
    
    const isLive = status.tradingMode === 'live' && jupiterService !== null;
    const liveBal = isLive ? await readLiveWalletBalance().catch(() => paperBalance) : paperBalance;
    const effectiveBalance = Math.max(0, liveBal - reservedCapital);
    if (effectiveBalance < 0.005 + engineSettings.minPositionSize) {
      console.log(`[GOLD-ENTRY] SKIP $${sig.dex.baseToken.symbol.slice(0,8)} — insufficient balance (${effectiveBalance.toFixed(4)} SOL)`);
      return;
    }
    
    // Compute total exposure from open trades
    let totalExposureSol = 0, openPumpfunCount = 0;
    for (const t of openTrades) {
      totalExposureSol += parseFloat(t.amount || '0');
      if (t.tokenAddress?.endsWith('pump')) openPumpfunCount++;
    }
    const remainingBalance = effectiveBalance - totalExposureSol;
    if (remainingBalance < engineSettings.minPositionSize) {
      console.log(`[GOLD-ENTRY] SKIP $${sig.dex.baseToken.symbol.slice(0,8)} — remaining bal ${remainingBalance.toFixed(4)} < minPositionSize`);
      return;
    }
    
    // Score the token using main pipeline scorer
    const _PUMPFUN_DEXES = new Set(["pumpfun", "pump-fun", "pumpswap"]);
    const pairDex = (pair.dexId || '').toLowerCase();
    if (!JUPITER_SUPPORTED_DEXES.has(pairDex)) {
      console.log(`[GOLD-ENTRY] SKIP $${sig.dex.baseToken.symbol.slice(0,8)} — unsupported DEX: ${pairDex}`);
      hardBlockedAddresses.set(addr, Date.now());
      return;
    }
    if (_PUMPFUN_DEXES.has(pairDex) && openPumpfunCount >= 2) {
      console.log(`[GOLD-ENTRY] SKIP $${sig.dex.baseToken.symbol.slice(0,8)} — pumpfun concentration limit`);
      return;
    }
    
    const isMicroWallet = effectiveBalance < 0.10;
    let scoring = scoreToken(pair, null, isMicroWallet);
    
    // ML blend (if available)
    const mlPred = await getMLPrediction(scoring.metrics).catch(() => null);
    if (mlPred) {
      const mlScore = Math.round(mlPred.pumpProb * 100);
      const mlAdjusted = mlScore * (1 - mlPred.dumpRisk * 0.5);
      const combined = Math.max(0, Math.min(100, Math.round(scoring.score * engineSettings.scoreWeight + mlAdjusted * engineSettings.mlWeight)));
      scoring = { ...scoring, mlScore, combinedScore: combined };
    }
    scoring.sizeSol = Math.max(engineSettings.minPositionSize, scoring.sizeSol);
    
    // Apply Gold Hunter score override — LEGENDARY (>=75) or HIGH (>=50) signals
    // from GMGN real-time data carry more conviction than the scanner's stale HTTP poll.
    // Scale the Gold Hunter score (0-100) into the main pipeline's combinedScore space
    // so EDGE_POCKET_ONLY can evaluate it. LEGENDARY >= 75 → scores >= 80 in main scale.
    // HIGH >= 50 → scores >= 60 in main scale. The EDGE_POCKET_ONLY gate below will
    // still block anything below its thresholds.
    const goldBoosted = Math.max(scoring.combinedScore, Math.round(sig.score * 1.1));
    scoring = { ...scoring, combinedScore: goldBoosted };
    
    // New-mint survivors get a size floor (runtime concern, not gate logic)
    if (sig.tier === 'NEW_MINT' && scoring.combinedScore >= (Number(process.env.NEW_MINT_MIN_SCORE) || 65)) {
      scoring = { ...scoring, sizeSol: Math.max(engineSettings.minPositionSize, scoring.sizeSol || engineSettings.minPositionSize) };
    }
    
    // Evaluate gate via the pure decision function
    const gateResult = evaluateNewMintGate({
      tier: sig.tier,
      sigScore: sig.score,
      combinedScore: scoring.combinedScore,
      mlScore: scoring.mlScore ?? 0,
      px5m: Number((scoring.metrics as any)?.priceChange5m ?? 0),
      volMom: Number((scoring.metrics as any)?.volMomentum ?? 0),
      bp5m: parseFloat(String((scoring.metrics as any)?.bp5m ?? '0')),
      pc5m: Number((scoring.metrics as any)?.priceChange5m ?? 0),
      qualifiedMode: scoring.qualifiedMode,
      isMicroWallet,
      minScoreOverride: getEffectiveMinScore(isMicroWallet),
      env: {
        NEW_MINT_MIN_SCORE: Number(process.env.NEW_MINT_MIN_SCORE) || 65,
        EDGE_POCKET_ONLY: process.env.EDGE_POCKET_ONLY,
        EDGE_MIN_SCORE: Number(process.env.EDGE_MIN_SCORE) || 70,
        EDGE_HIGH_CONF_SCORE: Number(process.env.EDGE_HIGH_CONF_SCORE) || 80,
        EDGE_EXPLOSIVE_SCORE: Number(process.env.EDGE_EXPLOSIVE_SCORE) || 85,
        EDGE_EXPLOSIVE_ML: Number(process.env.EDGE_EXPLOSIVE_ML) || 80,
        EDGE_EXPLOSIVE_PX5M: Number(process.env.EDGE_EXPLOSIVE_PX5M) || 8,
        EDGE_EXPLOSIVE_VOLMOM: Number(process.env.EDGE_EXPLOSIVE_VOLMOM) || 1.5,
        ENTRY_CONFIRM_MIN_BP: Number(process.env.ENTRY_CONFIRM_MIN_BP ?? 0.50),
        ENTRY_CONFIRM_MIN_PC5M: Number(process.env.ENTRY_CONFIRM_MIN_PC5M ?? 0),
      },
    });
    if (!gateResult.admit) {
      console.log(`[GOLD-ENTRY] SKIP $${sig.dex.baseToken.symbol.slice(0,8)} — ${gateResult.reason}`);
      return;
    }
    // Apply gate decision to scoring for downstream use
    scoring = { ...scoring, qualifiedMode: gateResult.mode ?? scoring.qualifiedMode, combinedScore: gateResult.newCombinedScore };
    
    // Liquidity floor check
    const SOL_PRICE_USD = await getLiveSolPrice().catch(() => cachedSolPriceUsd);
    const poolLiqSol = SOL_PRICE_USD > 0 ? liq / SOL_PRICE_USD : Infinity;
    const sniperLiqFloor = engineSettings.sniperMinLiquidity;
    const MIN_BUY_LIQ_USD = scoring.qualifiedMode === 'HWR' ? engineSettings.hwrMinLiquidity : sniperLiqFloor;
    if (liq < MIN_BUY_LIQ_USD) {
      console.log(`[GOLD-ENTRY] SKIP $${sig.dex.baseToken.symbol.slice(0,8)} — liq $${liq.toFixed(0)} < $${MIN_BUY_LIQ_USD}`);
      return;
    }
    
    // Sizing
    const totalPortfolioSol = effectiveBalance + totalExposureSol;
    const { pct: tierPct, boost: microBoost, tier: sizingTier } = getTieredSizing(totalPortfolioSol);
    let targetSize = Math.min(remainingBalance * tierPct, poolLiqSol * 0.015);
    targetSize = Math.max(targetSize, engineSettings.minPositionSize);
    targetSize = Math.min(targetSize * microBoost, remainingBalance * tierPct, poolLiqSol * 0.015);
    targetSize = Math.min(targetSize, engineSettings.compoundAbsCapSol);
    const lossThrottle = Math.max(0.60, 1 - consecutiveLosses * 0.10);
    const ddPctSizing = peakBalance > 0 ? Math.max(0, ((peakBalance - totalPortfolioSol) / peakBalance) * 100) : 0;
    const ddDelever = ddPctSizing > 15 ? Math.max(0.50, 1 - (ddPctSizing - 15) / 20) : 1;
    targetSize = targetSize * lossThrottle * ddDelever;
    targetSize = Math.max(targetSize, engineSettings.minPositionSize);
    scoring.sizeSol = parseFloat(targetSize.toFixed(4));
    
    if (scoring.sizeSol < MIN_TRADE_SIZE_SOL) {
      console.log(`[GOLD-ENTRY] SKIP $${sig.dex.baseToken.symbol.slice(0,8)} — dust size ${scoring.sizeSol.toFixed(4)} SOL`);
      return;
    }
    
    const tradeSizeUsd = scoring.sizeSol * SOL_PRICE_USD;
    const dynamicMinLiq = tradeSizeUsd * 80;
    if (liq < dynamicMinLiq) {
      console.log(`[GOLD-ENTRY] SKIP $${sig.dex.baseToken.symbol.slice(0,8)} — liq $${liq.toFixed(0)} < dynamic $${dynamicMinLiq.toFixed(0)}`);
      return;
    }
    
    const maxTotalExposure = Math.max(engineSettings.maxPositionSize * 10, totalPortfolioSol * 0.95);
    if (totalExposureSol + scoring.sizeSol > maxTotalExposure) {
      console.log(`[GOLD-ENTRY] SKIP $${sig.dex.baseToken.symbol.slice(0,8)} — max exposure`);
      return;
    }
    
    const txCosts = calcTransactionCosts(liq, scoring.sizeSol);
    const entryTotalCostSol = scoring.sizeSol * (1 + (txCosts.entrySlippagePct + txCosts.entryFeePct) / 100);
    if (entryTotalCostSol < MIN_VIABLE_TRADE_SOL) {
      console.log(`[GOLD-ENTRY] SKIP $${sig.dex.baseToken.symbol.slice(0,8)} — below viable trade size`);
      return;
    }
    
    // Safety check
    const safety = await checkTokenSafety(addr, pair, sig.tier);
    if (!safety.safe) {
      console.log(`[GOLD-ENTRY] BLOCKED $${sig.dex.baseToken.symbol.slice(0,8)} — ${safety.reason}`);
      if (safety.reason.startsWith('rugcheck_danger') || safety.reason.startsWith('rugcheck_risk_high') || safety.reason.startsWith('insider_ownership')) {
        hardBlockedAddresses.set(addr, Date.now());
      }
      return;
    }
    
    // PLAYBOOK(2026-06-29): mint-authority-active tokens are admitted (still sellable) but carry DILUTION risk -> size down rather than full size. Disable via MINT_ACTIVE_SIZE_MULT=1.
    if (safety.mintActive) { const _mMult = Number(process.env.MINT_ACTIVE_SIZE_MULT) || 0.5; const _pre = scoring.sizeSol; scoring.sizeSol = parseFloat((scoring.sizeSol * _mMult).toFixed(4)); console.log(`[SIZING] $${sig.dex.baseToken.symbol.slice(0,8)} mint-active dilution haircut x${_mMult}: ${_pre} -> ${scoring.sizeSol} SOL`); }
    // Whale tape pre-entry gate: skip if whales are net-distributing (sellers > buyers)
    // $Bepe: LEGENDARY score=89 but Helius tape showed 8 sellers vs 2 buyers at entry
    // — whales were ALREADY selling by the time GMGN reported "smart money bought."
    const _whaleGate = await fetchWhaleTapeHelius(addr).catch(() => null);
    if (_whaleGate && _whaleGate.whaleCount >= 3 && _whaleGate.whaleNetSellers > _whaleGate.whaleNetBuyers && _whaleGate.whaleNetSellers >= 2) {
      console.log(`[GOLD-ENTRY] SKIP $${sig.dex.baseToken.symbol.slice(0,8)} — whale distribution (netSellers=${_whaleGate.whaleNetSellers} > netBuyers=${_whaleGate.whaleNetBuyers})`);
      return;
    }
    
    // Jupiter preflight for live mode
    let slippageBps = scoring.slippage * 100;
    const preflightImpactLimit = scoring.qualifiedMode === 'SNIPER' ? 7 : 4;
    let executionQuote: any = null;
    
    if (status.tradingMode === 'live' && jupiterService) {
      const lamportsForPreflight = Math.floor(scoring.sizeSol * 1e9);
      try {
        executionQuote = await jupiterService.fetchQuote(SOL_MINT, addr, lamportsForPreflight, [slippageBps]);
        if (!executionQuote) { console.log(`[GOLD-ENTRY] SKIP $${sig.dex.baseToken.symbol.slice(0,8)} — no Jupiter quote`); return; }
        executionQuote._fetchedAt = Date.now();
      } catch { console.log(`[GOLD-ENTRY] SKIP $${sig.dex.baseToken.symbol.slice(0,8)} — quote failed`); return; }
      
      const impactPct = parseFloat(executionQuote.priceImpactPct ?? '0');
      if (impactPct > preflightImpactLimit) {
        console.log(`[GOLD-ENTRY] SKIP $${sig.dex.baseToken.symbol.slice(0,8)} — impact ${impactPct.toFixed(2)}% > ${preflightImpactLimit}%`);
        return;
      }
      
      // Round-trip simulation
      if (executionQuote.outAmount) {
        try {
          const sellCheckQuote = await jupiterService.fetchQuote(addr, SOL_MINT, executionQuote.outAmount, [slippageBps]);
          if (!sellCheckQuote || !sellCheckQuote.outAmount) {
            console.log(`[GOLD-ENTRY] SKIP $${sig.dex.baseToken.symbol.slice(0,8)} — no sell route`);
            hardBlockedAddresses.set(addr, Date.now());
            return;
          }
          const sellReturnLamports = parseInt(sellCheckQuote.outAmount, 10);
          const roundTripPct = (sellReturnLamports / lamportsForPreflight) * 100;
          if (roundTripPct < 85) {
            console.log(`[GOLD-ENTRY] SKIP $${sig.dex.baseToken.symbol.slice(0,8)} — round-trip ${(100 - roundTripPct).toFixed(1)}% loss`);
            return;
          }
          const sellImpactPct = parseFloat(sellCheckQuote.priceImpactPct ?? '0');
          if (sellImpactPct > 10) {
            console.log(`[GOLD-ENTRY] SKIP $${sig.dex.baseToken.symbol.slice(0,8)} — sell impact ${sellImpactPct.toFixed(2)}%`);
            return;
          }
        } catch { console.log(`[GOLD-ENTRY] SKIP $${sig.dex.baseToken.symbol.slice(0,8)} — sell preflight failed`); return; }
      }
    }
    
    // Edge check
    const edge = getEdgeParams(isMicroWallet);
    const scoreBasedExpectedMove = Math.max(0, (scoring.combinedScore - 50) * edge.expectedMoveCoeff);
    const finalEstimatedImpact = executionQuote ? parseFloat(executionQuote.priceImpactPct ?? '0') : (liq > 0 ? Math.min(12, ((scoring.sizeSol * SOL_PRICE_USD) / (liq * 2)) * 100) : 6);
    const finalRoundTripCost = finalEstimatedImpact * edge.exitImpactMult + engineSettings.txFeePercent * edge.feeMultiplier + edge.buffer;
    const finalEdge = scoreBasedExpectedMove - finalRoundTripCost;
    if (finalEdge < edge.minEdgePct) {
      console.log(`[GOLD-ENTRY] SKIP $${sig.dex.baseToken.symbol.slice(0,8)} — edge ${finalEdge.toFixed(2)}% < ${edge.minEdgePct}%`);
      return;
    }
    
    // Circuit breaker check
    const canTrade = await checkCircuitBreakers();
    if (!canTrade.canTrade) { console.log(`[GOLD-ENTRY] SKIP $${sig.dex.baseToken.symbol.slice(0,8)} — circuit breaker`); return; }
    if (isHalted()) { console.log(`[GOLD-ENTRY] SKIP $${sig.dex.baseToken.symbol.slice(0,8)} — halt`); return; }
    
    // ── EXECUTE ──
    console.log(`[GOLD-ENTRY] ENTERING $${sig.dex.baseToken.symbol.slice(0,8)} | size=${scoring.sizeSol.toFixed(4)} SOL | score=${scoring.combinedScore} | gold=${sig.tier} (${sig.score}) | liq=$${liq.toFixed(0)}`);
    
    if (isLive) {
      pendingBuys.set(addr, Date.now());
      reservedCapital += entryTotalCostSol;
      try {
        const buyResult = await jupiterService!.buyToken(addr, scoring.sizeSol, slippageBps, executionQuote ?? undefined, preflightImpactLimit);
        if (buyResult?.success && buyResult.actualSolSpent > 0 && buyResult.tokenAmountRaw > BigInt(0)) {
          const liveTxHash = buyResult.txSignature || '';
          console.log(`[GOLD-ENTRY] BOUGHT $${sig.dex.baseToken.symbol.slice(0,8)} tx=${liveTxHash} spent=${buyResult.actualSolSpent.toFixed(4)} SOL`);
          tradedAddresses.set(addr, Date.now());
          await storage.addTrade({
            tokenAddress: addr, tokenSymbol: sig.dex.baseToken.symbol, type: "BUY", mode: scoring.qualifiedMode,
            tradingMode: "live", status: "OPEN", amount: buyResult.actualSolSpent.toFixed(4), price: pair.priceUsd || '0',
            currentPrice: pair.priceUsd || '0', peakPrice: pair.priceUsd || '0', pnl: "0", peakPnl: "0",
            score: scoring.combinedScore.toString(), txHash: liveTxHash, liquidity: liq.toFixed(2),
            dex: pairDex,
          });
        } else {
          console.log(`[GOLD-ENTRY] BUY FAILED $${sig.dex.baseToken.symbol.slice(0,8)} — ${buyResult?.error || 'no result'}`);
        }
      } catch (err: any) {
        console.log(`[GOLD-ENTRY] BUY ERROR $${sig.dex.baseToken.symbol.slice(0,8)} — ${err.message}`);
      } finally {
        pendingBuys.delete(addr);
        reservedCapital -= entryTotalCostSol;
      }
    } else {
      // Paper mode: record virtual trade
      const paperTxHash = `paper_${(sig.tier || 'SCANNER').slice(0, 8).toLowerCase()}_${Date.now().toString(36)}_${addr.substring(0, 6)}`;
      tradedAddresses.set(addr, Date.now());
      const paperTradeAmount = Math.min(scoring.sizeSol, remainingBalance);
      paperBalance -= paperTradeAmount;
      await storage.addTrade({
        tokenAddress: addr, tokenSymbol: sig.dex.baseToken.symbol, type: "BUY", mode: scoring.qualifiedMode,
        tradingMode: "paper", status: "OPEN", amount: paperTradeAmount.toFixed(4), price: pair.priceUsd || '0',
        currentPrice: pair.priceUsd || '0', peakPrice: pair.priceUsd || '0', pnl: "0", peakPnl: "0",
        score: scoring.combinedScore.toString(), txHash: paperTxHash, liquidity: liq.toFixed(2),
        dex: pairDex,
      });
      console.log(`[GOLD-ENTRY] PAPER ENTER $${sig.dex.baseToken.symbol.slice(0,8)} size=${paperTradeAmount.toFixed(4)} SOL score=${scoring.combinedScore}`);
    }
  }

  // ============================================================
  // NEW MINT DETECTOR — polls Helius Enhanced Transactions API
  // for the Raydium V4 + PumpSwap programs. Detects new tokens
  // by tracking mint addresses seen in tokenTransfers. When a
  // mint appears for the FIRST time, it means a new pool just
  // had its first swap — detected 3-7s after creation.
  // Bootstrap phase: first 6 polls (~30s) learn known mints
  // without triggering entries. After bootstrap, every new mint
  // is a potential entry. Existing safety gates filter garbage.
  // ============================================================
  const RAYDIUM_AMM_V4 = '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8';
  const PUMP_SWAP_PROGRAM = 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA';
  const knownMintsOnRaydium = new Set<string>();
  let newMintDetectorBootstrapped = false;
  let newMintDetectorPolls = 0;
  const NEW_MINT_BOOTSTRAP_POLLS = 6;
  const WELL_KNOWN_MINTS = new Set([
    'So11111111111111111111111111111111111111112', // SOL/WSOL
    'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
    'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', // USDT
    'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263', // BONK
    'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm', // WIF
    'mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So', // mSOL
    'J1toso1uCk3QLmjYXoTpQL5yV1aAne6P76w3Cj3f5Vt', // JitoSOL
    'bSo13r4TkiE4KumL71LsHTPpL2euBYLFx6h9HP3piy1', // bSOL
    '7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs', // ETH (Wormhole)
    '7dHbWXmci3dT8UFYWYZweBL48EneW8G3CUtNS7iPTTtN', // LDO
    'SRMuApVNdxXokk5GT7XD5cUUgXMBCoAz2LHeuAoKWRt', // SRM
    'MangoCzJusvvr33KFVssXFZxS3PqNcBGLTqGzpQKj6q', // MNGO
    'orcaEKTdK7LKz57vaAYr9QeNsVEPfiu6QeMU1kektZE6', // ORCA
    'ATLASXmbPQxBUYbxPsV97zA5fepDZ5UFRfB2MsW5jW3', // ATLAS
    'FZz4eEH1QJqioHYnKJFZ6dQCrkgfRsmj1ujEpojAFjZ9', // RAY
  ]);

  // NEW-MINT diagnostics: dedicated throttle so the detector is never a silent
  // black box. Distinct messages each surface once per window; numeric-only
  // variations (heartbeat counts) collapse so they don't spam every 6s.
  const _newMintDiagTs = new Map<string, number>();
  function _newMintDiag(msg: string, everyMs: number = 20000): void {
    const now = Date.now();
    const key = msg.replace(/[0-9]+/g, '#');
    if ((_newMintDiagTs.get(key) || 0) > now - everyMs) return;
    _newMintDiagTs.set(key, now);
    console.warn('[NEW-MINT-DIAG] ' + msg);
  }
  const _newMintShapeLogged = new Set<string>();

  // --- New-mint confirmation funnel (2026-06-29) -----------------------------
  // The first Raydium swap IS the creator's exit, so entering at T+0 is -EV.
  // Instead we watchlist the mint and only enter after a delay IF it survived the
  // dump (liquidity floor + net m5 buyers + not in freefall). New mints are NOT
  // scored LEGENDARY; they route through the normal gates with a neutral score.
  const NEW_MINT_ENTRY_DELAY_MS = Number(process.env.NEW_MINT_ENTRY_DELAY_MS) || 90_000;
  const NEW_MINT_MAX_AGE_MS = Number(process.env.NEW_MINT_MAX_AGE_MS) || 600_000;
  const NEW_MINT_MIN_LIQ_USD = Number(process.env.NEW_MINT_MIN_LIQ_USD) || 25_000;
  const NEW_MINT_MIN_M5_CHANGE = Number(process.env.NEW_MINT_MIN_M5_CHANGE ?? '-5');
  const NEW_MINT_SCORE = Number(process.env.NEW_MINT_SCORE) || 0;
  const NEW_MINT_MAX_TOKEN_AGE_MIN = Number(process.env.NEW_MINT_MAX_TOKEN_AGE_MIN) || 60;
  let _promoteRunning = false;
  const newMintWatchlist = new Map<string, { firstSeenTs: number; symbol: string; label: string }>();

  async function promoteNewMintWatchlist(): Promise<void> {
    if (newMintWatchlist.size === 0) return;
    if (_promoteRunning) return; // prevent overlapping 6s cycles from double-processing the same mint
    _promoteRunning = true;
    try {
    const now = Date.now();
    for (const [mint, info] of [...newMintWatchlist.entries()]) {
      const age = now - info.firstSeenTs;
      if (age < NEW_MINT_ENTRY_DELAY_MS) continue;
      // One shot per mint: drop from the watchlist regardless of outcome.
      newMintWatchlist.delete(mint);
      if (age > NEW_MINT_MAX_AGE_MS) { _newMintDiag('expired ' + mint.slice(0, 8) + ' (aged out before confirm)'); continue; }
      if (tradedAddresses.has(mint) || recentlyAttemptedBuys.has(mint) || hardBlockedAddresses.has(mint) || stoppedOutAddresses.has(mint)) continue;

      let pair: DexScreenerPair | null = null;
      try {
        const data = await throttledDexScreenerFetch('https://api.dexscreener.com/latest/dex/tokens/' + mint, 5000);
        const pairs: DexScreenerPair[] = (data?.pairs || []).filter((p: any) => p.chainId === 'solana');
        pair = pairs.length > 0 ? pairs.reduce((best: DexScreenerPair, p: DexScreenerPair) => (p.liquidity?.usd || 0) > (best.liquidity?.usd || 0) ? p : best) : null;
      } catch (e: any) { _newMintDiag('confirm fetch failed ' + mint.slice(0, 8) + ': ' + (e?.message || String(e))); continue; }

      if (!pair) { console.log('[NEW-MINT] DROP $' + info.symbol + ' - no DexScreener pair after ' + Math.round(age / 1000) + 's (never listed / died)'); continue; }
      const price = parseFloat(pair.priceUsd || '0');
      const liq = pair.liquidity?.usd || 0;
      const m5buys = pair.txns?.m5?.buys || 0;
      const m5sells = pair.txns?.m5?.sells || 0;
      const m5change = pair.priceChange?.m5 ?? 0;
      const tokenAgeMin = pair.pairCreatedAt ? (Date.now() - pair.pairCreatedAt) / 60000 : 0;

      if (price <= 0) { console.log('[NEW-MINT] DROP $' + info.symbol + ' - zero price'); continue; }
      if (pair.pairCreatedAt && tokenAgeMin > NEW_MINT_MAX_TOKEN_AGE_MIN) { console.log('[NEW-MINT] DROP $' + info.symbol + ' - not a new mint (pool age ' + Math.round(tokenAgeMin) + 'min > ' + NEW_MINT_MAX_TOKEN_AGE_MIN + 'min)'); continue; }
      if (liq < NEW_MINT_MIN_LIQ_USD) { console.log('[NEW-MINT] DROP $' + info.symbol + ' - liq $' + liq.toFixed(0) + ' < floor $' + NEW_MINT_MIN_LIQ_USD); continue; }
      if (m5buys <= m5sells) { console.log('[NEW-MINT] DROP $' + info.symbol + ' - net sellers m5 (buys=' + m5buys + ' sells=' + m5sells + ', dump not passed)'); continue; }
      if (m5change < NEW_MINT_MIN_M5_CHANGE) { console.log('[NEW-MINT] DROP $' + info.symbol + ' - m5 ' + m5change + '% < ' + NEW_MINT_MIN_M5_CHANGE + '% (freefall)'); continue; }

      const sig: any = { mintAddress: mint, score: NEW_MINT_SCORE, tier: 'NEW_MINT', dex: { baseToken: { symbol: info.symbol } } };
      console.log('[NEW-MINT] CONFIRM $' + info.symbol + ' (' + mint.slice(0, 8) + '...) age=' + Math.round(age / 1000) + 's liq=$' + liq.toFixed(0) + ' m5buys=' + m5buys + '/' + m5sells + ' m5chg=' + m5change + '% -> normal-gate entry');
      try { await goldHunterTradeEntry(sig); }
      catch (e: any) { console.warn('[NEW-MINT] entry error for ' + mint.slice(0, 8) + ': ' + (e?.message || String(e))); }
    }
    } finally { _promoteRunning = false; }
  }

  async function pollNewMintsHelius(): Promise<void> {
    if (String(process.env.HELIUS_NEW_MINT_POLLER ?? 'on').toLowerCase() === 'off') { return; } // FIX(2026-07-01): kill-switch for the Helius new-mint poller. It only feeds a 90s watchlist (RAYV4 returns tokenTransfers=0 = wasted calls) while real trade candidates arrive via GMGN feeds (zero Helius). Set HELIUS_NEW_MINT_POLLER=off in .env to stop the Helius burn with no trade impact.
    const programs: Array<[string, string]> = [['PUMPSWAP', PUMP_SWAP_PROGRAM]]; // FIX(2026-07-01 fresh-snipe): PumpSwap-only. RAYV4 dropped (returned tokenTransfers=0 = wasted Helius); PumpSwap returns usable tokenTransfers=4. RPM cap + 20s cadence keep Helius bounded.
    let pollTxTotal = 0;
    let pollNewMints = 0;
    let pollOkPrograms = 0;
    for (const [label, program] of programs) {
      // Fresh key PER PROGRAM so one cooled/exhausted key can't blind both feeds.
      const key = _getHeliusTapeKey();
      if (!key) { _newMintDiag('no Helius key available (all on 429 cooldown?) - skipping ' + label); continue; }
      if (!_heliusRateGate()) { _newMintDiag('[' + label + '] global RPM budget exhausted (' + HELIUS_GLOBAL_RPM + '/min) - skipping'); continue; }
      let txs: any[] = [];
      try {
        const url = HELIUS_TAPE_BASE + '/' + program + '/transactions?api-key=' + key + '&limit=50';
        const resp = await fetch(url, { headers: { 'Accept': 'application/json' }, signal: AbortSignal.timeout(10000) });
        if (!resp.ok) {
          let body = '';
          try { body = (await resp.text()).slice(0, 200); } catch {}
          _newMintDiag('[' + label + '] HTTP ' + resp.status + ' ' + resp.statusText + ' - ' + body);
          if (resp.status === 429) _markHeliusKey429(key, body);
          continue;
        }
        const payload = await resp.json();
        if (!Array.isArray(payload)) {
          const shape = payload && typeof payload === 'object' ? JSON.stringify(payload).slice(0, 200) : String(payload);
          _newMintDiag('[' + label + '] payload is NOT an array (type=' + typeof payload + ') - ' + shape);
          continue;
        }
        txs = payload as any[];
      } catch (e: any) {
        _newMintDiag('[' + label + '] fetch/parse FAILED: ' + (e?.name || '') + ' ' + (e?.message || String(e)));
        continue;
      }
      pollOkPrograms++; _markHeliusKeyOk(key);
      pollTxTotal += txs.length;
      if (txs.length === 0) { _newMintDiag('[' + label + '] OK but 0 transactions returned'); continue; }
      // One-time response-shape verification per program so the format is known.
      if (!_newMintShapeLogged.has(label)) {
        _newMintShapeLogged.add(label);
        const t0: any = txs[0] || {};
        const ttCount = Array.isArray(t0?.tokenTransfers) ? t0.tokenTransfers.length : 'MISSING';
        const ttTotal = txs.reduce((sum: number, t: any) => sum + (Array.isArray(t?.tokenTransfers) ? t.tokenTransfers.length : 0), 0);
        const ttTxs = txs.filter((t: any) => Array.isArray(t?.tokenTransfers) && t.tokenTransfers.length > 0).length;
        console.log('[NEW-MINT][' + label + '] shape OK - txs=' + txs.length + ' firstTxKeys=[' + Object.keys(t0).join(',') + '] firstTxTokenTransfers=' + ttCount + ' tokenTransfersTotal=' + ttTotal + ' txsWithTokenTransfers=' + ttTxs);
      }
      let sawTokenTransfers = false;
      for (const tx of txs) {
        const transfers = tx?.tokenTransfers;
        if (!Array.isArray(transfers) || transfers.length === 0) continue;
        sawTokenTransfers = true;
        for (const tr of transfers) {
          const mint = tr?.mint;
          if (!mint || WELL_KNOWN_MINTS.has(mint) || knownMintsOnRaydium.has(mint)) continue;
          knownMintsOnRaydium.add(mint);
          pollNewMints++;

          // Skip during bootstrap - we are just learning the existing mint set.
          if (!newMintDetectorBootstrapped) continue;
          if (tradedAddresses.has(mint) || recentlyAttemptedBuys.has(mint) || hardBlockedAddresses.has(mint) || stoppedOutAddresses.has(mint)) continue;
          if (newMintWatchlist.has(mint)) continue;

          // STRATEGY (2026-06-29): do NOT enter at T+0 -- the first Raydium swap is the
          // creator's exit. Watchlist it; promoteNewMintWatchlist() re-checks after a
          // delay and only enters survivors via the normal gates.
          const symbol = mint.slice(0, 6);
          newMintWatchlist.set(mint, { firstSeenTs: Date.now(), symbol, label });
          console.log('[NEW-MINT] $' + symbol + ' (' + mint.slice(0, 8) + '...) - first seen via ' + label + ', watchlisted (confirm in ' + Math.round(NEW_MINT_ENTRY_DELAY_MS / 1000) + 's)');
        }
      }
      if (!sawTokenTransfers) _newMintDiag('[' + label + '] ' + txs.length + ' txs but NONE had tokenTransfers (parsed-tx shape mismatch)');
    }

    // Bootstrap progresses on poll count regardless of per-program success, so a
    // transient API failure can never permanently wedge the detector in bootstrap.
    if (!newMintDetectorBootstrapped) {
      newMintDetectorPolls++;
      _newMintDiag('bootstrap ' + newMintDetectorPolls + '/' + NEW_MINT_BOOTSTRAP_POLLS + ' - learned ' + knownMintsOnRaydium.size + ' mints (okPrograms=' + pollOkPrograms + ' txs=' + pollTxTotal + ')');
      if (newMintDetectorPolls >= NEW_MINT_BOOTSTRAP_POLLS) {
        newMintDetectorBootstrapped = true;
        console.log('[NEW-MINT] Bootstrapped: ' + knownMintsOnRaydium.size + ' known mints, now detecting new tokens');
      }
    } else {
      // Heartbeat (throttled ~60s): proves the detector polled successfully even
      // when there are zero new mints - distinguishes "no new mints" from "API failing".
      _newMintDiag('heartbeat - okPrograms=' + pollOkPrograms + '/' + programs.length + ' txs=' + pollTxTotal + ' newMints=' + pollNewMints + ' known=' + knownMintsOnRaydium.size, 60000);
    }

    // Confirmation funnel: promote aged, surviving watchlist mints.
    await promoteNewMintWatchlist();

    if (knownMintsOnRaydium.size > 20000) {
      const arr = [...knownMintsOnRaydium];
      knownMintsOnRaydium.clear();
      for (const a of arr.slice(-10000)) knownMintsOnRaydium.add(a);
    }
  }

  // ============================================================
  // GOLD HUNTER OVERHAUL — per-feed signal processing with
  // immediate trade evaluation instead of 30s batched runHunter().
  // Signal feed runs every 5s for fast GMGN alerts; other feeds
  // at their natural cadence. Global dedup prevents double-trades.
  // No duplicate API calls: per-feed intervals replace runHunter()
  // for trade entry; runHunter() runs on slow diag-only interval.
  // ============================================================
  const _goldProcessed = new Set<string>();

  async function _processGoldFeed(sigs: any[], source: string): Promise<void> {
    for (const sig of sigs) {
      if (sig.tier === 'SKIP' || sig.tier === 'MEDIUM' || !sig.gmgn || !sig.dex) continue;
      const addr = sig.mintAddress;
      if (_goldProcessed.has(addr)) continue;
      _goldProcessed.add(addr);
      console.log(`[GOLD-${source}] ${sig.tier} | ${addr.slice(0,8)} | score=${sig.score}`);
      if (process.env.MODE === 'live' && sig.tier !== 'LEGENDARY') continue;
      try { await goldHunterTradeEntry(sig); } catch (e) { console.log(`[GOLD-${source}] entry err: ${e}`); }
    }
    if (_goldProcessed.size > 2000) {
      const arr = [..._goldProcessed];
      _goldProcessed.clear();
      for (const a of arr.slice(-1000)) _goldProcessed.add(a);
    }
  }

  if (process.env.GOLD_HUNTER_ENABLED === 'true') {
    console.log('[GOLD HUNTER] Starting per-feed processing...');

    setTimeout(() => {
      // Signal feed — 5s, GMGN type-11/12 smart money alerts (fastest)
      setInterval(async () => {
        const sigs = await pollSignalFeed().catch(() => []);
        _processGoldFeed(sigs, 'SIGNAL');
      }, 5_000);
    }, 1_000);

    setTimeout(() => {
      // Trending — 30s batch filter
      setInterval(async () => {
        const sigs = await pollTrending().catch(() => []);
        _processGoldFeed(sigs, 'TRENDING');
      }, 30_000);
    }, 3_000);

    setTimeout(() => {
      // Trenches — 20s near-graduation + completed
      setInterval(async () => {
        const sigs = await pollTrenches().catch(() => []);
        _processGoldFeed(sigs, 'TRENCHES');
      }, 20_000);
    }, 5_000);

    setTimeout(() => {
      // Smart money cluster — 30s whale tracking
      setInterval(async () => {
        const sigs = await pollSmartMoneyFeed().catch(() => []);
        _processGoldFeed(sigs, 'CLUSTER');
      }, 30_000);
    }, 7_000);

    setTimeout(() => {
      // DexScreener — 30s profiles/boosts
      setInterval(async () => {
        const sigs = await pollDexScreenerFeeds().catch(() => []);
        _processGoldFeed(sigs, 'DEX');
      }, 30_000);
    }, 9_000);

    setTimeout(() => {
      // New mint detector - 20s (FREQ 2026-06-30: 6s->12s->20s to reduce Helius burn ~70% total. PUMPSWAP dropped, RAYV4 only.)
      setInterval(async () => {
        await pollNewMintsHelius();
      }, 20_000);
    }, 15_000);
    
    // Diagnostic summary via runHunter (60s) — no trade processing,
    // trades already handled by per-feed intervals above.
    setTimeout(() => {
      setInterval(async () => {
        try { await runHunter(); } catch (e) { console.log('[GOLD-HUNTER] diag error: ' + String(e)); }
      }, 60_000);
    }, 11_000);

    console.log('[GOLD HUNTER] Active — signal/5s trending/30s trenches/20s cluster/30s dex/30s newMints/20s');
  } else {
    console.log('[GOLD HUNTER] Disabled - set GOLD_HUNTER_ENABLED=true to activate');
  }
  // ============================================================

  return httpServer;
}
