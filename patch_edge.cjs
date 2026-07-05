const fs = require('fs');

// 1. Patch .env
const envFile = '.env';
let envCode = fs.readFileSync(envFile, 'utf8');
envCode = envCode.replace(/MAX_CONCURRENT_TRADES=1/g, 'MAX_CONCURRENT_TRADES=3');
fs.writeFileSync(envFile, envCode);
console.log("Patched .env: MAX_CONCURRENT_TRADES=3");

// 2. Patch server/routes.ts
const routesFile = 'server/routes.ts';
let routesCode = fs.readFileSync(routesFile, 'utf8');

// Patch maxHoldSeconds: 420 -> 180
routesCode = routesCode.replace(/maxHoldSeconds: 420,/g, 'maxHoldSeconds: 180,');

// Patch partialTpThreshold: 15 -> 8
routesCode = routesCode.replace(/partialTpThreshold: 15,/g, 'partialTpThreshold: 8,');

fs.writeFileSync(routesFile, routesCode);
console.log("Patched server/routes.ts: maxHoldSeconds=180, partialTpThreshold=8");
