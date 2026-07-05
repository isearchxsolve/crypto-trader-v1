#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const target = process.argv[2] || path.join('server', 'routes.ts');
const full = path.resolve(process.cwd(), target);

if (!fs.existsSync(full)) {
  console.error(`ERROR: Cannot find ${full}`);
  console.error('Run this from C:\\god_ai\\crypto-trader-v1_1 or pass the file path:');
  console.error('  node patch_shadow_monitor.cjs server/routes.ts');
  process.exit(1);
}

let s = fs.readFileSync(full, 'utf8');
const original = s;
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const backup = `${full}.bak-shadow-monitor-${stamp}`;

function die(msg) {
  console.error(`ERROR: ${msg}`);
  fs.writeFileSync(full + `.failed-${stamp}`, s, 'utf8');
  process.exit(1);
}

// 1) Safer shadow-close matching: oldest matching open shadow trade.
const oldMatch = `  let match: ShadowTrade | undefined;\n  for (const t of shadowOpenTrades.values()) {\n    if (t.tokenAddress === tokenAddress) { match = t; break; }\n  }\n  if (!match) return;`;
const newMatch = `  let match: ShadowTrade | undefined;\n  // FIX SHADOW-MATCH: if the same token is entered more than once, close the\n  // oldest matching open shadow trade. Matching only by tokenAddress against\n  // Map iteration order can close the wrong record when re-entries happen.\n  for (const t of Array.from(shadowOpenTrades.values()).sort((a, b) => a.openedAt - b.openedAt)) {\n    if (t.tokenAddress === tokenAddress) { match = t; break; }\n  }\n  if (!match) return;`;
if (s.includes('FIX SHADOW-MATCH')) {
  console.log('skip: safer shadow close matching already present');
} else if (s.includes(oldMatch)) {
  s = s.replace(oldMatch, newMatch);
  console.log('patched: safer shadow close matching');
} else {
  die('Could not find closeShadowTrade matching loop. Search for "let match: ShadowTrade" and patch manually.');
}

// 2) Log shadow state immediately after opening.
const openAnchor = `    shadowOpenTrades.set(id, rec);`;
const openLog = `    console.log(\`[SHADOW:STATE] open=\${shadowOpenTrades.size} closed=\${shadowClosedTrades.length}\`);`;
if (s.includes('[SHADOW:STATE] open=${shadowOpenTrades.size} closed=${shadowClosedTrades.length}')) {
  console.log('skip: shadow state logs already present');
} else if (s.includes(openAnchor)) {
  s = s.replace(openAnchor, `${openAnchor}\n${openLog}`);
  console.log('patched: open shadow state log');
} else {
  die('Could not find shadowOpenTrades.set(id, rec);');
}

// 3) Log shadow state immediately after closing.
const closeAnchor = `  shadowClosedTrades.push(closed);`;
const closeLog = `  console.log(\`[SHADOW:STATE] open=\${shadowOpenTrades.size} closed=\${shadowClosedTrades.length}\`);`;
if (s.includes(closeAnchor) && !s.includes(`${closeAnchor}\n${closeLog}`)) {
  s = s.replace(closeAnchor, `${closeAnchor}\n${closeLog}`);
  console.log('patched: close shadow state log');
} else {
  console.log('skip: close shadow state log already present or anchor not found');
}

// 4) Add /api/shadow/trades route inside registerRoutes, before the first /api/shadow/stats route if present.
const routeBlock = `
  // FIX SHADOW-MONITOR: expose open + closed shadow trades for live PowerShell monitoring.
  app.get("/api/shadow/trades", async (_req, res) => {
    try {
      const trades = getShadowTrades();
      const now = Date.now();
      res.json({
        open: trades.open.map(t => ({
          ...t,
          ageSeconds: Math.floor((now - t.openedAt) / 1000),
        })),
        closed: trades.closed.map(t => ({
          ...t,
          holdSeconds: t.closedAt ? Math.floor((t.closedAt - t.openedAt) / 1000) : null,
        })),
        counts: {
          open: trades.open.length,
          closed: trades.closed.length,
          total: trades.open.length + trades.closed.length,
        },
      });
    } catch (e: any) {
      res.status(500).json({
        error: "shadow_trades_failed",
        message: e?.message ?? String(e),
      });
    }
  });
`;
if (s.includes('"/api/shadow/trades"') || s.includes("'/api/shadow/trades'")) {
  console.log('skip: /api/shadow/trades route already present');
} else {
  const statsIdx = s.search(/\n\s*app\.(get|post)\(["']\/api\/shadow\/stats["']/);
  if (statsIdx !== -1) {
    s = s.slice(0, statsIdx) + routeBlock + s.slice(statsIdx);
    console.log('patched: inserted /api/shadow/trades before /api/shadow/stats');
  } else {
    const regIdx = s.search(/export\s+async\s+function\s+registerRoutes\s*\([^)]*\)\s*:[^{]+\{/);
    if (regIdx === -1) die('Could not find registerRoutes or /api/shadow/stats route.');
    const braceIdx = s.indexOf('{', regIdx);
    s = s.slice(0, braceIdx + 1) + routeBlock + s.slice(braceIdx + 1);
    console.log('patched: inserted /api/shadow/trades at start of registerRoutes');
  }
}

if (s === original) {
  console.log('No changes made. File already looked patched.');
  process.exit(0);
}

fs.writeFileSync(backup, original, 'utf8');
fs.writeFileSync(full, s, 'utf8');
console.log(`Backup written: ${backup}`);
console.log(`Updated: ${full}`);
console.log('Now run: npm run build');
