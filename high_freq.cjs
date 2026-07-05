const fs = require('fs');
const path = require('path');

const envPath = path.resolve('.env');
if (!fs.existsSync(envPath)) {
  console.error('.env not found');
  process.exit(1);
}

let envContent = fs.readFileSync(envPath, 'utf8');

// Set EDGE_POCKET_ONLY to false to restore high frequency
if (envContent.match(/^EDGE_POCKET_ONLY=.*$/m)) {
  envContent = envContent.replace(/^EDGE_POCKET_ONLY=.*$/m, 'EDGE_POCKET_ONLY=false');
} else {
  envContent += '\nEDGE_POCKET_ONLY=false\n';
}

fs.writeFileSync(envPath, envContent, 'utf8');
console.log('Successfully updated .env: EDGE_POCKET_ONLY=false');
