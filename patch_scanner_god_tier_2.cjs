const fs = require('fs');
const path = require('path');

const target = path.join(__dirname, 'fast_scanner.cjs');
let s = fs.readFileSync(target, 'utf8');

const newEvaluate = `async function evaluate(mint) {
    const rDex = await dexscreenerPass(mint);
    if (!rDex.pass) return log(\`eval fail [dex]: \${mint} - \${rDex.reason}\`);
    
    const rRug = await rugcheckPass(mint);
    if (!rRug.pass) return log(\`eval fail [rug]: \${mint} - \${rRug.reason}\`);
    
    const rHold = await holderPass(mint);
    if (!rHold.pass) return log(\`eval fail [hold]: \${mint} - \${rHold.reason}\`);

    const row = [
        new Date().toISOString(), mint, rRug.score, rDex.liq.toFixed(0), 
        rDex.ageH.toFixed(2), rHold.top1.toFixed(1), rHold.top10.toFixed(1), 
        rDex.ratio.toFixed(2), rDex.url
    ].join(',') + '\\n';
    fs.appendFileSync(CANDIDATES_FILE, row);
    log(\`★ FAST INJECT (GOD-TIER): \${mint} | Vol/Liq: \${rDex.ratio.toFixed(1)}x | Liq: $\${rDex.liq.toFixed(0)}\`);
}`;

const newDrain = `async function drain() {
    if (busy) return; busy = true;
    const batch = [];
    while (q.length && batch.length < 20) {
        const m = q.shift();
        if (seen.has(m)) continue;
        seen.add(m);
        batch.push(m);
    }
    if (batch.length > 0) {
        await Promise.allSettled(batch.map(m => evaluate(m).catch(e => log(\`eval err: \${e.message}\`))));
    }
    busy = false;
    if (q.length > 0) setTimeout(drain, 100);
}`;

// Use regex to replace the function blocks safely, handling \r\n and \n
s = s.replace(/async function evaluate\(mint\) \{[\s\S]*?log\(`★ FAST INJECT.*? milliseconds!`\);\s*\}/, newEvaluate);
s = s.replace(/async function drain\(\) \{[\s\S]*?busy = false;\s*\}/, newDrain);

fs.writeFileSync(target, s, 'utf8');
console.log("God-Tier evaluate and drain patched successfully!");
