const fs = require('fs');
const path = require('path');

const envPath = path.resolve('.env');
if (!fs.existsSync(envPath)) {
  console.error('.env not found');
  process.exit(1);
}

let envContent = fs.readFileSync(envPath, 'utf8');

// Revert Mode to paper
if (envContent.match(/^MODE=.*$/m)) {
  envContent = envContent.replace(/^MODE=.*$/m, 'MODE=paper');
} else {
  envContent += '\nMODE=paper\n';
}

fs.writeFileSync(envPath, envContent, 'utf8');
console.log('Successfully reverted .env: MODE=paper');
