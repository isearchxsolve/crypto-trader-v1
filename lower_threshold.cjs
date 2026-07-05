const fs = require('fs');

const targetFile = 'server/routes.ts';
let code = fs.readFileSync(targetFile, 'utf8');

// Lower the minimum score to 55 to allow trades through without the artificial boost
code = code.replace(/minScoreToTrade: 70,/g, 'minScoreToTrade: 55,');
code = code.replace(/microMinScoreToTrade: 70,/g, 'microMinScoreToTrade: 55,');

fs.writeFileSync(targetFile, code);
console.log("Successfully lowered minScoreToTrade to 55 in server/routes.ts");
