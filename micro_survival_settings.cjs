const fs = require('fs');
const path = require('path');
const file = path.resolve('server', 'routes.ts');
let s = fs.readFileSync(file, 'utf8');

const replacements = [
  { regex: /microMinScoreToTrade:\s*\d+,/g, replace: 'microMinScoreToTrade: 90,' },
  { regex: /minScoreToTrade:\s*\d+,/g, replace: 'minScoreToTrade: 90,' },
  { regex: /sniperMinScore:\s*\d+,/g, replace: 'sniperMinScore: 85,' },
  { regex: /maxEntryPriceChange5m:\s*\d+,/g, replace: 'maxEntryPriceChange5m: 10,' },
  { regex: /maxOpenPositions:\s*\d+,/g, replace: 'maxOpenPositions: 1,' },
  { regex: /maxPositionSize:\s*[\d\.]+,/g, replace: 'maxPositionSize: 0.015,' },
  { regex: /minPositionSize:\s*[\d\.]+,/g, replace: 'minPositionSize: 0.005,' },
  { regex: /stopLoss:\s*-?\d+,/g, replace: 'stopLoss: -5,' },
  { regex: /trailingStopDistance:\s*\d+,/g, replace: 'trailingStopDistance: 5,' },
  { regex: /microMinEdgePct:\s*-?[\d\.]+,/g, replace: 'microMinEdgePct: 5.0,' }
];

let changed = 0;
for (const r of replacements) {
  if (s.match(r.regex)) {
    s = s.replace(r.regex, r.replace);
    changed++;
  }
}

fs.writeFileSync(file, s, 'utf8');
console.log(`Applied Micro-Survival profile safely. ${changed} settings updated.`);
