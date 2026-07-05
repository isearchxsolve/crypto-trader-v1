const fs = require('fs');
const path = require('path');
const file = path.resolve('server', 'routes.ts');
let s = fs.readFileSync(file, 'utf8');

// Replace minScoreToTrade
s = s.replace(/minScoreToTrade: \d+,/g, 'minScoreToTrade: 70,');
s = s.replace(/microMinScoreToTrade: \d+,/g, 'microMinScoreToTrade: 70,');

// Replace sniperMinScore
s = s.replace(/sniperMinScore: \d+,/g, 'sniperMinScore: 70,');

// Replace sniperMinBuyPressure
s = s.replace(/sniperMinBuyPressure: 0\.\d+,/g, 'sniperMinBuyPressure: 0.55,');

// Replace mgMinVolMomentum
s = s.replace(/mgMinVolMomentum: 1\.\d+,/g, 'mgMinVolMomentum: 1.1,');

// Replace hwrMinBuyPressure5m
s = s.replace(/hwrMinBuyPressure5m: 0\.\d+,/g, 'hwrMinBuyPressure5m: 0.55,');

// Replace scanIntervalMs
s = s.replace(/scanIntervalMs: 3000,/g, 'scanIntervalMs: 4000,');

fs.writeFileSync(file, s, 'utf8');
console.log('Fixed thresholds in routes.ts');
