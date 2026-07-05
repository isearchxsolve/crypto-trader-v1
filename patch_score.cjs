const fs = require('fs');
let code = fs.readFileSync('server/routes.ts', 'utf8');

// 1. Update engineSettings defaults
code = code.replace(/minScoreToTrade:\s*\d+,/g, 'minScoreToTrade: 70,');
code = code.replace(/microMinScoreToTrade:\s*\d+,/g, 'microMinScoreToTrade: 70,');

// 2. Remove the micro-wallet hardcoded bypasses
code = code.replace(/const effSniperScore = engineSettings\.sniperMinScore >= 999 \? 999 : \(isMicroWallet \? \d+ : engineSettings\.sniperMinScore\);/g, 'const effSniperScore = engineSettings.sniperMinScore;');
code = code.replace(/const effMgScore\s*=\s*isMicroWallet \? \d+ : engineSettings\.mgMinScore;/g, 'const effMgScore = engineSettings.mgMinScore;');
code = code.replace(/const effHwrScore\s*=\s*isMicroWallet \? \d+ : engineSettings\.hwrMinScore;/g, 'const effHwrScore = engineSettings.hwrMinScore;');

fs.writeFileSync('server/routes.ts', code);
console.log("Score gate patched to 70.");
