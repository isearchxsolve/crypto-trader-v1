const fs = require('fs');
let code = fs.readFileSync('server/routes.ts', 'utf8');

code = code.replace(
  /export async function fetchSmartMoneyConvergence[\s\S]*?const empty = { whaleCount: 0, whaleNetSellers: 0, whaleNetBuyers: 0, washSuspects: 0, netBuyers: 0 };/,
  `export async function fetchSmartMoneyConvergence(tokenAddress: string, bypassCache = false) {
  const empty = { whaleCount: 0, whaleNetSellers: 0, whaleNetBuyers: 0, washSuspects: 0, netBuyers: 0 };
  return empty;
  // (original function gutted)`
);

code = code.replace(
  /function birdeyeHasAvailableKey\(\) {[\s\S]*?return _birdeyeKeys\.some\(k => k\.active\);\n}/,
  `function birdeyeHasAvailableKey() { return false; }`
);

fs.writeFileSync('server/routes.ts', code);
console.log("Birdeye successfully disabled.");
