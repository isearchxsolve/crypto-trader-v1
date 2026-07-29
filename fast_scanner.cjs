
require('dotenv').config();
const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');

const HELIUS_RPC = process.env.SOLANA_RPC_URL;
const HELIUS_WSS = HELIUS_RPC ? HELIUS_RPC.replace('https://', 'wss://') : '';
const CANDIDATES_FILE = path.join(__dirname, 'candidates.csv');

// FREQ(2026-06-29): Added missing config that was causing broken polling (NaN delay, undefined URL)
const POLL_INTERVAL_MS = 8000;
const GT_HOST = 'api.geckoterminal.com';
const _dexAllowAll = true;
const _dexAllow = [];

// Verified Solana program IDs (post-graduation venues only)
const RAYDIUM_AMM_V4 = '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8';
const PUMPSWAP_AMM  = 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA';

// Filter thresholds (pre-filter; engine backend EDGE_POCKET_ONLY + scorer provide final safety)
const MIN_LP_USD = 0;           // SCANNER-RELAX(2026-06-29): 1000->0. Engine's 80x dynamic liq floor gates final entry.
const MIN_AGE_HOURS = 0;
const MAX_AGE_HOURS = 72;
const MIN_VOL_LIQ_RATIO = 0.5;  // SCANNER-RELAX(2026-06-29): 1.0->0.5. Quieter tokens still need scorer eval.
const MAX_VOL_LIQ_RATIO = 20;   // SCANNER-RELAX(2026-06-29): 10->20. Less aggressive wash pre-cut.
const MAX_TOP_HOLDER_PCT = 25;  // SCANNER-RELAX(2026-06-29): 15->25. LP-inclusive cap looser.
const MAX_TOP10_HOLDERS_PCT = 60; // SCANNER-RELAX(2026-06-29): 50->60.

const SOL_MINT = 'So11111111111111111111111111111111111111112';

if (!fs.existsSync(CANDIDATES_FILE)) {
    fs.writeFileSync(CANDIDATES_FILE,
        'timestamp,mint,rugcheck_score,liq_usd,age_hours,top1_pct,top10_pct,vol_liq_ratio,dexscreener_url\n');
}

function log(msg) { console.log(`[${new Date().toISOString()}] ${msg}`); }

async function rugcheckPass(mint) {
    try {
        const r = await fetch(`https://api.rugcheck.xyz/v1/tokens/${mint}/report/summary`);
        if (!r.ok) return { pass: false, reason: `rugcheck http ${r.status}` };
        const d = await r.json();
        if (d.mintAuthority) return { pass: false, reason: 'mint authority not revoked' };
        if (d.freezeAuthority) return { pass: false, reason: 'freeze authority not revoked' };
        // SCANNER-RELAX(2026-06-29): RugCheck risk levels bypassed — engine's own rugcheck score + EDGE_POCKET_ONLY handle final vetting
        return { pass: true, score: d.score ?? 0 };
    } catch (e) { return { pass: false, reason: `rugcheck err: ${e.message}` }; }
}

