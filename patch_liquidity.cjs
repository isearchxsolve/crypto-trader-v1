const fs = require('fs');
const targetFile = 'server/routes.ts';

let code = fs.readFileSync(targetFile, 'utf8');

// Replace sniperMinLiquidity
code = code.replace(/sniperMinLiquidity: \d+,/g, 'sniperMinLiquidity: 30000,');

// Replace hwrMinLiquidity
code = code.replace(/hwrMinLiquidity: \d+,/g, 'hwrMinLiquidity: 20000,');

fs.writeFileSync(targetFile, code);
console.log("Liquidity floors patched to 30000 (Sniper) and 20000 (HWR).");
