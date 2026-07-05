import { pollTrending, pollSmartMoneyFeed } from './server/gold_standard_hunter.ts';

async function simulate() {
  console.log("==================================================");
  console.log("🚀 STARTING GOD-TIER FREQUENCY SIMULATION 🚀");
  console.log("Simulating a 1-minute engine cycle with strict >90 safety gate...");
  console.log("==================================================\n");

  const startTime = Date.now();
  
  console.log("[1] Polling GMGN Trending Feed...");
  const trendingCoins = await pollTrending();
  console.log(`    -> Fetched ${trendingCoins.length} pre-vetted trending coins.`);

  console.log("[2] Polling GMGN Smart Money Feed...");
  const smartMoneyCoins = await pollSmartMoneyFeed();
  console.log(`    -> Fetched ${smartMoneyCoins.length} smart money clustered coins.\n`);

  const allCoins = [...trendingCoins, ...smartMoneyCoins];
  
  // Deduplicate by mintAddress
  const uniqueMints = new Map();
  for (const c of allCoins) {
    if (!uniqueMints.has(c.mintAddress)) {
      uniqueMints.set(c.mintAddress, c);
    }
  }

  const uniqueCoins = Array.from(uniqueMints.values());
  console.log(`[3] Deduplicated to ${uniqueCoins.length} unique candidates.`);

  let passingCoins = 0;
  console.log("\n[4] Running candidates through the 90+ Score Gauntlet:");
  
  for (const coin of uniqueCoins) {
    if (coin.score >= 90) {
      passingCoins++;
      console.log(`    ✅ PASS: ${coin.mintAddress.slice(0,6)}... | Score: ${coin.score} | Tier: ${coin.tier} | Signals: ${coin.signals.length}`);
    } else {
      console.log(`    ❌ FAIL: ${coin.mintAddress.slice(0,6)}... | Score: ${coin.score} | Tier: ${coin.tier}`);
      console.log(`       -> Signals: ${JSON.stringify(coin.signals)}`);
    }
  }

  const elapsedMs = Date.now() - startTime;
  
  console.log("\n==================================================");
  console.log(`⏱️ SIMULATION COMPLETE in ${(elapsedMs/1000).toFixed(2)} seconds`);
  console.log(`📈 Expected Frequency: ${passingCoins} strictly safe trades per engine cycle (approx 1 min).`);
  console.log(`🔥 Projected Daily Trades: ${passingCoins * 60 * 24}`);
  console.log("==================================================");
}

simulate().catch(console.error);
