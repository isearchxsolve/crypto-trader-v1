const fs = require('fs');

let code = fs.readFileSync('server/routes.ts', 'utf8');

// Set score gate to 70 based on user instruction "increase the score gate to 70 again"
code = code.replace(/minScoreToTrade:\s*\d+,/g, 'minScoreToTrade: 70,');
code = code.replace(/microMinScoreToTrade:\s*\d+,/g, 'microMinScoreToTrade: 70,');

// Disable HWR completely based on user instruction "avoid the hwr mode it is consistently generating loss"
code = code.replace(/hwrMinScore:\s*\d+,/g, 'hwrMinScore: 999,');

fs.writeFileSync('server/routes.ts', code);
console.log("TDD iteration 4: Gate 70, HWR Disabled, Sniper Age 3600, LP Veto Bypass ON.");
