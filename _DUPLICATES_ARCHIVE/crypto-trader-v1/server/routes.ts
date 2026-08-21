import type { Express } from "express";
import type { Server } from "http";
import { storage } from "./storage";
import { api } from "@shared/routes";

interface DexScreenerPair {
  chainId: string;
  dexId: string;
  pairAddress: string;
  baseToken: { address: string; name: string; symbol: string };
  quoteToken: { address: string; name: string; symbol: string };
  priceUsd?: string;
  priceNative?: string;
  txns?: {
    m5?: { buys: number; sells: number };
    h1?: { buys: number; sells: number };
    h24?: { buys: number; sells: number };
  };
  volume?: { m5?: number; h1?: number; h6?: number; h24?: number };
  priceChange?: { m5?: number; h1?: number; h6?: number; h24?: number };
  liquidity?: { usd?: number };
  fdv?: number;
  marketCap?: number;
  pairCreatedAt?: number;
}

let engineSettings = {
  trailingStopActivation: 5,
  trailingStopDistance: 4,
  hardTakeProfit: 80,
  stopLoss: -5,
  maxHoldSeconds: 360,
  maxOpenPositions: 12,
  startingBalance: 10,
  scanIntervalMs: 5000,
  priceCheckIntervalMs: 3000,
  minScoreToTrade: 65,
  mlServiceUrl: "http://localhost:5001",
  mlWeight: 0.30,
  scoreWeight: 0.70,
  dailyLossLimitPct: 20,
  maxDrawdownPct: 45,
  lossCooldownMs: 20000,
  partialTpRatio: 0.5,
  partialTpThreshold: 20,
  sniperMinScore: 52,
  sniperMaxAge: 300,
  sniperMinBuyPressure: 0.48,
  sniperMinLiquidity: 800,
  sniperMaxSize: 2.5,
  mgMinScore: 58,
  mgMinVolMomentum: 1.1,
  mgMinPriceChange5m: 1.0,
  mgMinTxVelocity: 8,
  mgMaxSize: 2.0,
  hwrMinScore: 62,
  hwrMinBuyPressure5m: 0.52,
  hwrMinBuyPressure1h: 0.48,
  hwrMinLiquidity: 2000,
  hwrMaxSize: 1.5,
  maxPositionSize: 5.0,
  minPositionSize: 0.05,
  maxTradesPerCycle: 6,
  reentryDelayMs: 60000,
};

let liveCandidatesCache: any[] = [];
let lastScanTime = 0;
let tradedAddresses = new Map<string, number>();
let scannerInterval: ReturnType<typeof setInterval> | null = null;
let priceCheckerInterval: ReturnType<typeof setInterval> | null = null;
let paperBalance = engineSettings.startingBalance;
let balanceInitialized = false;
let peakPrices = new Map<number, number>();
let partialTpTaken = new Set<number>();
let consecutiveWins = 0;
let consecutiveLosses = 0;
let mlServiceAvailable = false;

let dailyPnlSol = 0;
let dailyTradeCount = 0;
let dailyStartBalance = engineSettings.startingBalance;
let lastDailyReset = new Date().toDateString();
let peakBalance = engineSettings.startingBalance;
let circuitBreakerActive = false;
let lastLossCooldownEnd = 0;
let totalTradesAllTime = 0;
let engineStartTime = Date.now();

function resetDailyStats() {
  const today = new Date().toDateString();
  if (today !== lastDailyReset) {
    dailyPnlSol = 0;
    dailyTradeCount = 0;
    dailyStartBalance = paperBalance;
    lastDailyReset = today;
    if (!circuitBreakerActive) {
      console.log(`[RISK] Daily stats reset | Start balance: ${dailyStartBalance.toFixed(3)} SOL`);
    }
  }
}

async function getEffectiveBalance(): Promise<number> {
  try {
    const openTrades = await storage.getOpenTrades();
    let openCapital = 0;
    for (const t of openTrades) {
      openCapital += parseFloat(t.amount || "0");
    }
    return paperBalance + openCapital;
  } catch {
    return paperBalance;
  }
}

let scanLock = false;

async function checkCircuitBreakers(): Promise<{ canTrade: boolean; reason: string }> {
  resetDailyStats();

  const realizedLoss = dailyPnlSol < 0 ? Math.abs(dailyPnlSol) : 0;
  const dailyLossPct = dailyStartBalance > 0 ? (realizedLoss / dailyStartBalance) * 100 : 0;
  if (dailyLossPct >= engineSettings.dailyLossLimitPct) {
    circuitBreakerActive = true;
    return { canTrade: false, reason: `DAILY_LOSS_LIMIT (${dailyLossPct.toFixed(1)}% >= ${engineSettings.dailyLossLimitPct}%)` };
  }

  const effectiveBal = await getEffectiveBalance();
  const drawdownPct = peakBalance > 0 ? ((peakBalance - effectiveBal) / peakBalance) * 100 : 0;
  if (drawdownPct >= engineSettings.maxDrawdownPct) {
    circuitBreakerActive = true;
    return { canTrade: false, reason: `MAX_DRAWDOWN (${drawdownPct.toFixed(1)}% >= ${engineSettings.maxDrawdownPct}%)` };
  }

  if (Date.now() < lastLossCooldownEnd) {
    const remaining = Math.ceil((lastLossCooldownEnd - Date.now()) / 1000);
    return { canTrade: false, reason: `LOSS_COOLDOWN (${remaining}s remaining)` };
  }

  circuitBreakerActive = false;
  return { canTrade: true, reason: "OK" };
}

async function checkMLService(): Promise<boolean> {
  try {
    const resp = await fetch(`${engineSettings.mlServiceUrl}/health`, { signal: AbortSignal.timeout(2000) });
    if (resp.ok) {
      const data = await resp.json() as any;
      if (!mlServiceAvailable) {
        console.log(`[ML] Connected to XGBoost model v${data.model_version} (${data.features?.length} features)`);
      }
      mlServiceAvailable = true;
      return true;
    }
  } catch {}
  mlServiceAvailable = false;
  return false;
}

function sanitizeNum(v: any, fallback = 0): number {
  const n = Number(v);
  return isNaN(n) || !isFinite(n) ? fallback : n;
}

