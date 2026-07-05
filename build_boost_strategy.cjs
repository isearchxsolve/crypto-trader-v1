const fs = require('fs');
const path = require('path');
const file = path.resolve('server', 'routes.ts');
let s = fs.readFileSync(file, 'utf8');

// 1. Tag boosted tokens
s = s.replace(
    /const hydrated = await throttledDexScreenerFetch\(\`https:\/\/api\.dexscreener\.com\/latest\/dex\/tokens\/\$\{chunk\}\`\);\s*dexResults\.push\(hydrated\);/g,
    `const hydrated = await throttledDexScreenerFetch(\`https://api.dexscreener.com/latest/dex/tokens/\${chunk}\`);
                if (hydrated && Array.isArray(hydrated.pairs)) {
                    hydrated.pairs.forEach(p => p.isBoosted = true);
                }
                dexResults.push(hydrated);`
);

// 2. Add BOOSTED mode logic to scoring
const scoreGateLogic = `let qualifiedMode: string | null = null, sizeSol = 0, slippage = 0, rejectionReason = "";`;
const boostedLogic = `
  // -- NEW STRATEGY: BOOSTED/TRENDING --
  // If a token was flagged as Boosted or Trending from DexScreener/Birdeye APIs, we apply a custom,
  // high-frequency strategy. We bypass the extreme generic volume checks and buy it immediately
  // as long as it has positive buy pressure.
  if (pair.isBoosted) {
      candidates.push({ mode: "BOOSTED", minScore: 60, sizeSol: engineSettings.mgMaxSize, slippage: 3 });
  }

  let qualifiedMode: string | null = null, sizeSol = 0, slippage = 0, rejectionReason = "";
`;
s = s.replace(scoreGateLogic, boostedLogic);

// 3. Make BOOSTED pass the minimum score check by giving it a massive bonus
const ageScoreLogic = `const ageScore = ageSeconds < 60 ? 10 : ageSeconds <= 300 ? 8 : ageSeconds <= 600 ? 6 : ageSeconds <= 1800 ? 4 : ageSeconds <= 3600 ? 2 : 0;`;
const bonusScoreLogic = `const ageScore = ageSeconds < 60 ? 10 : ageSeconds <= 300 ? 8 : ageSeconds <= 600 ? 6 : ageSeconds <= 1800 ? 4 : ageSeconds <= 3600 ? 2 : 0;
  const boostBonus = pair.isBoosted ? 35 : 0; // Huge score boost for officially trending/boosted coins`;
s = s.replace(ageScoreLogic, bonusScoreLogic);

const rawTotalLogic = `const rawTotal = liqScore + bpScore + volScore + priceScore + txScore + ageScore + bp1hScore + fdvScore;`;
const rawTotalBonusLogic = `const rawTotal = liqScore + bpScore + volScore + priceScore + txScore + ageScore + bp1hScore + fdvScore + boostBonus;`;
s = s.replace(rawTotalLogic, rawTotalBonusLogic);

// 4. Change minimum score back to 70 in getEffectiveMinScore so we don't accidentally buy garbage
s = s.replace(/minScoreToTrade: \d+,/g, 'minScoreToTrade: 70,');
s = s.replace(/microMinScoreToTrade: \d+,/g, 'microMinScoreToTrade: 70,');

fs.writeFileSync(file, s, 'utf8');
console.log('Built Boosted Strategy');
