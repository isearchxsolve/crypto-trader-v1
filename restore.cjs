const fs = require('fs');

// 1. Fix fast_scanner.cjs
let fsCode = fs.readFileSync('fast_scanner.cjs', 'utf8');
fsCode = fsCode.replace(/const MIN_LP_USD = \d+;/, 'const MIN_LP_USD = 10000;');
fsCode = fsCode.replace(/const MIN_AGE_HOURS = \d+;/, 'const MIN_AGE_HOURS = 0;');
fsCode = fsCode.replace(/const MAX_AGE_HOURS = \d+;/, 'const MAX_AGE_HOURS = 72;');
fsCode = fsCode.replace(/const MIN_VOL_LIQ_RATIO = [\d\.]+;/, 'const MIN_VOL_LIQ_RATIO = 1.0;');
fsCode = fsCode.replace(/const MAX_TOP_HOLDER_PCT = \d+;/, 'const MAX_TOP_HOLDER_PCT = 15;');
fsCode = fsCode.replace(/const MAX_TOP10_HOLDERS_PCT = \d+;/, 'const MAX_TOP10_HOLDERS_PCT = 50;');

// Remove websockets logic
fsCode = fsCode.replace(/function extractMints[\s\S]*?connect\(PUMPSWAP_AMM\);/, '// WSS Removed, exclusively using HTTP polling');

// 2. Add HTTP polling back if it's not there
const trendingBlock = '\n\n// -- REST polling discovery via GeckoTerminal trending-pools --\n' +
'async function pollTrendingPools() {\n' +
'    let nextDelay = POLL_INTERVAL_MS * 2; // Poll trending every 16s\n' +
'    try {\n' +
'        const url = "https://" + GT_HOST + "/api/v2/networks/solana/trending_pools?page=1";\n' +
'        const r = await fetch(url, { headers: { "Accept": "application/json" } });\n' +
'        if (r.status === 429) {\n' +
'            log("GeckoTerminal 429 (trending)");\n' +
'        } else if (r.ok) {\n' +
'            const d = await r.json();\n' +
'            const pools = d?.data || [];\n' +
'            let n = 0;\n' +
'            for (const p of pools) {\n' +
'                const baseId = p?.relationships?.base_token?.data?.id || "";\n' +
'                const mint = baseId.indexOf("solana_") === 0 ? baseId.slice(7) : "";\n' +
'                const dexId = (p?.relationships?.dex?.data?.id || "").toLowerCase();\n' +
'                if (!mint || mint === SOL_MINT || mint.length < 32 || seen.has(mint)) continue;\n' +
'                if (!_dexAllowAll && !_dexAllow.some(a => dexId.includes(a))) continue;\n' +
'                log("Queued trending pool mint: " + mint);\n' +
'                q.push(mint); n++;\n' +
'            }\n' +
'            if (n) { log("GeckoTerminal Trending: " + n + " mint(s) queued"); drain(); }\n' +
'        }\n' +
'    } catch (e) {\n' +
'        log("trending-pools poll err: " + e.message);\n' +
'    } finally {\n' +
'        setTimeout(pollTrendingPools, nextDelay + Math.floor(Math.random() * 1000));\n' +
'    }\n' +
'}\n' +
'pollTrendingPools();\n';

if (!fsCode.includes('pollTrendingPools')) {
    fsCode += trendingBlock;
}

fs.writeFileSync('fast_scanner.cjs', fsCode);

// 3. Fix gold_standard_hunter.ts
let gsCode = fs.readFileSync('server/gold_standard_hunter.ts', 'utf8');
gsCode = gsCode.replace('MIN_LIQUIDITY_USD:    50_000,', 'MIN_LIQUIDITY_USD:    15_000,');
gsCode = gsCode.replace('MIN_HOLDER_COUNT:     1_000,', 'MIN_HOLDER_COUNT:     300,');
gsCode = gsCode.replace('MAX_TOKEN_AGE_HOURS:  6,', 'MAX_TOKEN_AGE_HOURS:  72,');
gsCode = gsCode.replace(/--limit 100/g, '--limit 300');
gsCode = gsCode.replace(/--limit 50/g, '--limit 200');

gsCode = gsCode.replace('const ratRate = g.stat.rat_trader_amount_rate ?? 1;', 'const ratRate = g.stat.rat_trader_amount_rate ?? 0;');
gsCode = gsCode.replace('} else if (buyRatio < 0.50) {', '} else if (buyRatio < 0.40) {');
gsCode = gsCode.replace('} else if (capEff < 50) {', '} else if (capEff < 20) {');

const ageOld = '  if (ageH < 1) {\n' +
'    score += 15; signals.push(Age min [<1h FIRE] (+15));\n' +
'  } else if (ageH < 6) {\n' +
'    score += 10; signals.push(Age h [<6h, 2.33x ratio] (+10));\n' +
'  } else if (ageH > 24) {\n' +
'    score -= 5;  signals.push(Age h [stale, -5]);\n' +
'  }';

const ageNew = '  if (ageH < 1) {\n' +
'    score += 15; signals.push(Age min [<1h FIRE] (+15));\n' +
'  } else if (ageH < CFG.MAX_TOKEN_AGE_HOURS) {\n' +
'    const ageRatio = CFG.MAX_TOKEN_AGE_HOURS / Math.max(1, ageH);\n' +
'    if (ageRatio > 2) {\n' +
'      score += 10; signals.push(Age h [<h, x ratio] (+10));\n' +
'    } else {\n' +
'      score += 5;  signals.push(Age h [<h] (+5));\n' +
'    }\n' +
'  } else {\n' +
'    score -= 5;  signals.push(Age h [stale, -5]);\n' +
'  }';

gsCode = gsCode.replace(ageOld, ageNew);
fs.writeFileSync('server/gold_standard_hunter.ts', gsCode);
console.log('Restored all evening changes perfectly.');
