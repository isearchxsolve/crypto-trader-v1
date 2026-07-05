const fs = require('fs');
const path = require('path');

const target = path.join(__dirname, 'server', 'gold_standard_hunter.ts');
let s = fs.readFileSync(target, 'utf8');

// 1. Revert the ?? 0 fallback to ?? -1 (so missing data gets NO bonus, preventing the loophole)
s = s.replace(/const ratRate = g\.stat\.rat_trader_amount_rate \?\? 0;/, 'const ratRate = g.stat.top_rat_trader_percentage ? parseFloat(g.stat.top_rat_trader_percentage.toString()) : -1;');

// 2. We need to handle ratRate = -1 so it gives 0 points.
// Currently it is:
// if (ratRate < 0.01) { score += 12 ...
// If ratRate = -1, it will trigger `< 0.01` and give 12 points!
// We MUST explicitly check ratRate >= 0
s = s.replace(/if \(ratRate < 0\.01\) \{[\s\S]*?\} else if \(ratRate < 0\.03\)/, 
`if (ratRate >= 0 && ratRate < 0.01) {
    score += 12; signals.push(\`RatRate \${(ratRate*100).toFixed(1)}% [12.5x edge] (+12)\`);
  } else if (ratRate >= 0 && ratRate < 0.03)`);

// 3. Fix the buyRatio penalty back to < 0.50 for dumping protection
s = s.replace(/} else if \(buyRatio < 0\.40\) {/, '} else if (buyRatio < 0.50) {');

fs.writeFileSync(target, s, 'utf8');
console.log("Safety loop closed and correct RatRate variable mapped!");
