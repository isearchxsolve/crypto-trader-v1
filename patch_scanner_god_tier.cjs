const fs = require('fs');
const path = require('path');

const target = path.join(__dirname, 'fast_scanner.cjs');
let s = fs.readFileSync(target, 'utf8');

// 1. Tune Constants
s = s.replace(/const MIN_LP_USD = 50000;/g, 'const MIN_LP_USD = 10000;');
s = s.replace(/const MIN_VOL_LIQ_RATIO = 1;/g, 'const MIN_VOL_LIQ_RATIO = 1.0;');
s = s.replace(/const MAX_TOP_HOLDER_PCT = 20;/g, 'const MAX_TOP_HOLDER_PCT = 15;');
s = s.replace(/const MAX_TOP10_HOLDERS_PCT = 60;/g, 'const MAX_TOP10_HOLDERS_PCT = 50;');

// 2. Rewrite Evaluate
const oldEvaluate = `async function evaluate(mint) {
    const row = [
        new Date().toISOString(), mint, '0', '0', '0', '0', '0', '0', 'none'
    ].join(',') + '\\n';
    fs.appendFileSync(CANDIDATES_FILE, row);
    log(\`★ FAST INJECT: \${mint} | Queued to engine in milliseconds!\`);
}`;

const newEvaluate = `async function evaluate(mint) {
    const rDex = await dexscreenerPass(mint);
    if (!rDex.pass) return log(\`eval fail [dex]: \${mint} - \${rDex.reason}\`);
    
    const rRug = await rugcheckPass(mint);
    if (!rRug.pass) return log(\`eval fail [rug]: \${mint} - \${rRug.reason}\`);
    
    const rHold = await holderPass(mint);
    if (!rHold.pass) return log(\`eval fail [hold]: \${mint} - \${rHold.reason}\`);

    const row = [
        new Date().toISOString(), mint, rRug.score, rDex.liq.toFixed(0), 
        rDex.ageH.toFixed(2), rHold.top1.toFixed(1), rHold.top10.toFixed(1), 
        rDex.ratio.toFixed(2), rDex.url
    ].join(',') + '\\n';
    fs.appendFileSync(CANDIDATES_FILE, row);
    log(\`★ FAST INJECT (GOD-TIER): \${mint} | Vol/Liq: \${rDex.ratio.toFixed(1)}x | Liq: $\${rDex.liq.toFixed(0)}\`);
}`;

s = s.replace(oldEvaluate, newEvaluate);

// 3. Rewrite Drain
const oldDrain = `async function drain() {
    if (busy) return; busy = true;
    while (q.length) {
        const m = q.shift();
        if (seen.has(m)) continue;
        seen.add(m);
        try { await evaluate(m); } catch (e) { log(\`eval err: \${e.message}\`); }
        await new Promise(r => setTimeout(r, 600));
    }
    busy = false;
}`;

const newDrain = `async function drain() {
    if (busy) return; busy = true;
    const batch = [];
    while (q.length && batch.length < 20) {
        const m = q.shift();
        if (seen.has(m)) continue;
        seen.add(m);
        batch.push(m);
    }
    if (batch.length > 0) {
        await Promise.allSettled(batch.map(m => evaluate(m).catch(e => log(\`eval err: \${e.message}\`))));
    }
    busy = false;
    if (q.length > 0) setTimeout(drain, 100);
}`;

s = s.replace(oldDrain, newDrain);

// 4. Re-append Trending
const trendingBlock = `

// ── REST polling discovery via GeckoTerminal trending-pools ──
async function pollTrendingPools() {
    let nextDelay = POLL_INTERVAL_MS * 2; // Poll trending every 16s
    try {
        const url = 'https://' + GT_HOST + '/api/v2/networks/solana/trending_pools?page=1';
        const r = await fetch(url, { headers: { 'Accept': 'application/json' } });
        if (r.status === 429) {
            log('GeckoTerminal 429 (trending)');
        } else if (r.ok) {
            const d = await r.json();
            const pools = d?.data || [];
            let n = 0;
            for (const p of pools) {
                const baseId = p?.relationships?.base_token?.data?.id || '';
                const mint = baseId.indexOf('solana_') === 0 ? baseId.slice(7) : '';
                const dexId = (p?.relationships?.dex?.data?.id || '').toLowerCase();
                if (!mint || mint === SOL_MINT || mint.length < 32 || seen.has(mint)) continue;
                if (!_dexAllowAll && !_dexAllow.some(a => dexId.includes(a))) continue;
                log('Queued trending pool mint: ' + mint);
                q.push(mint); n++;
            }
            if (n) { log('GeckoTerminal Trending: ' + n + ' mint(s) queued'); drain(); }
        }
    } catch (e) {
        log('trending-pools poll err: ' + e.message);
    } finally {
        setTimeout(pollTrendingPools, nextDelay + Math.floor(Math.random() * 1000));
    }
}
pollTrendingPools();
`;

if (!s.includes('pollTrendingPools')) {
    s += trendingBlock;
}

fs.writeFileSync(target, s, 'utf8');
console.log("God-Tier patch applied successfully!");
