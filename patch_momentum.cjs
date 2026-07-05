const fs = require('fs');

const targetFile = 'server/routes.ts';
let code = fs.readFileSync(targetFile, 'utf8');

const targetBlock = `    const volScore = volMomentum >= 3.0 ? 15 : volMomentum >= 2.0 ? 12 : volMomentum >= 1.5 ? 9 : volMomentum >= 1.0 ? 6 : volMomentum >= 0.5 ? 3 : 0;
    const priceScore = priceChange5m >= 10 ? 15 : priceChange5m >= 7 ? 12 : priceChange5m >= 5 ? 10 : priceChange5m >= 3 ? 8 : priceChange5m >= 1.5 ? 5 : priceChange5m > 0 ? 2 : Math.max(-10, Math.floor(priceChange5m));`;

const replacementBlock = `    let volScore = volMomentum >= 3.0 ? 15 : volMomentum >= 2.0 ? 12 : volMomentum >= 1.5 ? 9 : volMomentum >= 1.0 ? 6 : volMomentum >= 0.5 ? 3 : 0;
    let priceScore = priceChange5m >= 10 ? 15 : priceChange5m >= 7 ? 12 : priceChange5m >= 5 ? 10 : priceChange5m >= 3 ? 8 : priceChange5m >= 1.5 ? 5 : priceChange5m > 0 ? 2 : Math.max(-10, Math.floor(priceChange5m));
    
    // AI-PATCH: Liquidity-Weighted Momentum
    // If liquidity is highly vulnerable to manipulation (< $30k), severely cap momentum points.
    // This prevents cheap $200 pumps from artificially hacking the score to >70.
    if (liq < 30000) {
      volScore = Math.floor(volScore / 3);
      priceScore = Math.floor(priceScore / 3);
    }`;

if (code.includes(targetBlock)) {
    code = code.replace(targetBlock, replacementBlock);
    fs.writeFileSync(targetFile, code);
    console.log("Successfully injected Liquidity-Weighted Momentum into server/routes.ts");
} else {
    console.error("Could not find the target code block in server/routes.ts. The file might have been formatted differently.");
    
    // Fallback regex replacement
    code = code.replace(/const volScore = [^;]+;[\s\n]*const priceScore = [^;]+;/m, replacementBlock);
    fs.writeFileSync(targetFile, code);
    console.log("Applied regex fallback replacement.");
}
