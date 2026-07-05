const fs = require('fs');
const path = require('path');

const envPath = path.resolve('.env');
if (!fs.existsSync(envPath)) {
  console.error('.env not found');
  process.exit(1);
}

let envContent = fs.readFileSync(envPath, 'utf8');

// Set EDGE_POCKET_ONLY to true
if (envContent.match(/^EDGE_POCKET_ONLY=.*$/m)) {
  envContent = envContent.replace(/^EDGE_POCKET_ONLY=.*$/m, 'EDGE_POCKET_ONLY=true');
} else {
  envContent += '\nEDGE_POCKET_ONLY=true\n';
}

fs.writeFileSync(envPath, envContent, 'utf8');
console.log('Successfully updated .env: EDGE_POCKET_ONLY=true');
