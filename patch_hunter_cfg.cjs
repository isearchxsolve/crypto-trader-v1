const fs = require('fs');
const path = require('path');

const target = path.join(__dirname, 'server', 'gold_standard_hunter.ts');
let s = fs.readFileSync(target, 'utf8');

// Tuning CFG
s = s.replace(/MIN_LIQUIDITY_USD:\s*50_000,/, 'MIN_LIQUIDITY_USD:    15_000,   // AI-TUNED for high quantity God-Tier');
s = s.replace(/MIN_HOLDER_COUNT:\s*1_000,/, 'MIN_HOLDER_COUNT:     300,      // AI-TUNED for high quantity God-Tier');
s = s.replace(/MAX_TOKEN_AGE_HOURS:\s*6,/, 'MAX_TOKEN_AGE_HOURS:  72,       // AI-TUNED for high quantity God-Tier');

// Tuning GMGN Batch Limits
// 1. In pollSmartMoneyFeed
s = s.replace(/--limit 100/g, '--limit 300');

// 2. In pollTrending
s = s.replace(/--limit 50/g, '--limit 200');
// Also update the age param in the CLI string, wait, the CLI string uses 6h hardcoded!
// Let's replace the hardcoded `--max-created 6h` with `${CFG.MAX_TOKEN_AGE_HOURS}h`
s = s.replace(/--max-created 6h/g, '--max-created ${CFG.MAX_TOKEN_AGE_HOURS}h');

fs.writeFileSync(target, s, 'utf8');
console.log("GMGN CFG tuning applied successfully!");
