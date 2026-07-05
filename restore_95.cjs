const fs = require('fs');
const path = require('path');

const target = path.join('server', 'routes.ts');
const full = path.resolve(process.cwd(), target);

let s = fs.readFileSync(full, 'utf8');

const replacements = [
  { regex: /minScoreToTrade:\s*\d+,/g, replace: 'minScoreToTrade: 95,' },
  { regex: /microMinScoreToTrade:\s*\d+,/g, replace: 'microMinScoreToTrade: 95,' },
  { regex: /sniperMinScore:\s*\d+,/g, replace: 'sniperMinScore: 85,' },
  { regex: /mgMinScore:\s*\d+,/g, replace: 'mgMinScore: 85,' },
  { regex: /hwrMinScore:\s*\d+,/g, replace: 'hwrMinScore: 85,' }
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
console.log(`Restored 95-score gates on ${changed} variables in routes.ts.`);