async function dexscreenerPass(mint) {
    try {
        const r = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${mint}`);
        if (!r.ok) return { pass: false, reason: `dex http ${r.status}` };
        const d = await r.json();
        const sol = (d.pairs || []).filter(p => p.chainId === 'solana');
        if (!sol.length) return { pass: false, reason: 'no solana pair' };
        const best = sol.sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0))[0];
        const liq = best.liquidity?.usd || 0;
        const vol = best.volume?.h24 || 0;
        const ageH = best.pairCreatedAt ? (Date.now() - best.pairCreatedAt) / 3600000 : 99999;
        const ratio = liq > 0 ? vol / liq : 0;
        if (liq < MIN_LP_USD)      return { pass: false, reason: `liq $${liq.toFixed(0)} < $${MIN_LP_USD}` };
        if (ageH < MIN_AGE_HOURS)  return { pass: false, reason: `age ${ageH.toFixed(1)}h < ${MIN_AGE_HOURS}h` };
        if (ageH > MAX_AGE_HOURS)  return { pass: false, reason: `age ${ageH.toFixed(1)}h > ${MAX_AGE_HOURS}h` };
        if (ratio < MIN_VOL_LIQ_RATIO) return { pass: false, reason: `vol/liq ${ratio.toFixed(2)} (dead)` };
        if (ratio > MAX_VOL_LIQ_RATIO) return { pass: false, reason: `vol/liq ${ratio.toFixed(2)} (wash)` };
        return { pass: true, liq, ageH, ratio, url: best.url };
    } catch (e) { return { pass: false, reason: `dex err: ${e.message}` }; }
}

async function holderPass(mint) {
    try {
        const lg = await (await fetch(HELIUS_RPC, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getTokenLargestAccounts', params: [mint] })
        })).json();
        const accs = lg.result?.value || [];
        if (accs.length < 10) return { pass: false, reason: 'too few large holders' };
        const sup = await (await fetch(HELIUS_RPC, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getTokenSupply', params: [mint] })
        })).json();
        const total = Number(sup.result?.value?.amount || 0);
        if (!total) return { pass: false, reason: 'zero supply' };
        const top1  = (Number(accs[0].amount) / total) * 100;
        const top10 = accs.slice(0, 10).reduce((s, a) => s + Number(a.amount), 0) / total * 100;
        if (top1  > MAX_TOP_HOLDER_PCT)   return { pass: false, reason: `top1 ${top1.toFixed(1)}%` };
        if (top10 > MAX_TOP10_HOLDERS_PCT) return { pass: false, reason: `top10 ${top10.toFixed(1)}%` };
        return { pass: true, top1, top10 };
    } catch (e) { return { pass: false, reason: `holder err: ${e.message}` }; }
}

const seen = new Set();
const processed = new Map();
const q = [];
let busy = false;
const SCAN_COOLDOWN_MS = 300_000;
const CANDIDATE_TTL_MS = 3_600_000;

function candidateKey(mint) { return mint.toLowerCase(); }

function isFresh(mint) {
  const key = candidateKey(mint);
  const lastSeen = processed.get(key);
  if (!lastSeen) return true;
  return (Date.now() - lastSeen) < SCAN_COOLDOWN_MS;
}

function markProcessed(mint) {
  const key = candidateKey(mint);
  processed.set(key, Date.now());
  if (processed.size > 5000) {
    const cutoff = Date.now() - CANDIDATE_TTL_MS;
    for (const [k, t] of processed) { if (t < cutoff) processed.delete(k); }
  }
}

function scoreCandidate(liq, ageH, ratio, top1, top10) {
  let score = 0;
  if (liq >= 25000) score += 30;
  else if (liq >= 10000) score += 20;
  else if (liq >= 5000) score += 10;
  if (ageH >= 1 && ageH <= 24) score += 25;
  else if (ageH < 1) score += 15;
  if (ratio >= 1 && ratio <= 10) score += 25;
  if (top1 < 10) score += 10;
  if (top10 < 40) score += 10;
  return Math.min(score, 100);
}

async function evaluate(mint) {
    const key = candidateKey(mint);
    if (seen.has(key)) return;
    if (!isFresh(key)) return;
    markProcessed(key);
    log(`Evaluating ${mint}`);
    const a = await rugcheckPass(mint);
    if (!a.pass) { log(`  RugCheck: ${a.reason}`); return; }
    const b = await dexscreenerPass(mint);
    if (!b.pass) { log(`  DexScreener: ${b.reason}`); return; }
    const c = await holderPass(mint);
    if (!c.pass) { log(`  Holders: ${c.reason}`); return; }
    const score = scoreCandidate(b.liq, b.ageH, b.ratio, c.top1, c.top10);
    const row = [
        new Date().toISOString(), mint, score.toFixed(0),
        b.liq.toFixed(0), b.ageH.toFixed(1),
        c.top1.toFixed(1), c.top10.toFixed(1),
        b.ratio.toFixed(2), b.url
    ].join(',') + '\n';
    fs.appendFileSync(CANDIDATES_FILE, row);
    log(`★ CANDIDATE [score=${score}] ${mint} | LP $${b.liq.toFixed(0)} | age ${b.ageH.toFixed(1)}h | ${b.url}`);
}

async function drain() {
    if (busy) return; busy = true;
    while (q.length) {
        const m = q.shift();
        if (seen.has(m)) continue;
        seen.add(m);
        try { await evaluate(m); } catch (e) { log(`eval err: ${e.message}`); }
        await new Promise(r => setTimeout(r, 200));
    }
    busy = false;
}

// WSS Removed, exclusively using HTTP polling



// GeckoTerminal polling removed (2026-06-29): free tier rate limit incompatible with scan cycles.
// DexScreener new pairs below provides sufficient discovery without 429s.

// FREQ(2026-06-29): DexScreener token-profiles + top boosts (two discovery feeds)
async function pollDexPairs() {
    try {
        const [profilesRes, boostsRes] = await Promise.all([
            fetch("https://api.dexscreener.com/token-profiles/latest/v1", { signal: AbortSignal.timeout(10000) }).catch(() => null),
            fetch("https://api.dexscreener.com/token-boosts/top/v1", { signal: AbortSignal.timeout(10000) }).catch(() => null),
        ]);
        let n = 0;
        if (profilesRes && profilesRes.ok) {
            const profiles = await profilesRes.json();
            if (Array.isArray(profiles)) {
                for (const p of profiles) {
                    const mint = p?.tokenAddress;
                    if (!mint || mint.length < 32 || seen.has(mint)) continue;
                    if (p?.chainId !== 'solana') continue;
                    q.push(mint); n++;
                }
            }
        }
        if (boostsRes && boostsRes.ok) {
            const boosts = await boostsRes.json();
            if (Array.isArray(boosts)) {
                for (const b of boosts) {
                    const mint = b?.tokenAddress;
                    if (!mint || mint.length < 32 || seen.has(mint)) continue;
                    if (b?.chainId !== 'solana') continue;
                    q.push(mint); n++;
                }
            }
        }
        if (n) { log("DexScreener discovery: " + n + " mint(s) queued"); drain(); }
    } catch (e) {
        log("dex-pairs poll err: " + e.message);
    }
    setTimeout(pollDexPairs, POLL_INTERVAL_MS * 3 + Math.floor(Math.random() * 3000));
}

pollDexPairs(); // DexScreener search only — GeckoTerminal removed for persistent 429
