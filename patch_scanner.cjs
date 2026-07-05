const fs = require('fs');
const path = require('path');

const target = path.join(__dirname, 'fast_scanner.cjs');

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

fs.appendFileSync(target, trendingBlock);
console.log("Appended pollTrendingPools to fast_scanner.cjs");
