const fs = require('fs');
const path = require('path');

const target = path.join('server', 'routes.ts');
const full = path.resolve(process.cwd(), target);

let s = fs.readFileSync(full, 'utf8');

const replacements = [
  { regex: /trailingStopActivation:\s*15,.*$/m, replace: 'trailingStopActivation: 10, // HARDENED: earlier activation' },
  { regex: /trailingStopDistance:\s*8,.*$/m, replace: 'trailingStopDistance: 4, // HARDENED: tighter trailing distance' },
  { regex: /hardTakeProfit:\s*80,.*$/m, replace: 'hardTakeProfit: 250, // HARDENED: Let massive runners reach for 1000x' },
  { regex: /stopLoss:\s*-8,.*$/m, replace: 'stopLoss: -4, // HARDENED: Exceptionally tight stop loss to enforce high win rate' },
  { regex: /minScoreToTrade:\s*90,.*$/m, replace: 'minScoreToTrade: 95, // HARDENED: Supreme quality entries only' },
  { regex: /microMinScoreToTrade:\s*55,.*$/m, replace: 'microMinScoreToTrade: 95, // HARDENED: Supreme quality' },
  { regex: /sniperMinScore:\s*70,.*$/m, replace: 'sniperMinScore: 85, // HARDENED: High conviction' },
  { regex: /sniperMinBuyPressure:\s*0\.65,.*$/m, replace: 'sniperMinBuyPressure: 0.75, // HARDENED: Overwhelming buy pressure required' },
  { regex: /mgMinScore:\s*55,.*$/m, replace: 'mgMinScore: 75, // HARDENED' },
  { regex: /hwrMinScore:\s*55,.*$/m, replace: 'hwrMinScore: 75, // HARDENED' },
  { regex: /maxEntryPriceChange5m:\s*25,.*$/m, replace: 'maxEntryPriceChange5m: 15, // HARDENED: Extreme anti-chase' }
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
console.log(`Hardened ${changed} settings in routes.ts.`);
