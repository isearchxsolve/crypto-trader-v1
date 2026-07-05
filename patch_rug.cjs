const fs = require('fs');
let code = fs.readFileSync('server/routes.ts', 'utf8');

// Add "bundled", "top 10 holders", and "high ownership" to the absolute veto list
code = code.replace(
  'return n.includes("single holder ownership") || (n.includes("lp unlocked") && !n.includes("large amount of lp unlocked"));',
  'return n.includes("single holder ownership") || (n.includes("lp unlocked") && !n.includes("large amount of lp unlocked")) || n.includes("top 10 holders") || n.includes("high ownership") || n.includes("bundled");'
);

// Add the same bundle checks to the active mid-hold risk detector
code = code.replace(
  'const _patchHasSingleHolder = _patchRisks.some((r: any) => String(r?.name || "").toLowerCase().includes("single holder ownership"));',
  'const _patchHasSingleHolder = _patchRisks.some((r: any) => { const n = String(r?.name || "").toLowerCase(); return n.includes("single holder ownership") || n.includes("top 10 holders") || n.includes("high ownership") || n.includes("bundled"); });'
);

fs.writeFileSync('server/routes.ts', code);
console.log('Rug protection fully hardened.');
