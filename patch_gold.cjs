const fs = require('fs');
let s = fs.readFileSync('server/gold_standard_hunter.ts', 'utf8');

s = s.replace('MIN_LIQUIDITY_USD:    50_000,', 'MIN_LIQUIDITY_USD:    15_000,   // AI-TUNED');
s = s.replace('MIN_HOLDER_COUNT:     1_000,', 'MIN_HOLDER_COUNT:     300,      // AI-TUNED');
s = s.replace('MAX_TOKEN_AGE_HOURS:  6,', 'MAX_TOKEN_AGE_HOURS:  72,       // AI-TUNED');
s = s.replace(/--limit 100/g, '--limit 300');
s = s.replace(/--limit 50/g, '--limit 200');
s = s.replace(/--max-created 6h/g, '--max-created ${CFG.MAX_TOKEN_AGE_HOURS}h');

s = s.replace('const ratRate = g.stat.rat_trader_amount_rate ?? 1;', 'const ratRate = g.stat.rat_trader_amount_rate ?? 0;');
s = s.replace('} else if (buyRatio < 0.50) {', '} else if (buyRatio < 0.40) {');
s = s.replace('} else if (capEff < 50) {', '} else if (capEff < 20) {');

const ageOld =   if (ageH < 1) {
    score += 15; signals.push(\Age \min [<1h FIRE] (+15)\);
  } else if (ageH < 6) {
    score += 10; signals.push(\Age \h [<6h, 2.33x ratio] (+10)\);
  } else if (ageH > 24) {
    score -= 5;  signals.push(\Age \h [stale, -5]\);
  };

const ageNew =   if (ageH < 1) {
    score += 15; signals.push(\Age \min [<1h FIRE] (+15)\);
  } else if (ageH < CFG.MAX_TOKEN_AGE_HOURS) {
    const ageRatio = CFG.MAX_TOKEN_AGE_HOURS / Math.max(1, ageH);
    if (ageRatio > 2) {
      score += 10; signals.push(\Age \h [<\h, \x ratio] (+10)\);
    } else {
      score += 5;  signals.push(\Age \h [<\h] (+5)\);
    }
  } else {
    score -= 5;  signals.push(\Age \h [stale, -5]\);
  };
s = s.replace(ageOld, ageNew);

fs.writeFileSync('server/gold_standard_hunter.ts', s);
console.log('gold_standard_hunter.ts patched perfectly!');
