const fs = require('fs');
const path = require('path');

const target = path.join(__dirname, 'server', 'gold_standard_hunter.ts');
let s = fs.readFileSync(target, 'utf8');

const birdeyeFeedBlock = `
// ─────────────────────────────────────────────────────────────────────────────
// 8. BIRDEYE TRENDING FEED (The God-Tier Source)
// ─────────────────────────────────────────────────────────────────────────────

export async function pollBirdeyeTrending(): Promise<GoldSignal[]> {
  const results: GoldSignal[] = [];
  try {
    const key = process.env.BIRDEYE_API_KEY || (process.env.BIRDEYE_KEYS ? process.env.BIRDEYE_KEYS.split(',')[0] : '');
    const headers: any = { "Accept": "application/json", "x-chain": "solana" };
    if (key) headers["X-API-KEY"] = key.trim();

    const res = await fetch("https://public-api.birdeye.so/public/trending?list_address=solana", { 
        headers,
        signal: AbortSignal.timeout(8000)
    });
    
    if (res.ok) {
        const json = await res.json();
        const tokens = json?.data?.tokens || [];
        
        const batchResults = await Promise.all(
            tokens.slice(0, 10).map((t: any) => scoreToken(t.address, 'TRENDING'))
        );
        
        for (const sig of batchResults) {
            if (sig) {
                sig.signals.unshift('🔥 BIRDEYE TRENDING TOP 10');
                results.push(sig);
            }
        }
    }
  } catch (e) {
      console.warn("Birdeye trending fetch failed in hunter:", e);
  }
  return results;
}
`;

s = s.replace(
  /\/\/ 7\. MASTER HUNTER/,
  birdeyeFeedBlock + "\n\n// ─────────────────────────────────────────────────────────────────────────────\n// 7. MASTER HUNTER"
);

const newRunHunterPromises = `
  // Run all hunters in parallel
  const [signalResults, clusterResults, trendingResults, trenchesResults, dexResults, birdeyeTrendResults] =
    await Promise.allSettled([
      pollSignalFeed(),
      pollSmartMoneyFeed(),
      pollTrending(),
      pollTrenches(),
      pollDexScreenerFeeds(),
      pollBirdeyeTrending()
    ]);

  if (signalResults.status  === 'fulfilled') addUnique(signalResults.value);
  if (clusterResults.status === 'fulfilled') addUnique(clusterResults.value);
  if (trendingResults.status === 'fulfilled') addUnique(trendingResults.value);
  if (trenchesResults.status === 'fulfilled') addUnique(trenchesResults.value);
  if (dexResults.status     === 'fulfilled') addUnique(dexResults.value);
  if (birdeyeTrendResults.status === 'fulfilled') addUnique(birdeyeTrendResults.value);
`;

s = s.replace(
  /\/\/ Run all hunters in parallel\s+const \[signalResults.*?addUnique\(dexResults\.value\);/s,
  newRunHunterPromises
);

fs.writeFileSync(target, s, 'utf8');
console.log("Injected Birdeye Trending into gold_standard_hunter.ts");