async function getMLPrediction(metrics: Record<string, number>): Promise<{ pumpProb: number; dumpRisk: number; version: string } | null> {
  if (!mlServiceAvailable) return null;
  const liq = sanitizeNum(metrics.liq);
  if (liq < 500) return null;
  try {
    const vol5m = sanitizeNum(metrics.vol5m);
    const vol1h = sanitizeNum(metrics.vol1h);
    const volMomentum = vol1h > 0 ? (vol5m * 12) / vol1h : 0;
    const fdv = sanitizeNum(metrics.fdv);

    const body = {
      age_seconds: sanitizeNum(metrics.ageSeconds, 99999),
      liquidity_usd: liq,
      volume_5m: vol5m,
      volume_1h: vol1h,
      volume_change_1m: sanitizeNum(volMomentum),
      price_change_5m: sanitizeNum(metrics.priceChange5m),
      price_change_1h: sanitizeNum(metrics.priceChange1h),
      buy_pressure_5m: sanitizeNum(metrics.buyPressure5m, 0.5),
      buy_pressure_1h: sanitizeNum(metrics.buyPressure1h, 0.5),
      buy_sell_ratio: sanitizeNum(metrics.h1buys, 0) / (sanitizeNum(metrics.h1sells, 0) + 0.001),
      tx_velocity_per_hour: sanitizeNum(metrics.txVelocity5m) * 12,
      fdv: fdv,
      liq_to_mcap: fdv > 0 ? liq / fdv : 0,
    };

    const resp = await fetch(`${engineSettings.mlServiceUrl}/predict`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(3000),
    });

    if (!resp.ok) return null;
    const data = await resp.json() as any;
    if (data.error) return null;
    const pumpProb = Math.max(0, Math.min(1, Number(data.pump_probability) || 0));
    const dumpRisk = Math.max(0, Math.min(1, Number(data.dump_risk) || 1));
    return { pumpProb, dumpRisk, version: data.model_version || "unknown" };
  } catch {
    return null;
  }
}

async function getMLBatchPredictions(tokenMetrics: Record<string, number>[]): Promise<(ReturnType<typeof getMLPrediction> extends Promise<infer T> ? T : never)[]> {
  if (!mlServiceAvailable || tokenMetrics.length === 0) return tokenMetrics.map(() => null);
  try {
    const validIndices: number[] = [];
    const tokens: any[] = [];
    for (let i = 0; i < tokenMetrics.length; i++) {
      const m = tokenMetrics[i];
      const liq = sanitizeNum(m.liq);
      if (liq < 500) continue;
      validIndices.push(i);
      const vol5m = sanitizeNum(m.vol5m);
      const vol1h = sanitizeNum(m.vol1h);
      const volMomentum = vol1h > 0 ? (vol5m * 12) / vol1h : 0;
      const fdv = sanitizeNum(m.fdv);
      tokens.push({
        age_seconds: sanitizeNum(m.ageSeconds, 99999),
        liquidity_usd: liq,
        volume_5m: vol5m,
        volume_1h: vol1h,
        volume_change_1m: sanitizeNum(volMomentum),
        price_change_5m: sanitizeNum(m.priceChange5m),
        price_change_1h: sanitizeNum(m.priceChange1h),
        buy_pressure_5m: sanitizeNum(m.buyPressure5m, 0.5),
        buy_pressure_1h: sanitizeNum(m.buyPressure1h, 0.5),
        buy_sell_ratio: sanitizeNum(m.h1buys, 0) / (sanitizeNum(m.h1sells, 0) + 0.001),
        tx_velocity_per_hour: sanitizeNum(m.txVelocity5m) * 12,
        fdv: fdv,
        liq_to_mcap: fdv > 0 ? liq / fdv : 0,
      });
    }
    if (tokens.length === 0) return tokenMetrics.map(() => null);

    const resp = await fetch(`${engineSettings.mlServiceUrl}/predict/batch`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tokens }),
      signal: AbortSignal.timeout(5000),
    });

    if (!resp.ok) return tokenMetrics.map(() => null);
    const data = await resp.json() as any;
    const preds = data.predictions || [];
    if (preds.length !== validIndices.length) {
      console.warn(`[ML] Batch response mismatch: expected ${validIndices.length}, got ${preds.length}`);
      return tokenMetrics.map(() => null);
    }
    const results: any[] = tokenMetrics.map(() => null);
    for (let j = 0; j < preds.length; j++) {
      const p = preds[j];
      if (p.error) continue;
      results[validIndices[j]] = {
        pumpProb: Math.max(0, Math.min(1, Number(p.pump_probability) || 0)),
        dumpRisk: Math.max(0, Math.min(1, Number(p.dump_risk) || 1)),
        version: p.model_version || "unknown",
      };
    }
    return results;
  } catch {
    return tokenMetrics.map(() => null);
  }
}

