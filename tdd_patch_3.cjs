const fs = require('fs');

let code = fs.readFileSync('server/routes.ts', 'utf8');

// Set score gate to 60 (to get high scoring positions)
code = code.replace(/minScoreToTrade:\s*\d+,/g, 'minScoreToTrade: 60,');
code = code.replace(/microMinScoreToTrade:\s*\d+,/g, 'microMinScoreToTrade: 60,');

// Set sniper age to 3600 (was 7200 in last iteration)
code = code.replace(/sniperMaxAge:\s*\d+,/g, 'sniperMaxAge: 3600,');

// Set HWR score to 60
code = code.replace(/hwrMinScore:\s*\d+,/g, 'hwrMinScore: 60,');

fs.writeFileSync('server/routes.ts', code);
console.log("TDD iteration 3: Gate 60, Sniper Age 3600, LP Veto Bypass ON.");
