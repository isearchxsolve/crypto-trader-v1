const fs = require('fs');

let code = fs.readFileSync('server/routes.ts', 'utf8');

// Lower the minimum score back to 60 because 70 is impossible in the current low-volume market.
code = code.replace(/sniperMinScore:\s*\d+,/g, 'sniperMinScore: 60,');
code = code.replace(/mgMinScore:\s*\d+,/g, 'mgMinScore: 60,');
fs.writeFileSync('server/routes.ts', code);

// Remove the fake 15% buff
let userCode = fs.readFileSync('server/routes_user.ts', 'utf8');
userCode = userCode.replace(
  /const score = Math\.max\(0, Math\.min\(100, Math\.round\(\(\(rawTotal \/ 95\) \* 100\) \* 1\.15\)\)\); \/\/ 15% artificial buff/,
  'const score = Math.max(0, Math.min(100, Math.round((rawTotal / 95) * 100)));'
);
fs.writeFileSync('server/routes_user.ts', userCode);

console.log("Reverted fake buff and lowered min score gate to 60.");
