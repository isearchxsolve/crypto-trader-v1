const fs = require('fs');
let code = fs.readFileSync('server/routes.ts', 'utf8');

// Strip out the +35 bonus
code = code.replace(
  /const ageScore = .*?\n\s*const boostBonus = pair\.isBoosted \? 35 : 0; \/\/ Huge score boost for officially trending\/boosted coins/g,
  'const ageScore = ageSeconds < 60 ? 10 : ageSeconds <= 300 ? 8 : ageSeconds <= 600 ? 6 : ageSeconds <= 1800 ? 4 : ageSeconds <= 3600 ? 2 : 0;'
);

code = code.replace(
  /const rawTotal = liqScore \+ bpScore \+ volScore \+ priceScore \+ txScore \+ ageScore \+ bp1hScore \+ fdvScore \+ boostBonus;/g,
  'const rawTotal = liqScore + bpScore + volScore + priceScore + txScore + ageScore + bp1hScore + fdvScore;'
);

fs.writeFileSync('server/routes.ts', code);
console.log('Restored scoring purity by removing artificial boostBonus.');
