const fs = require('fs');
const path = require('path');

const target = path.join('server', 'routes.ts');
const full = path.resolve(process.cwd(), target);

let s = fs.readFileSync(full, 'utf8');

const replacements = [
  { regex: /minScoreToTrade:\s*\d+,/g, replace: 'minScoreToTrade: 40,' },
  { regex: /microMinScoreToTrade:\s*\d+,/g, replace: 'microMinScoreToTrade: 40,' },
  { regex: /sniperMinScore:\s*\d+,/g, replace: 'sniperMinScore: 40,' },
  { regex: /sniperMinBuyPressure:\s*[\d\.]+,/g, replace: 'sniperMinBuyPressure: 0.30,' },
  { regex: /sniperMinLiquidity:\s*\d+,/g, replace: 'sniperMinLiquidity: 2000,' },
  { regex: /mgMinScore:\s*\d+,/g, replace: 'mgMinScore: 40,' },
  { regex: /hwrMinScore:\s*\d+,/g, replace: 'hwrMinScore: 40,' },
  { regex: /maxEntryPriceChange5m:\s*\d+,/g, replace: 'maxEntryPriceChange5m: 50,' },
  { regex: /maxOpenPositions:\s*\d+,/g, replace: 'maxOpenPositions: 3,' },
  { regex: /scanIntervalMs:\s*\d+,/g, replace: 'scanIntervalMs: 5000,' },
  { regex: /hwrMinLiquidity:\s*\d+,/g, replace: 'hwrMinLiquidity: 2000,' }
];

let changed = 0;
for (const r of replacements) {
  if (s.match(r.regex)) {
    s = s.replace(r.regex, r.replace);
    changed++;
  } else {
    console.warn("Could not match regex: ", r.regex);
  }
}

fs.writeFileSync(full, s, 'utf8');
console.log(`Boosted frequency on ${changed} settings in routes.ts.`);
