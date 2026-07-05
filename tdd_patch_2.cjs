const fs = require('fs');

let code = fs.readFileSync('server/routes.ts', 'utf8');

// Relax global score gate to 50
code = code.replace(/minScoreToTrade:\s*\d+,/g, 'minScoreToTrade: 50,');
code = code.replace(/microMinScoreToTrade:\s*\d+,/g, 'microMinScoreToTrade: 50,');

// Re-enable HWR mode (set score down to 50)
code = code.replace(/hwrMinScore:\s*\d+,/g, 'hwrMinScore: 50,');
// Relax HWR constraints to capture more grinders
code = code.replace(/hwrMinBuyPressure5m:\s*[\d.]+,/g, 'hwrMinBuyPressure5m: 0.51,');

fs.writeFileSync('server/routes.ts', code);
console.log("TDD iteration 2: Gates relaxed to 50, HWR mode re-enabled.");
