const fs = require('fs');
const path = require('path');

const envPath = path.resolve('.env');
if (!fs.existsSync(envPath)) {
  console.error('.env not found');
  process.exit(1);
}

let envContent = fs.readFileSync(envPath, 'utf8');

// Set Mode to live
if (envContent.match(/^MODE=.*$/m)) {
  envContent = envContent.replace(/^MODE=.*$/m, 'MODE=live');
} else {
  envContent += '\nMODE=live\n';
}

// Set Concurrent Trades to 1
if (envContent.match(/^MAX_CONCURRENT_TRADES=.*$/m)) {
  envContent = envContent.replace(/^MAX_CONCURRENT_TRADES=.*$/m, 'MAX_CONCURRENT_TRADES=1');
} else {
  envContent += '\nMAX_CONCURRENT_TRADES=1\n';
}

fs.writeFileSync(envPath, envContent, 'utf8');
console.log('Successfully updated .env: MODE=live, MAX_CONCURRENT_TRADES=1');
