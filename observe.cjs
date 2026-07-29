// observe.cjs — continuous engine observer
// Polls /api/health every 60s and prints live status

const http = require('http');
const fs = require('fs');
const path = require('path');

const LOG_DIR = path.join(__dirname, 'logs');
const LOG_FILE = path.join(LOG_DIR, 'observe.log');
const INTERVAL_MS = 60_000;

// Ensure log dir exists
try { fs.mkdirSync(LOG_DIR, { recursive: true }); } catch {}

let runCount = 0;
let lastBalance = 0;
let peakBalance = 0;

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  try { fs.appendFileSync(LOG_FILE, line + '\n'); } catch (e) { console.error('Log write error:', e.message); }
}

function httpGet(path) {
  return new Promise(resolve => {
    const req = http.get(`http://127.0.0.1:5000${path}`, { timeout: 10000 }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => resolve({ ok: res.statusCode === 200, body: d }));
    });
    req.on('error', () => resolve({ ok: false, body: '' }));
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, body: '' }); });
  });
}

async function check() {
  runCount++;
  const health = await httpGet('/api/health');
  if (!health.ok) {
    log(`WARN [RUN ${runCount}] ENGINE DOWN`);
    return;
  }

  try {
    const h = JSON.parse(health.body);
    const balance = parseFloat(h.walletBalance || '0');
    const positions = h.openPositions || 0;
    const tradesToday = h.tradesToday || 0;
    const winsToday = h.winsToday || 0;
    const lossesToday = h.lossesToday || 0;

    if (balance > peakBalance) peakBalance = balance;
    const balanceChange = lastBalance > 0 ? ((balance - lastBalance) / lastBalance * 100).toFixed(2) : 'N/A';

    const statusLine = [
      `[${h.mode?.toUpperCase() || '?'}] ${h.isRunning ? 'RUN' : 'STOP'}`,
      `Bal:${balance.toFixed(4)}`,
      `Chg:${balanceChange}%`,
      `Peak:${peakBalance.toFixed(4)}`,
      `Pos:${positions}`,
      `T:${tradesToday}W:${winsToday}L:${lossesToday}`,
      `Pnl:${h.dailyPnl !== undefined ? h.dailyPnl : '?'}`,
    ].join(' | ');

    log(statusLine);

    if (lastBalance > 0 && balance < lastBalance * 0.5) {
      log(`CRITICAL: Balance dropped 50%+ (${lastBalance.toFixed(4)} → ${balance.toFixed(4)} SOL)`);
    }
    if (h.mode !== 'live') {
      log(`MODE CHANGE: ${h.mode} — not live!`);
    }
    if (positions > 0 && positions !== lastPositions) {
      log(`Position change: ${positions} open now`);
    }

    lastBalance = balance;
    lastPositions = positions;
  } catch (e) {
    log(`Parse error: ${e.message}`);
  }
}

console.log('==================================================');
console.log('  ENGINE OBSERVER');
console.log(`  PID: ${process.pid}`);
console.log('  Checking /api/health every 60s');
console.log(`  Log: ${LOG_FILE}`);
console.log('  Ctrl+C to stop.');
console.log('==================================================\n');

check();
setInterval(check, INTERVAL_MS);

process.on('SIGINT', () => {
  console.log(`\nObserver stopped. ${runCount} checks. Peak balance: ${peakBalance.toFixed(4)} SOL`);
  process.exit(0);
});
process.on('SIGTERM', () => process.exit(0));
