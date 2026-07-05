const fs = require('fs');
const path = require('path');

const target = path.join(__dirname, 'server', 'gold_standard_hunter.ts');
let s = fs.readFileSync(target, 'utf8');

// Fix 1: Rat Rate defaults to 1 (100%), which instantly kills every coin with -8 points.
s = s.replace(/const ratRate = g\.stat\.rat_trader_amount_rate \?\? 1;/, 'const ratRate = g.stat.rat_trader_amount_rate ?? 0;');

// Fix 2: Buy Ratio penalty is too strict (< 0.80). Change it to < 0.40.
s = s.replace(/} else if \(buyRatio < 0\.80\) {/, '} else if (buyRatio < 0.40) {');

// Fix 3: Age staleness. Since we increased MAX_AGE to 72, the staleness penalty should only apply after 72.
// The code had `ageH > 24` or similar. Let's just find `[stale, -5]` and replace the condition.
// Actually, let's just rewrite the whole age condition block.
s = s.replace(/if \(ageH < CFG\.MAX_TOKEN_AGE_HOURS\) \{[\s\S]*?\} else \{[\s\S]*?score -= 5;.*?stale.*?\]`\);\s*\}/, 
`if (ageH < CFG.MAX_TOKEN_AGE_HOURS) {
    const ageRatio = CFG.MAX_TOKEN_AGE_HOURS / Math.max(1, ageH);
    if (ageRatio > 2) {
      score += 10; signals.push(\`Age \${ageH.toFixed(1)}h [<\${CFG.MAX_TOKEN_AGE_HOURS}h, \${ageRatio.toFixed(2)}x ratio] (+10)\`);
    } else {
      score += 5;  signals.push(\`Age \${ageH.toFixed(1)}h [<\${CFG.MAX_TOKEN_AGE_HOURS}h] (+5)\`);
    }
  } else {
    score -= 5;  signals.push(\`Age \${ageH.toFixed(0)}h [stale, -5]\`);
  }`);

// Fix 4: CapEff (Capital Efficiency). 
s = s.replace(/} else if \(capEff < 100\) {/, '} else if (capEff < 20) {');

fs.writeFileSync(target, s, 'utf8');
console.log("God-Tier score penalties fixed!");
