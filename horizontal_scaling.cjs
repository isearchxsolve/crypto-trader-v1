const fs = require('fs');
const path = require('path');

const target = path.join('server', 'routes.ts');
const full = path.resolve(process.cwd(), target);

let s = fs.readFileSync(full, 'utf8');

const replacements = [
  { regex: /maxOpenPositions:\s*\d+,/g, replace: 'maxOpenPositions: 5,' },
  { regex: /maxPositionSize:\s*[\d\.]+,/g, replace: 'maxPositionSize: 0.0075,' },
  { regex: /maxDiscoveryAgeSeconds:\s*\d+,/g, replace: 'maxDiscoveryAgeSeconds: 86400,' },
  { regex: /scanIntervalMs:\s*\d+,/g, replace: 'scanIntervalMs: 3000,' },
  { regex: /maxEntryPriceChange5m:\s*\d+,/g, replace: 'maxEntryPriceChange5m: 50,' },
  { regex: /hwrMaxAge:\s*\d+,/g, replace: 'hwrMaxAge: 86400,' },
  { regex: /mgMaxAge:\s*\d+,/g, replace: 'mgMaxAge: 86400,' }
];

let changed = 0;
for (const r of replacements) {
  if (s.match(r.regex)) {
    s = s.replace(r.regex, r.replace);
    changed++;
  } else {
    console.warn("Could not match regex: ", r.regex);
  }
}

fs.writeFileSync(full, s, 'utf8');
console.log(`Applied Horizontal Scaling on ${changed} variables in routes.ts.`);
