#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const target = process.argv[2] || path.join('server', 'routes.ts');
const full = path.resolve(process.cwd(), target);

if (!fs.existsSync(full)) {
  console.error(`ERROR: Cannot find ${full}`);
  console.error('Run from C:\\god_ai\\crypto-trader-v1_1:');
  console.error('  node .\\apply_old_profit_settings.cjs server\\routes.ts');
  process.exit(1);
}

let s = fs.readFileSync(full, 'utf8');
const original = s;
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const backup = `${full}.bak-old-profit-settings-${stamp}`;
const changes = [];
const warnings = [];

function patchRegex(label, regex, replacement) {
  const before = s;
  s = s.replace(regex, replacement);
  if (s !== before) changes.push(label);
  else warnings.push(`not found: ${label}`);
}

function setConst(name, value, comment='') {
  patchRegex(`const ${name} = ${value}`,
    new RegExp(`const\\s+${name}\\s*=\\s*[^;]+;`),
    `const ${name.padEnd(22)} = ${value};${comment}`
  );
}

function setSetting(name, value, comment='') {
  // Handles: name: oldValue, optional inline comment
  patchRegex(`engineSettings.${name} = ${value}`,
    new RegExp(`(\\b${name}\\s*:\\s*)[^,\\n}]+(,?)`),
    `$1${value}$2${comment ? ' ' + comment : ''}`
  );
}

// Constants from the old profitable file.
setConst('MAX_SINGLE_TRADE_PCT', '0.55', ' // restored from old profitable routes.ts');
setConst('MIN_EDGE_PCT', '5.0', ' // restored from old profitable routes.ts');
setConst('MIN_TRADE_SIZE_SOL', '0.003', ' // restored from old profitable routes.ts');

// Exit behavior: old file let winners breathe much more. This is the main profit difference.
setSetting('trailingStopActivation', '15', '// old profitable: let winners run before trailing');
setSetting('trailingStopDistance', '8', '// old profitable: wider breathing room');
setSetting('hardTakeProfit', '80', '// old profitable');
setSetting('stopLoss', '-8', '// old profitable: avoid wick-outs');
setSetting('maxHoldSeconds', '420', '// old profitable');
setSetting('partialTpThreshold', '15', '// old profitable');
setSetting('partialTpRatio', '0.5', '// old profitable');
setSetting('priceCheckIntervalMs', '1000', '// old profitable: faster exit checks');
setSetting('scanIntervalMs', '30000', '// old profitable: slower scan / less churn');

// Sizing from old profitable file. Keep PAPER_SEED/.env balance unchanged.
setSetting('minPositionSize', '0.003', '// old profitable');
setSetting('maxPositionSize', '0.015', '// old profitable cap');
setSetting('maxOpenPositions', '1', '// old profitable: one position at a time');

// Entry calibration from old profitable file.
setSetting('minScoreToTrade', '90', '// old profitable global conviction gate');
setSetting('sniperMinScore', '70', '// old profitable non-micro setting');
setSetting('sniperMaxAge', '300', '// old profitable');
setSetting('sniperMinBuyPressure', '0.65', '// old profitable: stronger buyer control');
setSetting('sniperMinLiquidity', '10000', '// old profitable non-micro setting');
setSetting('sniperMaxSize', '0.006', '// old profitable');
setSetting('mgMinScore', '55', '// old profitable');
setSetting('mgMinVolMomentum', '1.35', '// old profitable');
setSetting('mgMinPriceChange5m', '1.2', '// old profitable');
setSetting('mgMinTxVelocity', '8', '// old profitable');
setSetting('mgMaxSize', '0.008', '// old profitable');
setSetting('hwrMinScore', '55', '// old profitable');
setSetting('hwrMinBuyPressure5m', '0.70', '// old profitable: strict HWR buyer control');
setSetting('hwrMinBuyPressure1h', '0.51', '// old profitable');
setSetting('hwrMinLiquidity', '5000', '// old profitable non-micro setting');
setSetting('hwrMaxSize', '0.008', '// old profitable');

// Operational/discovery.
setSetting('maxTradesPerCycle', '1', '// old profitable');
setSetting('reentryDelayMs', '60000', '// old profitable');
setSetting('slReentryDelayMs', '900000', '// old profitable');
setSetting('txCostsEnabled', '1', '// old profitable');
setSetting('txFeePercent', '0.5', '// old profitable');
setSetting('safetyChecksEnabled', '1', '// old profitable');
setSetting('maxVolLiqRatioNewToken', '14', '// old profitable');
setSetting('maxDiscoveryAgeSeconds', '10800', '// old profitable');
setSetting('dynamicHoldEnabled', '1', '// old profitable');
setSetting('dynamicHoldMaxSeconds', '2100', '// old profitable');
setSetting('compoundBoostEnabled', '0', '// old profitable: disabled for micro wallet');
setSetting('compoundRefSol', '0.5', '// old profitable');
setSetting('compoundPower', '1.35', '// old profitable');
setSetting('compoundMaxMultiplier', '5.0', '// old profitable');
setSetting('compoundAbsCapSol', '1.0', '// old profitable');

// IMPORTANT: Do NOT blindly set rugcheckMinScore=400 here.
// Old file used raw RugCheck score semantics. Current file logs rugScoreNorm and has newer LP-veto relax logic.
// Copying raw 400 into normalized logic can accidentally block everything. Keep current RugCheck safety as-is.

if (s === original) {
  console.log('No changes made. The file may already contain these settings, or patterns differed.');
  if (warnings.length) console.log('Warnings:\n - ' + warnings.join('\n - '));
  process.exit(0);
}

fs.writeFileSync(backup, original, 'utf8');
fs.writeFileSync(full, s, 'utf8');
console.log(`Backup written: ${backup}`);
console.log(`Updated: ${full}`);
console.log('\nApplied old profitable settings:');
for (const c of changes) console.log(' - ' + c);
if (warnings.length) {
  console.log('\nWarnings / check manually:');
  for (const w of warnings) console.log(' - ' + w);
}
console.log('\nNext commands:');
console.log('  npm run build');
console.log('  npm run start');
