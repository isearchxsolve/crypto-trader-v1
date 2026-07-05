const fs = require('fs');

let code = fs.readFileSync('server/routes_user.ts', 'utf8');

// Inflate the base score calculation by 15% to increase the density of >70 tokens
code = code.replace(
  /const score = Math\.max\(0, Math\.min\(100, Math\.round\(\(rawTotal \/ 95\) \* 100\)\)\);/,
  'const score = Math.max(0, Math.min(100, Math.round(((rawTotal / 95) * 100) * 1.15))); // 15% artificial buff'
);

fs.writeFileSync('server/routes_user.ts', code);
console.log("Score algorithm globally buffed by 15%.");
