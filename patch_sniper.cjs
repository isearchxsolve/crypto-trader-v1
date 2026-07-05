const fs = require('fs');

// 1. Relax Sniper entry metrics in routes.ts
let code = fs.readFileSync('server/routes.ts', 'utf8');
code = code.replace(/sniperMinBuyPressure:\s*[\d.]+,/g, 'sniperMinBuyPressure: 0.51,');
code = code.replace(/sniperMaxAge:\s*\d+,/g, 'sniperMaxAge: 3600,');
code = code.replace(/maxEntryPriceChange5m:\s*\d+,/g, 'maxEntryPriceChange5m: 100,');
fs.writeFileSync('server/routes.ts', code);

// 2. Increase MAX_CONCURRENT_TRADES in .env
let env = fs.readFileSync('.env', 'utf8');
env = env.replace(/MAX_CONCURRENT_TRADES=\d+/g, 'MAX_CONCURRENT_TRADES=8');
fs.writeFileSync('.env', env);

console.log("Sniper metrics relaxed and concurrent trades increased to 8.");
