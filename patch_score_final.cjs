const fs = require('fs');

let code = fs.readFileSync('server/routes.ts', 'utf8');

// Lower the global minScoreToTrade thresholds to 60
code = code.replace(/minScoreToTrade:\s*\d+,/g, 'minScoreToTrade: 60,');
code = code.replace(/microMinScoreToTrade:\s*\d+,/g, 'microMinScoreToTrade: 60,');
fs.writeFileSync('server/routes.ts', code);

console.log("Global score gates lowered to 60.");
