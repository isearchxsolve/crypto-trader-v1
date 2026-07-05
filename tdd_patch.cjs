const fs = require('fs');

let code = fs.readFileSync('server/routes.ts', 'utf8');

// Relax global score gate to 55
code = code.replace(/minScoreToTrade:\s*\d+,/g, 'minScoreToTrade: 55,');
code = code.replace(/microMinScoreToTrade:\s*\d+,/g, 'microMinScoreToTrade: 55,');

// Relax Sniper age
code = code.replace(/sniperMaxAge:\s*\d+,/g, 'sniperMaxAge: 7200,');

// Relax MG constraints
code = code.replace(/mgMinVolMomentum:\s*[\d.]+,/g, 'mgMinVolMomentum: 0.7,');
code = code.replace(/mgMinPriceChange5m:\s*[\d.]+,/g, 'mgMinPriceChange5m: 1.0,');

fs.writeFileSync('server/routes.ts', code);
console.log("TDD iteration: Gates relaxed to 55 score, 2h sniper age, 0.7 volMom.");
