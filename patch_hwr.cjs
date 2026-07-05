const fs = require('fs');
let code = fs.readFileSync('server/routes.ts', 'utf8');

// Disable HWR mode by setting its score floor to 999
code = code.replace(/hwrMinScore:\s*\d+,/g, 'hwrMinScore: 999,');

fs.writeFileSync('server/routes.ts', code);
console.log("HWR mode disabled (hwrMinScore set to 999).");