async function fetchTokenPrice(tokenAddress: string): Promise<{ price: number; pair: DexScreenerPair | null }> {
  try {
    const resp = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${tokenAddress}`);
    if (!resp.ok) return { price: 0, pair: null };
    const data = await resp.json() as any;
    const pairs = (data.pairs || []) as DexScreenerPair[];
    const solanaPair = pairs.find(p => p.chainId === "solana");
    if (!solanaPair) return { price: 0, pair: null };
    return { price: parseFloat(solanaPair.priceUsd || "0"), pair: solanaPair };
  } catch {
    return { price: 0, pair: null };
  }
}

function scoreToken(pair: DexScreenerPair, mlPrediction?: { pumpProb: number; dumpRisk: number; version: string } | null): {
  score: number;
  mlScore: number | null;
  combinedScore: number;
  breakdown: Record<string, number>;
  metrics: Record<string, number>;
  qualifiedMode: string | null;
  sizeSol: number;
  slippage: number;
} {
  const liq = pair.liquidity?.usd || 0;
  const createdAt = pair.pairCreatedAt || Date.now();
  const ageSeconds = Math.floor((Date.now() - createdAt) / 1000);
  const m5buys = pair.txns?.m5?.buys || 0;
  const m5sells = pair.txns?.m5?.sells || 0;
  const h1buys = pair.txns?.h1?.buys || 0;
  const h1sells = pair.txns?.h1?.sells || 0;
  const h24buys = pair.txns?.h24?.buys || 0;
  const h24sells = pair.txns?.h24?.sells || 0;
  const buyPressure5m = (m5buys + m5sells) > 0 ? m5buys / (m5buys + m5sells) : 0.5;
  const buyPressure1h = (h1buys + h1sells) > 0 ? h1buys / (h1buys + h1sells) : 0.5;
  const priceChange5m = pair.priceChange?.m5 || 0;
  const priceChange1h = pair.priceChange?.h1 || 0;
  const priceChange6h = pair.priceChange?.h6 || 0;
  const priceChange24h = pair.priceChange?.h24 || 0;
  const vol5m = pair.volume?.m5 || 0;
  const vol1h = pair.volume?.h1 || 0;
  const vol24h = pair.volume?.h24 || 0;
  const volMomentum = vol1h > 0 ? (vol5m * 12) / vol1h : 0;
  const txVelocity5m = m5buys + m5sells;
  const fdv = pair.fdv || 0;
  const mcap = pair.marketCap || 0;

  if (liq < 1000) return { score: 0, mlScore: null, combinedScore: 0, breakdown: {}, metrics: {}, qualifiedMode: null, sizeSol: 0, slippage: 0 };

  let breakdown: Record<string, number> = {};

  const bpScore = buyPressure5m > 0.7 ? 20 : buyPressure5m > 0.6 ? 15 : buyPressure5m > 0.55 ? 10 : buyPressure5m > 0.5 ? 5 : 0;
  breakdown.buyPressure = bpScore;

  const vmScore = volMomentum > 3 ? 20 : volMomentum > 2 ? 15 : volMomentum > 1.5 ? 10 : volMomentum > 1 ? 5 : 0;
  breakdown.volumeMomentum = vmScore;

  let trendScore = 0;
  if (priceChange5m > 10) trendScore += 8;
  else if (priceChange5m > 5) trendScore += 6;
  else if (priceChange5m > 2) trendScore += 3;
  else if (priceChange5m < -5) trendScore -= 5;
  if (priceChange1h > 20) trendScore += 7;
  else if (priceChange1h > 10) trendScore += 5;
  else if (priceChange1h > 0) trendScore += 2;
  else if (priceChange1h < -10) trendScore -= 5;
  breakdown.trend = Math.max(0, Math.min(15, trendScore));

  const txScore = txVelocity5m > 100 ? 15 : txVelocity5m > 50 ? 12 : txVelocity5m > 20 ? 8 : txVelocity5m > 10 ? 5 : 0;
  breakdown.txVelocity = txScore;

  let liqScore = 0;
  if (liq > 50000) liqScore = 10;
  else if (liq > 20000) liqScore = 8;
  else if (liq > 5000) liqScore = 6;
  else if (liq > 2000) liqScore = 4;
  breakdown.liquidity = liqScore;

  let freshScore = 0;
  if (ageSeconds < 60) freshScore = 10;
  else if (ageSeconds < 300) freshScore = 8;
  else if (ageSeconds < 900) freshScore = 5;
  else if (ageSeconds < 3600) freshScore = 3;
  breakdown.freshness = freshScore;

  let multiTfScore = 0;
  const alignedUp = (priceChange5m > 0 ? 1 : 0) + (priceChange1h > 0 ? 1 : 0) + (priceChange6h > 0 ? 1 : 0);
  if (alignedUp >= 3) multiTfScore = 10;
  else if (alignedUp >= 2 && priceChange5m > 0) multiTfScore = 7;
  else if (alignedUp >= 2) multiTfScore = 4;
  if (priceChange5m > 0 && priceChange1h > 0 && priceChange5m > priceChange1h / 12) multiTfScore += 3;
  breakdown.multiTimeframe = Math.min(10, multiTfScore);

  const totalScore = Object.values(breakdown).reduce((a, b) => a + b, 0);

  const metrics = {
    liq, ageSeconds, buyPressure5m, buyPressure1h, volMomentum,
    priceChange5m, priceChange1h, priceChange6h, priceChange24h,
    vol5m, vol1h, vol24h, txVelocity5m, fdv, mcap,
    m5buys, m5sells, h1buys, h1sells
  };

  const mlScore = mlPrediction ? Math.round(mlPrediction.pumpProb * 100) : null;

  let combinedScore: number;
  if (mlScore !== null) {
    combinedScore = Math.round(totalScore * engineSettings.scoreWeight + mlScore * engineSettings.mlWeight);
    if (mlScore >= 90 && totalScore >= 55) combinedScore = Math.max(combinedScore, totalScore + 15);
    else if (mlScore >= 80 && totalScore >= 50) combinedScore = Math.max(combinedScore, totalScore + 10);
    else if (mlScore >= 70 && totalScore >= 45) combinedScore = Math.max(combinedScore, totalScore + 5);
    if (mlScore < 25 && totalScore >= 60) combinedScore = Math.min(combinedScore, totalScore - 12);
  } else {
    combinedScore = totalScore;
  }

  const effectiveScore = combinedScore;

  let qualifiedMode: string | null = null;
  let sizeSol = 0;
  let slippage = 2;

  if (ageSeconds < engineSettings.sniperMaxAge && effectiveScore >= engineSettings.sniperMinScore && buyPressure5m > engineSettings.sniperMinBuyPressure && liq > engineSettings.sniperMinLiquidity) {
    qualifiedMode = "SNIPER";
    sizeSol = Math.min(engineSettings.sniperMaxSize, liq / 25000);
    slippage = liq < 20000 ? 15 : 10;
  } else if (effectiveScore >= engineSettings.mgMinScore && volMomentum > engineSettings.mgMinVolMomentum && priceChange5m > engineSettings.mgMinPriceChange5m && txVelocity5m > engineSettings.mgMinTxVelocity) {
    qualifiedMode = "MG";
    sizeSol = Math.min(engineSettings.mgMaxSize, liq / 40000);
    slippage = 5;
  } else if (effectiveScore >= engineSettings.hwrMinScore && buyPressure5m > engineSettings.hwrMinBuyPressure5m && buyPressure1h > engineSettings.hwrMinBuyPressure1h && liq > engineSettings.hwrMinLiquidity) {
    qualifiedMode = "HWR";
    sizeSol = Math.min(engineSettings.hwrMaxSize, liq / 60000);
    slippage = 3;
  }

  if (effectiveScore >= 90) sizeSol *= 2.2;
  else if (effectiveScore >= 85) sizeSol *= 1.8;
  else if (effectiveScore >= 80) sizeSol *= 1.4;

  if (consecutiveWins >= 5) sizeSol *= 1.5;
  else if (consecutiveWins >= 3) sizeSol *= 1.3;
  if (consecutiveLosses >= 3) sizeSol *= 0.5;

  sizeSol = Math.min(engineSettings.maxPositionSize, Math.max(engineSettings.minPositionSize, Math.round(sizeSol * 1000) / 1000));

  return { score: totalScore, mlScore, combinedScore, breakdown, metrics, qualifiedMode, sizeSol, slippage };
}

function getScoreBasedTP(score: number): number {
  if (score >= 90) return 100;
  if (score >= 80) return 80;
  if (score >= 70) return 65;
  return engineSettings.hardTakeProfit;
}

async function fetchDexScreenerCandidates(): Promise<any[]> {
  const now = Date.now();
  if (now - lastScanTime < 5000 && liveCandidatesCache.length > 0) {
    return liveCandidatesCache;
  }

  try {
    const searchQueries = ["pump", "moon", "sol new", "meme solana", "solana trending", "degen sol", "gem solana", "new pair sol"];
    const allPairs: DexScreenerPair[] = [];

    const fetchPromises = [
      fetch("https://api.dexscreener.com/token-profiles/latest/v1").then(r => r.ok ? r.json() : []).catch(() => []),
      fetch("https://api.dexscreener.com/token-boosts/top/v1").then(r => r.ok ? r.json() : []).catch(() => []),
      ...searchQueries.map(q =>
        fetch(`https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(q)}`)
          .then(r => r.ok ? r.json() : { pairs: [] })
          .catch(() => ({ pairs: [] }))
      ),
    ];

    const [profiles, boosted, ...searchResults] = await Promise.all(fetchPromises);

    for (const sr of searchResults) {
      if (sr.pairs) {
        const solanaPairs = (sr.pairs as DexScreenerPair[])
          .filter(p => p.chainId === "solana" && (p.liquidity?.usd || 0) > 800)
          .slice(0, 15);
        allPairs.push(...solanaPairs);
      }
    }

    const solanaProfiles = ((profiles as any[]) || [])
      .filter((t: any) => t.chainId === "solana")
      .slice(0, 15);

    const boostedTokens = ((boosted as any[]) || [])
      .filter((t: any) => t.chainId === "solana")
      .slice(0, 10);

    const results: any[] = [];
    const seenAddresses = new Set<string>();

    const dedupedPairs: DexScreenerPair[] = [];
    for (const sp of allPairs) {
      if (seenAddresses.has(sp.baseToken.address)) continue;
      seenAddresses.add(sp.baseToken.address);
      dedupedPairs.push(sp);
    }

    const pairMetrics = dedupedPairs.map(sp => {
      const scoring = scoreToken(sp);
      return scoring.metrics;
    });
    const mlPredictions = await getMLBatchPredictions(pairMetrics);

    for (let idx = 0; idx < dedupedPairs.length; idx++) {
      const sp = dedupedPairs[idx];
      const mlPred = mlPredictions[idx] || null;
      const scoring = scoreToken(sp, mlPred);
      const liq = sp.liquidity?.usd || 0;
      const createdAt = sp.pairCreatedAt || Date.now();
      const ageSeconds = Math.floor((Date.now() - createdAt) / 1000);

      results.push({
        tokenAddress: sp.baseToken.address,
        tokenSymbol: sp.baseToken.symbol,
        tokenName: sp.baseToken.name,
        dex: sp.dexId,
        price: sp.priceUsd || "0",
        liquidity: liq.toFixed(0),
        score: scoring.combinedScore,
        mlScore: scoring.mlScore,
        ruleScore: scoring.score,
        pumpProbability: (scoring.combinedScore / 100).toFixed(3),
        dumpRisk: (1 - scoring.combinedScore / 100).toFixed(3),
        ageSeconds,
        qualifiedMode: scoring.qualifiedMode,
        volume5m: (sp.volume?.m5 || 0).toFixed(0),
        volume1h: (sp.volume?.h1 || 0).toFixed(0),
        volume24h: (sp.volume?.h24 || 0).toFixed(0),
        priceChange5m: sp.priceChange?.m5 || 0,
        priceChange1h: sp.priceChange?.h1 || 0,
        buys5m: sp.txns?.m5?.buys || 0,
        sells5m: sp.txns?.m5?.sells || 0,
        buys1h: sp.txns?.h1?.buys || 0,
        sells1h: sp.txns?.h1?.sells || 0,
        buyPressure5m: scoring.metrics.buyPressure5m?.toFixed(3) || "0.500",
        fdv: sp.fdv || 0,
        marketCap: sp.marketCap || 0,
        mlActive: mlPred !== null,
        source: "dexscreener_live",
        timestamp: new Date().toISOString(),
      });
    }

    const allProfiles = [...solanaProfiles, ...boostedTokens];
    for (const profile of allProfiles) {
      if (seenAddresses.has(profile.tokenAddress)) continue;
      try {
        const { price, pair } = await fetchTokenPrice(profile.tokenAddress);
        if (!pair) continue;

        const mlPred = await getMLPrediction(scoreToken(pair).metrics);
        const scoring = scoreToken(pair, mlPred);
        const liq = pair.liquidity?.usd || 0;
        const createdAt = pair.pairCreatedAt || Date.now();
        const ageSeconds = Math.floor((Date.now() - createdAt) / 1000);
        seenAddresses.add(profile.tokenAddress);

        results.push({
          tokenAddress: pair.baseToken.address,
          tokenSymbol: pair.baseToken.symbol,
          tokenName: pair.baseToken.name,
          dex: pair.dexId,
          price: pair.priceUsd || "0",
          liquidity: liq.toFixed(0),
          score: scoring.combinedScore,
          mlScore: scoring.mlScore,
          ruleScore: scoring.score,
          pumpProbability: (scoring.combinedScore / 100).toFixed(3),
          dumpRisk: (1 - scoring.combinedScore / 100).toFixed(3),
          ageSeconds,
          qualifiedMode: scoring.qualifiedMode,
          volume5m: (pair.volume?.m5 || 0).toFixed(0),
          volume1h: (pair.volume?.h1 || 0).toFixed(0),
          volume24h: (pair.volume?.h24 || 0).toFixed(0),
          priceChange5m: pair.priceChange?.m5 || 0,
          priceChange1h: pair.priceChange?.h1 || 0,
          buys5m: pair.txns?.m5?.buys || 0,
          sells5m: pair.txns?.m5?.sells || 0,
          buys1h: pair.txns?.h1?.buys || 0,
          sells1h: pair.txns?.h1?.sells || 0,
          buyPressure5m: scoring.metrics.buyPressure5m?.toFixed(3) || "0.500",
          fdv: pair.fdv || 0,
          marketCap: pair.marketCap || 0,
          mlActive: mlPred !== null,
          source: "dexscreener_live",
          timestamp: new Date().toISOString(),
        });
      } catch {
        continue;
      }
    }

    results.sort((a, b) => (b.score || 0) - (a.score || 0));

    if (results.length > 0) {
      liveCandidatesCache = results;
      lastScanTime = now;
    }
    return liveCandidatesCache;
  } catch (e) {
    console.error("DexScreener fetch error:", e);
    return liveCandidatesCache;
  }
}

async function initBalanceFromDB() {
  if (balanceInitialized) return;
  const status = await storage.getBotStatus();
  const storedBalance = parseFloat(status.walletBalance || "0");
  if (storedBalance > 0) {
    paperBalance = storedBalance;
    dailyStartBalance = paperBalance;
    peakBalance = paperBalance;
    circuitBreakerActive = false;
    console.log(`[ENGINE] Restored wallet balance from DB: ${paperBalance.toFixed(3)} SOL`);
  }
  const openTrades = await storage.getOpenTrades();
  for (const t of openTrades) {
    tradedAddresses.set(t.tokenAddress, new Date(t.timestamp).getTime());
    if (t.peakPrice) {
      peakPrices.set(t.id, parseFloat(t.peakPrice));
    }
  }
  balanceInitialized = true;
}

async function runScanCycle() {
  if (scanLock) return;
  scanLock = true;
  try {
    await initBalanceFromDB();

    const cleanupThreshold = engineSettings.reentryDelayMs * 3;
    const now = Date.now();
    for (const [addr, ts] of tradedAddresses) {
      if (now - ts > cleanupThreshold) tradedAddresses.delete(addr);
    }

    const status = await storage.getBotStatus();
    if (!status.isRunning) { scanLock = false; return; }

    const riskCheck = await checkCircuitBreakers();
    if (!riskCheck.canTrade) {
      scanLock = false;
      return;
    }

    const openTrades = await storage.getOpenTrades();
    if (openTrades.length >= engineSettings.maxOpenPositions) { scanLock = false; return; }

    const candidates = await fetchDexScreenerCandidates();

    const openAddresses = new Set(openTrades.map((t: any) => t.tokenAddress));
    const boughtThisCycle = new Set<string>();
    let currentOpenCount = openTrades.length;
    let tradesThisCycle = 0;

    for (const candidate of candidates) {
      const addr = candidate.tokenAddress;
      if (boughtThisCycle.has(addr)) continue;
      const lastTraded = tradedAddresses.get(addr);
      if (lastTraded && (Date.now() - lastTraded) < engineSettings.reentryDelayMs) continue;
      if (openAddresses.has(addr)) continue;
      if (currentOpenCount >= engineSettings.maxOpenPositions) break;
      if (tradesThisCycle >= engineSettings.maxTradesPerCycle) break;

      const { price, pair } = await fetchTokenPrice(candidate.tokenAddress);
      if (!pair || price <= 0) continue;

      const mlPred = await getMLPrediction(scoreToken(pair).metrics);
      const scoring = scoreToken(pair, mlPred);
      if (!scoring.qualifiedMode || scoring.combinedScore < engineSettings.minScoreToTrade || scoring.sizeSol < engineSettings.minPositionSize) continue;

      if (status.mode !== "AUTO" && scoring.qualifiedMode !== status.mode) continue;

      if (paperBalance < scoring.sizeSol) continue;

      paperBalance -= scoring.sizeSol;
      tradedAddresses.set(addr, Date.now());
      openAddresses.add(addr);
      boughtThisCycle.add(addr);
      currentOpenCount++;
      tradesThisCycle++;
      dailyTradeCount++;
      totalTradesAllTime++;

      const trade = await storage.addTrade({
        tokenAddress: candidate.tokenAddress,
        tokenSymbol: candidate.tokenSymbol,
        type: "BUY",
        mode: scoring.qualifiedMode,
        tradingMode: status.tradingMode || "paper",
        status: "OPEN",
        amount: scoring.sizeSol.toFixed(3),
        price: price.toString(),
        currentPrice: price.toString(),
        peakPrice: price.toString(),
        pnl: "0",
        peakPnl: "0",
        score: scoring.combinedScore.toString(),
        txHash: `paper_${Date.now().toString(36)}_${candidate.tokenAddress.substring(0, 6)}`,
      });

      peakPrices.set(trade.id, price);

      const mlTag = scoring.mlScore !== null ? ` | ML: ${scoring.mlScore}%` : " | ML: offline";
      console.log(`[SNIPER] BUY $${candidate.tokenSymbol} @ $${price.toFixed(8)} | ${scoring.qualifiedMode} | Score: ${scoring.combinedScore}/100 (Rule:${scoring.score} + ML:${scoring.mlScore ?? 'N/A'}) | Size: ${scoring.sizeSol} SOL | Bal: ${paperBalance.toFixed(3)}`);
      console.log(`  Breakdown: BP=${scoring.breakdown.buyPressure} VM=${scoring.breakdown.volumeMomentum} TR=${scoring.breakdown.trend} TX=${scoring.breakdown.txVelocity} LQ=${scoring.breakdown.liquidity} FR=${scoring.breakdown.freshness} MTF=${scoring.breakdown.multiTimeframe}${mlTag}`);

      const allTrades = await storage.getTrades();
      const closedTrades = allTrades.filter((t: any) => t.status === "CLOSED");
      const wins = closedTrades.filter((t: any) => parseFloat(t.pnl || "0") > 0).length;
      const wr = closedTrades.length > 0 ? ((wins / closedTrades.length) * 100).toFixed(1) : "0";

      const mlLabel = scoring.mlScore !== null ? ` [ML:${scoring.mlScore}%]` : "";
      await storage.updateBotStats({
        walletBalance: paperBalance.toFixed(3),
        totalTrades: allTrades.length,
        openPositions: currentOpenCount,
        winRate: wr,
        lastSignal: `BUY $${candidate.tokenSymbol} via ${scoring.qualifiedMode} (Score: ${scoring.combinedScore})${mlLabel}`,
      });
    }
  } catch (e) {
    console.error("[SCANNER] Error:", e);
  } finally {
    scanLock = false;
  }
}

async function checkOpenPositions() {
  try {
    const openTrades = await storage.getOpenTrades();
    if (openTrades.length === 0) return;

    for (const trade of openTrades) {
      try {
      const { price: currentPrice, pair } = await fetchTokenPrice(trade.tokenAddress);
      if (currentPrice <= 0) continue;

      const entryPrice = parseFloat(trade.price);
      if (entryPrice <= 0) continue;

      let pnlPct = ((currentPrice - entryPrice) / entryPrice) * 100;
      const MAX_REALISTIC_PNL = 500;
      if (pnlPct > MAX_REALISTIC_PNL) {
        console.log(`[TRADE] SUSPICIOUS PNL $${trade.tokenSymbol} | +${pnlPct.toFixed(1)}% exceeds ${MAX_REALISTIC_PNL}% cap — likely bad price data, capping`);
        pnlPct = MAX_REALISTIC_PNL;
      }
      const holdTime = (Date.now() - new Date(trade.timestamp).getTime()) / 1000;
      const tradeScore = parseInt(trade.score || "0");
      const dynamicTP = getScoreBasedTP(tradeScore);

      let peak = peakPrices.get(trade.id) || entryPrice;
      if (currentPrice > peak) {
        peak = currentPrice;
        peakPrices.set(trade.id, peak);
      }
      const peakPnl = ((peak - entryPrice) / entryPrice) * 100;
      const drawdownFromPeak = peak > 0 ? ((peak - currentPrice) / peak) * 100 : 0;

      await storage.updateTradeCurrentPrice(trade.id, currentPrice.toString(), pnlPct.toFixed(2));
      await storage.updateTradePeakPrice(trade.id, peak.toString(), peakPnl.toFixed(2));

      if (!partialTpTaken.has(trade.id) && pnlPct >= engineSettings.partialTpThreshold && pnlPct < dynamicTP) {
        const sizeSol = parseFloat(trade.amount);
        const partialSize = sizeSol * engineSettings.partialTpRatio;
        const partialReturn = partialSize * (1 + pnlPct / 100);
        paperBalance += partialReturn;
        partialTpTaken.add(trade.id);
        dailyPnlSol += partialReturn - partialSize;

        const newAmount = (sizeSol - partialSize).toFixed(3);
        await storage.updateTradeAmount(trade.id, newAmount);

        console.log(`[TRADE] PARTIAL TP $${trade.tokenSymbol} | Sold ${engineSettings.partialTpRatio * 100}% @ +${pnlPct.toFixed(1)}% | Secured: ${partialReturn.toFixed(3)} SOL | Remaining: ${newAmount} SOL`);
      }

      let shouldClose = false;
      let reason = "";

      const trailingFloor = peakPnl > 20 ? peakPnl * 0.40
        : peakPnl > 10 ? peakPnl * 0.30
        : peakPnl > 5 ? peakPnl * 0.20
        : 0;

      if (pnlPct >= dynamicTP) {
        shouldClose = true;
        reason = "HARD_TP";
      } else if (peakPnl >= engineSettings.trailingStopActivation && drawdownFromPeak >= engineSettings.trailingStopDistance) {
        if (pnlPct < trailingFloor) {
          pnlPct = trailingFloor;
          console.log(`[TRADE] TRAILING FLOOR $${trade.tokenSymbol} | Peak +${peakPnl.toFixed(1)}% → locked exit at +${trailingFloor.toFixed(1)}% (prevented loss on winning trade)`);
        }
        shouldClose = true;
        reason = `TRAIL_STOP (peak +${peakPnl.toFixed(1)}%, fell ${drawdownFromPeak.toFixed(1)}%)`;
      } else if (pnlPct <= engineSettings.stopLoss) {
        shouldClose = true;
        reason = "STOP_LOSS";
      } else if (holdTime > engineSettings.maxHoldSeconds && pnlPct < 5) {
        shouldClose = true;
        reason = "MAX_HOLD";
      } else if (holdTime > engineSettings.maxHoldSeconds / 2 && pnlPct < -4) {
        shouldClose = true;
        reason = "EARLY_CUT";
      } else if (holdTime > 120 && pnlPct < -6) {
        shouldClose = true;
        reason = "FAST_CUT";
      }

      if (pair && pnlPct > 3 && holdTime > 45) {
        const m5buys = pair.txns?.m5?.buys || 0;
        const m5sells = pair.txns?.m5?.sells || 0;
        const currentBP = (m5buys + m5sells) > 0 ? m5buys / (m5buys + m5sells) : 0.5;
        const priceChange5m = pair.priceChange?.m5 || 0;
        if (currentBP < 0.35 && priceChange5m < -3) {
          shouldClose = true;
          reason = `MOMENTUM_FADE (BP=${currentBP.toFixed(2)}, Δ5m=${priceChange5m.toFixed(1)}%)`;
        }
      }

      if (shouldClose) {
        const sizeSol = parseFloat(trade.amount);
        let exitPnlPct = pnlPct;
        if (pnlPct < 0) {
          exitPnlPct = Math.max(pnlPct, engineSettings.stopLoss);
        }
        const returnSol = sizeSol * (1 + exitPnlPct / 100);
        paperBalance += returnSol;
        dailyPnlSol += returnSol - sizeSol;
        pnlPct = exitPnlPct;

        if (paperBalance > peakBalance) peakBalance = paperBalance;

        const isWin = pnlPct > 0;
        if (isWin) {
          consecutiveWins++;
          consecutiveLosses = 0;
        } else {
          consecutiveLosses++;
          consecutiveWins = 0;
          if (consecutiveLosses >= 3) {
            lastLossCooldownEnd = Date.now() + engineSettings.lossCooldownMs;
            console.log(`[RISK] 3 consecutive losses — ${engineSettings.lossCooldownMs / 1000}s cooldown activated`);
          }
        }

        await storage.closeTrade(trade.id, currentPrice.toString(), pnlPct.toFixed(2), reason);
        tradedAddresses.set(trade.tokenAddress, Date.now());
        peakPrices.delete(trade.id);
        partialTpTaken.delete(trade.id);

        const emoji = isWin ? "+" : "";
        console.log(`[TRADE] ${isWin ? "WIN" : "LOSS"} SELL $${trade.tokenSymbol} @ $${currentPrice.toFixed(8)} | PNL: ${emoji}${pnlPct.toFixed(2)}% | Peak: +${peakPnl.toFixed(1)}% | ${reason} | Bal: ${paperBalance.toFixed(3)} SOL`);

        const allTrades = await storage.getTrades();
        const closedTrades = allTrades.filter((t: any) => t.status === "CLOSED");
        const wins = closedTrades.filter((t: any) => parseFloat(t.pnl || "0") > 0).length;
        const totalPnl = closedTrades.reduce((sum: number, t: any) => sum + parseFloat(t.pnl || "0"), 0);
        const wr = closedTrades.length > 0 ? ((wins / closedTrades.length) * 100).toFixed(1) : "0";
        const openNow = allTrades.filter((t: any) => t.status === "OPEN").length;

        await storage.updateBotStats({
          walletBalance: paperBalance.toFixed(3),
          totalPnl: (totalPnl / Math.max(closedTrades.length, 1)).toFixed(2),
          winRate: wr,
          totalTrades: allTrades.length,
          openPositions: openNow,
          lastSignal: `SOLD $${trade.tokenSymbol} | ${emoji}${pnlPct.toFixed(1)}% | ${reason}`,
        });
      }
      } catch (tradeErr) {
        console.error(`[POSITION_MANAGER] Error processing $${trade.tokenSymbol}:`, tradeErr);
      }
    }
  } catch (e) {
    console.error("[POSITION_MANAGER] Error:", e);
  }
}

async function startTradingEngine() {
  if (scannerInterval) clearInterval(scannerInterval);
  if (priceCheckerInterval) clearInterval(priceCheckerInterval);

  console.log("[ENGINE] ULTRA SNIPER ENGINE v4.0 + ML starting...");
  console.log(`[ENGINE] Trailing Stop: activates +${engineSettings.trailingStopActivation}%, trails ${engineSettings.trailingStopDistance}% | Dynamic TP: +${engineSettings.hardTakeProfit}-80% | SL: ${engineSettings.stopLoss}%`);
  console.log(`[ENGINE] Max Hold: ${engineSettings.maxHoldSeconds}s | Max Positions: ${engineSettings.maxOpenPositions} | Min Score: ${engineSettings.minScoreToTrade}/100`);
  console.log(`[ENGINE] Score Blend: Rule ${engineSettings.scoreWeight * 100}% + ML ${engineSettings.mlWeight * 100}%`);
  console.log(`[ENGINE] Partial TP: ${engineSettings.partialTpRatio * 100}% @ +${engineSettings.partialTpThreshold}% | Daily Loss Limit: ${engineSettings.dailyLossLimitPct}% | Max DD: ${engineSettings.maxDrawdownPct}%`);
  console.log(`[ENGINE] Scan: ${engineSettings.scanIntervalMs / 1000}s | Price Check: ${engineSettings.priceCheckIntervalMs / 1000}s`);

  const mlUp = await checkMLService();
  if (mlUp) {
    console.log("[ENGINE] ML Service connected — XGBoost predictions active");
  } else {
    console.log("[ENGINE] ML Service not available — running on rule-based scoring only");
  }

  setInterval(checkMLService, 30000);

  scannerInterval = setInterval(runScanCycle, engineSettings.scanIntervalMs);
  priceCheckerInterval = setInterval(checkOpenPositions, engineSettings.priceCheckIntervalMs);

  setTimeout(runScanCycle, 3000);
  setTimeout(checkOpenPositions, 8000);
}

export async function registerRoutes(
  httpServer: Server,
  app: Express
): Promise<Server> {

  await storage.seedInitialData();

  startTradingEngine();

  app.get(api.status.get.path, async (req, res) => {
    const status = await storage.getBotStatus();
    res.json(status);
  });

  app.get(api.trades.list.path, async (req, res) => {
    const tradesList = await storage.getTrades();
    res.json(tradesList);
  });

  app.get(api.candidates.list.path, async (req, res) => {
    const candidatesList = await storage.getCandidates();
    res.json(candidatesList);
  });

  app.get("/api/candidates/live", async (_req, res) => {
    try {
      const live = await fetchDexScreenerCandidates();
      res.json(live);
    } catch (e) {
      console.error("Live candidates error:", e);
      res.json([]);
    }
  });

  app.get("/api/trades/open", async (_req, res) => {
    const open = await storage.getOpenTrades();
    res.json(open);
  });

  app.get("/api/engine/stats", async (_req, res) => {
    const allTrades = await storage.getTrades();
    const closedTrades = allTrades.filter((t: any) => t.status === "CLOSED");
    const openTrades = allTrades.filter((t: any) => t.status === "OPEN");
    const wins = closedTrades.filter((t: any) => parseFloat(t.pnl || "0") > 0);
    const losses = closedTrades.filter((t: any) => parseFloat(t.pnl || "0") <= 0);
    const avgWin = wins.length > 0 ? wins.reduce((s: number, t: any) => s + parseFloat(t.pnl || "0"), 0) / wins.length : 0;
    const avgLoss = losses.length > 0 ? losses.reduce((s: number, t: any) => s + parseFloat(t.pnl || "0"), 0) / losses.length : 0;
    const totalPnlSol = closedTrades.reduce((s: number, t: any) => {
      const size = parseFloat(t.amount || "0");
      const pnl = parseFloat(t.pnl || "0");
      return s + (size * pnl / 100);
    }, 0);
    const bestTrade = closedTrades.length > 0 ? closedTrades.reduce((best: any, t: any) => parseFloat(t.pnl || "0") > parseFloat(best?.pnl || "-999") ? t : best, closedTrades[0]) : null;
    const worstTrade = closedTrades.length > 0 ? closedTrades.reduce((worst: any, t: any) => parseFloat(t.pnl || "0") < parseFloat(worst?.pnl || "999") ? t : worst, closedTrades[0]) : null;

    const uptimeSeconds = Math.floor((Date.now() - engineStartTime) / 1000);
    const solPerHour = uptimeSeconds > 0 ? (dailyPnlSol / (uptimeSeconds / 3600)).toFixed(4) : "0";

    res.json({
      totalTrades: allTrades.length,
      closedTrades: closedTrades.length,
      openTrades: openTrades.length,
      wins: wins.length,
      losses: losses.length,
      winRate: closedTrades.length > 0 ? ((wins.length / closedTrades.length) * 100).toFixed(1) : "0",
      avgWinPct: avgWin.toFixed(2),
      avgLossPct: avgLoss.toFixed(2),
      totalPnlSol: totalPnlSol.toFixed(4),
      bestTrade: bestTrade ? { symbol: bestTrade.tokenSymbol, pnl: bestTrade.pnl, mode: bestTrade.mode } : null,
      worstTrade: worstTrade ? { symbol: worstTrade.tokenSymbol, pnl: worstTrade.pnl, mode: worstTrade.mode } : null,
      consecutiveWins,
      consecutiveLosses,
      paperBalance: paperBalance.toFixed(3),
      engineVersion: "4.0+ML",
      mlServiceActive: mlServiceAvailable,
      scoreBlend: `Rule ${engineSettings.scoreWeight * 100}% + ML ${engineSettings.mlWeight * 100}%`,
      trailingStop: `+${engineSettings.trailingStopActivation}% / -${engineSettings.trailingStopDistance}%`,
      hardTP: `+${engineSettings.hardTakeProfit}-80%`,
      stopLoss: `${engineSettings.stopLoss}%`,
      solPerHour,
      uptimeSeconds,
      dailyPnlSol: dailyPnlSol.toFixed(4),
      dailyTradeCount,
      peakBalance: peakBalance.toFixed(3),
      drawdownPct: peakBalance > 0 ? Math.max(0, (peakBalance - (await getEffectiveBalance())) / peakBalance * 100).toFixed(1) : "0",
      circuitBreakerActive,
      dailyLossLimitPct: engineSettings.dailyLossLimitPct,
      maxDrawdownPct: engineSettings.maxDrawdownPct,
    });
  });

  app.get("/api/engine/risk-status", async (_req, res) => {
    const riskCheck = await checkCircuitBreakers();
    const effectiveBal = await getEffectiveBalance();
    const drawdownPct = peakBalance > 0 ? ((peakBalance - effectiveBal) / peakBalance * 100) : 0;
    const realizedLossPct = dailyPnlSol < 0 && dailyStartBalance > 0
      ? (Math.abs(dailyPnlSol) / dailyStartBalance * 100) : 0;

    res.json({
      canTrade: riskCheck.canTrade,
      reason: riskCheck.reason,
      circuitBreakerActive,
      drawdownPct: Math.max(0, drawdownPct).toFixed(1),
      dailyLossPct: realizedLossPct.toFixed(1),
      dailyLossLimitPct: engineSettings.dailyLossLimitPct,
      maxDrawdownPct: engineSettings.maxDrawdownPct,
      peakBalance: peakBalance.toFixed(3),
      dailyStartBalance: dailyStartBalance.toFixed(3),
      consecutiveLosses,
      cooldownActive: Date.now() < lastLossCooldownEnd,
      cooldownRemainingMs: Math.max(0, lastLossCooldownEnd - Date.now()),
    });
  });

  app.get("/api/settings", async (_req, res) => {
    res.json(engineSettings);
  });

  app.post("/api/settings", async (req, res) => {
    try {
      const updates = req.body;
      if (!updates || typeof updates !== "object") {
        return res.status(400).json({ message: "Invalid settings payload" });
      }

      const validKeys = Object.keys(engineSettings) as (keyof typeof engineSettings)[];
      let restartIntervals = false;

      const minValues: Record<string, number> = {
        scanIntervalMs: 1000, priceCheckIntervalMs: 1000, reentryDelayMs: 0,
        lossCooldownMs: 0, maxHoldSeconds: 10, maxOpenPositions: 1,
        maxTradesPerCycle: 1, minScoreToTrade: 0, startingBalance: 0.1,
        minPositionSize: 0.01, maxPositionSize: 0.1,
      };
      const maxValues: Record<string, number> = {
        mlWeight: 1, scoreWeight: 1, partialTpRatio: 1,
        dailyLossLimitPct: 100, maxDrawdownPct: 100,
      };

      for (const key of validKeys) {
        if (key in updates) {
          const newVal = updates[key];
          const currentType = typeof engineSettings[key];
          if (currentType === "number" && typeof newVal === "number" && isFinite(newVal)) {
            let clamped = newVal;
            if (key in minValues) clamped = Math.max(clamped, minValues[key]);
            if (key in maxValues) clamped = Math.min(clamped, maxValues[key]);
            (engineSettings as any)[key] = clamped;
            if (key === "scanIntervalMs" || key === "priceCheckIntervalMs") {
              restartIntervals = true;
            }
          } else if (currentType === "string" && typeof newVal === "string") {
            (engineSettings as any)[key] = newVal;
          }
        }
      }

      if (restartIntervals) {
        if (scannerInterval) clearInterval(scannerInterval);
        if (priceCheckerInterval) clearInterval(priceCheckerInterval);
        scannerInterval = setInterval(runScanCycle, engineSettings.scanIntervalMs);
        priceCheckerInterval = setInterval(checkOpenPositions, engineSettings.priceCheckIntervalMs);
        console.log(`[ENGINE] Intervals restarted: scan=${engineSettings.scanIntervalMs}ms, price=${engineSettings.priceCheckIntervalMs}ms`);
      }

      console.log(`[SETTINGS] Updated engine settings:`, JSON.stringify(updates));
      res.json(engineSettings);
    } catch (e) {
      console.error("[SETTINGS] Error:", e);
      res.status(500).json({ message: "Failed to update settings" });
    }
  });

  app.post("/api/bot/force-sell-all", async (_req, res) => {
    try {
      const openTrades = await storage.getOpenTrades();
      let closedCount = 0;

      for (const trade of openTrades) {
        const { price: currentPrice } = await fetchTokenPrice(trade.tokenAddress);
        if (currentPrice <= 0) continue;

        const entryPrice = parseFloat(trade.price);
        const pnlPct = entryPrice > 0 ? ((currentPrice - entryPrice) / entryPrice) * 100 : 0;
        const sizeSol = parseFloat(trade.amount);
        const returnSol = sizeSol * (1 + pnlPct / 100);
        paperBalance += returnSol;
        dailyPnlSol += returnSol - sizeSol;

        if (paperBalance > peakBalance) peakBalance = paperBalance;

        await storage.closeTrade(trade.id, currentPrice.toString(), pnlPct.toFixed(2), "FORCE_SELL");
        tradedAddresses.set(trade.tokenAddress, Date.now());
        peakPrices.delete(trade.id);
        partialTpTaken.delete(trade.id);
        closedCount++;

        console.log(`[FORCE] Sold $${trade.tokenSymbol} @ $${currentPrice.toFixed(8)} | PNL: ${pnlPct.toFixed(2)}%`);
      }

      await storage.updateBotStats({
        walletBalance: paperBalance.toFixed(3),
        openPositions: 0,
        lastSignal: `Force sold ${closedCount} positions`,
      });

      res.json({ success: true, closedCount, newBalance: paperBalance.toFixed(3) });
    } catch (e) {
      console.error("[FORCE_SELL] Error:", e);
      res.status(500).json({ success: false, error: "Failed to force sell" });
    }
  });

  app.post("/api/bot/reset-balance", async (_req, res) => {
    try {
      const openTrades = await storage.getOpenTrades();
      for (const trade of openTrades) {
        await storage.closeTrade(trade.id, trade.currentPrice || trade.price, "0", "RESET");
        tradedAddresses.set(trade.tokenAddress, Date.now());
        peakPrices.delete(trade.id);
        partialTpTaken.delete(trade.id);
      }

      paperBalance = engineSettings.startingBalance;
      peakBalance = engineSettings.startingBalance;
      dailyStartBalance = engineSettings.startingBalance;
      dailyPnlSol = 0;
      dailyTradeCount = 0;
      consecutiveWins = 0;
      consecutiveLosses = 0;
      circuitBreakerActive = false;
      lastLossCooldownEnd = 0;

      await storage.updateBotStats({
        walletBalance: engineSettings.startingBalance.toFixed(3),
        totalPnl: "0",
        openPositions: 0,
        lastSignal: `Balance reset to ${engineSettings.startingBalance} SOL`,
      });

      console.log(`[ENGINE] Paper balance reset to ${engineSettings.startingBalance} SOL`);
      res.json({ success: true, newBalance: engineSettings.startingBalance.toFixed(3) });
    } catch (e) {
      console.error("[RESET] Error:", e);
      res.status(500).json({ success: false, error: "Failed to reset" });
    }
  });

  app.post("/api/bot/trading-mode", async (req, res) => {
    const { mode, confirmed } = req.body;
    if (!mode || !["paper", "live"].includes(mode)) {
      return res.status(400).json({ message: "Invalid trading mode. Use 'paper' or 'live'." });
    }
    if (mode === "live" && !confirmed) {
      return res.status(400).json({ message: "Live trading requires explicit confirmation. Set confirmed: true." });
    }
    const status = await storage.updateTradingMode(mode);
    res.json(status);
  });

  app.post("/api/bot/toggle", async (req, res) => {
    const { isRunning } = req.body;
    if (typeof isRunning !== "boolean") {
      return res.status(400).json({ message: "isRunning must be boolean" });
    }
    if (isRunning) {
      circuitBreakerActive = false;
      lastLossCooldownEnd = 0;
    }
    const status = await storage.updateBotRunning(isRunning);
    res.json(status);
  });

  app.post("/api/bot/strategy-mode", async (req, res) => {
    const { mode } = req.body;
    if (!mode || !["SNIPER", "MG", "HWR", "AUTO"].includes(mode)) {
      return res.status(400).json({ message: "Invalid strategy mode" });
    }
    const status = await storage.updateStrategyMode(mode);
    res.json(status);
  });

  return httpServer;
}
