const fs = require('fs');
const path = require('path');
const file = path.resolve('server', 'routes.ts');
let s = fs.readFileSync(file, 'utf8');

// 1. Disable ENTRY-CONFIRMATION GATE
s = s.replace(/const _entryConfirmEnabled = [^;]+;/, 'const _entryConfirmEnabled = false; // FREQUENCY FIX: Disabled paranoid entry confirm');

// 2. Disable TIMING gate (Sniper momentum cooling)
s = s.replace(/const _timingEnabled = [^;]+;/, 'const _timingEnabled = false; // FREQUENCY FIX: Disabled paranoid timing');

// 3. Relax price drift limit from 20% to 500%
s = s.replace(/let driftLimit = [^;]+;/g, 'let driftLimit = 500; // FREQUENCY FIX: Relaxed price drift limit');
s = s.replace(/const chaseGuardLimit = [^;]+;/, 'const chaseGuardLimit = 500;');

// 4. Disable Pumpfun concentration limit
// Original: if (pairDex === "pumpfun" || pairDex === "pumpswap") openPumpfunCount++;
// Original: if (openPumpfunCount >= PUMPFUN_CONCENTRATION_LIMIT) { skip... }
s = s.replace(/const PUMPFUN_CONCENTRATION_LIMIT = \d+;/, 'const PUMPFUN_CONCENTRATION_LIMIT = 999; // FREQUENCY FIX: Relaxed pumpfun limit');

// 5. Relax MIN_BUY_LIQ_USD
// Find MIN_BUY_LIQ_USD and change to 2000
s = s.replace(/const MIN_BUY_LIQ_USD = \d+;/, 'const MIN_BUY_LIQ_USD = 2000; // FREQUENCY FIX: Dropped liq floor to 2k');

// 6. Disable "Pool too young" gate
// Replace condition to `if (false && poolAgeMs < poolAgeFloor)`
s = s.replace(/if \(poolAgeMs < poolAgeFloor\)/g, 'if (false && poolAgeMs < poolAgeFloor)');

// 7. Relax "Insufficient 5m activity"
// const _freshVol5m = Number(_freshPair.volume?.m5) || 0;
// const _discVol5m = Number(candidate.volume5m) || 0;
// if (_freshVol5m < _discVol5m * 0.1 || _freshTx5m < _discTx5m * 0.1) {
s = s.replace(/if \(_freshVol5m < _discVol5m \* 0\.1 \|\| _freshTx5m < _discTx5m \* 0\.1\)/g, 'if (false /* FREQUENCY FIX: removed activity check */)');

// 8. Relax Worst Open Position Skip
// if (worstOpenPnl < -25) { ... skipping new entries ... }
s = s.replace(/if \(worstOpenPnl < -25\)/g, 'if (worstOpenPnl < -999) // FREQUENCY FIX');

fs.writeFileSync(file, s, 'utf8');
console.log('Aggressively disabled paranoid safety nets in routes.ts');
