const fs = require('fs');
const { spawn, execSync } = require('child_process');
const path = require('path');

const LOCK_FILE = path.join(__dirname, '.autopilot.lock');

try {
  if (process.platform.startsWith('win')) {
    const out = execSync('netstat -ano | findstr :5000').toString();
    for (const line of out.split('\\n')) {
      if (line.includes('LISTENING')) {
        const pid = line.trim().split(/\\s+/).pop();
        if (pid && parseInt(pid) > 0) execSync(`taskkill /F /PID ${pid}`, { stdio: 'ignore' });
      }
    }
  }
} catch(e) {}

try {
  if (fs.existsSync(LOCK_FILE)) {
    const pid = fs.readFileSync(LOCK_FILE, 'utf8');
    try {
      process.kill(parseInt(pid), 0);
      console.log(`[AUTOPILOT] Another instance (PID ${pid}) is already running. Exiting to prevent corruption.`);
      process.exit(0);
    } catch (e) {
    }
  }
  fs.writeFileSync(LOCK_FILE, process.pid.toString());
} catch (e) {}

function cleanupLock() {
  try { if (fs.existsSync(LOCK_FILE)) fs.unlinkSync(LOCK_FILE); } catch (e) {}
}
process.on('exit', cleanupLock);
process.on('SIGINT', () => { cleanupLock(); process.exit(); });
process.on('uncaughtException', (err) => { console.error(err); cleanupLock(); process.exit(1); });

// ── CONFIG ───────────────────────────────────────────────────────────────────
const ROUTES_FILE = path.join(__dirname, 'server', 'routes.ts');
const STATS_FILE  = path.join(__dirname, 'shadow-stats.json');

// Resolve npm path at startup
function findNpm() {
  const isWin = process.platform.startsWith('win');
  try {
    const which = execSync(isWin ? 'where.exe npm.cmd' : 'which npm', { encoding: 'utf8', timeout: 5000 }).trim().split('\n')[0].trim();
    if (which) return which;
  } catch {}
  return isWin ? 'npm.cmd' : 'npm';
}
const NPM_CMD = findNpm();

// 3 primary optimization targets
const TARGETS = {
  winRate: 0.80,  // 80%
  freqMin: 4.0,   // 4 trades/min (2 trades / 30 secs)
  evTarget: 5.0,  // +5% EV (very high EV)
  evFloor: 0.0,   // 0% floor (strict positive EV)
};

// Parameter ranges and defaults
const PARAMS = {
  minScoreToTrade:        { min: 70, max: 85, step: 2, current: null },
  sniperMinBuyPressure:   { min: 0.05, max: 0.80, step: 0.05, current: null },
  mgMinVolMomentum:       { min: 0.05, max: 1.80, step: 0.10, current: null },
  sniperMaxAge:           { min: 300, max: 14400, step: 600, current: null },
  stopLoss:               { min: -95, max: -85, step: 5, current: null },
};

// State management
let scriptStartTime = Date.now();
let engineProcess = null;
let windowStart = Date.now();
let snapshot = null;
let bestSnapshot = null;
let bestParams = null;
let convergeCount = 0;
let stuckCount = 0;
let adjustCount = 0;
let tuneInterval = null;
const failedStates = new Set();

function stateHash() {
  const p = PARAMS;
  return `${p.minScoreToTrade.current}_${p.sniperMinBuyPressure.current.toFixed(2)}_${p.mgMinVolMomentum.current.toFixed(2)}_${p.sniperMaxAge.current}_${p.stopLoss.current}`;
}

function readStats() {
  try { return fs.existsSync(STATS_FILE) ? JSON.parse(fs.readFileSync(STATS_FILE, 'utf8')) : null; }
  catch { return null; }
}

function snapshotNow() {
  const s = readStats();
  return s ? { ...s, ts: Date.now() } : null;
}

function deltaMetrics(before, after) {
  if (!before || !after) return null;
  const dtrades = after.totalTrades - before.totalTrades;
  if (dtrades < 1) return null;

  const dwins = after.wins - before.wins;
  const devSum = after.sumShadowPnl - before.sumShadowPnl;
  const dpaperSum = after.sumPaperPnl - before.sumPaperPnl;

  const winRate = dtrades > 0 ? dwins / dtrades : 0;
  const avgEV = dtrades > 0 ? devSum / dtrades : 0;
  const avgPaperEV = dtrades > 0 ? dpaperSum / dtrades : 0;

  const elapsed = (Date.now() - windowStart) / 60000;
  const freq = elapsed > 0 ? dtrades / elapsed : 0;

  return { dtrades, dwins, winRate, avgEV, avgPaperEV, freq, elapsed };
}

// Debug: extract current params from routes.ts function
function extractParamFromRoutes(name) {
  const code = fs.readFileSync(ROUTES_FILE, 'utf8');

  // Enhanced pattern matching - try multiple approaches
  const patterns = [
    new RegExp(`\\\\b${name}\\\\s*:\\\\s*([\\\\d.]+)`),
    new RegExp(`'${name}'\\s*:\\s*([\\d.]+)`),
    new RegExp(`${name}\\\\s*:\\s*([\\d.]+)`),
    new RegExp(`"${name}"\\s*:\\s*([\\d.]+)`),
  ];

  for (const pattern of patterns) {
    const match = code.match(pattern);
    if (match && match[1] !== undefined && match[1] !== '') {
      return parseFloat(match[1]);
    }
  }

  return null;
}

function loadParams() {
  console.log('[AUTOPILOT] Loading parameters from routes.ts...');

  // Get parameter values from routes.ts
  PARAMS.minScoreToTrade.current = extractParamFromRoutes('minScoreToTrade') ?? PARAMS.minScoreToTrade.min;
  PARAMS.sniperMinBuyPressure.current = extractParamFromRoutes('sniperMinBuyPressure') ?? PARAMS.sniperMinBuyPressure.min;
  PARAMS.mgMinVolMomentum.current = extractParamFromRoutes('mgMinVolMomentum') ?? PARAMS.mgMinVolMomentum.min;
  PARAMS.sniperMaxAge.current = extractParamFromRoutes('sniperMaxAge') ?? PARAMS.sniperMaxAge.min;
  PARAMS.stopLoss.current = extractParamFromRoutes('stopLoss') ?? PARAMS.stopLoss.min;

  console.log('[AUTOPILOT] Loaded params:', JSON.stringify(PARAMS));
}

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function paramMove(param, dir) {
  const def = PARAMS[param];
  if (!def) return false;
  if (dir > 0 && def.current < def.max) { def.current = clamp(def.current + def.step, def.min, def.max); return true; }
  if (dir < 0 && def.current > def.min) { def.current = clamp(def.current - def.step, def.min, def.max); return true; }
  return false;
}

function writeParams() {
  let code = fs.readFileSync(ROUTES_FILE, 'utf8');
  const old = code;

  for (const [param, def] of Object.entries(PARAMS)) {
    if (def.current === null) continue;
    const aliases = param === 'minScoreToTrade' ? ['minScoreToTrade', 'microMinScoreToTrade', 'sniperMinScore', 'mgMinScore'] : [param];
    for (const alias of aliases) {
      code = code.replace(new RegExp(`${alias}:\\s*-?[\\d.]+`, 'g'), `${alias}: ${def.current}`);
    }
  }

  if (code !== old) { fs.writeFileSync(ROUTES_FILE, code); return true; }
  return false;
}

function restartEngine() {
  if (engineProcess) { 
    try { 
      if (process.platform.startsWith('win')) {
        execSync(`taskkill /F /T /PID ${engineProcess.pid}`, { stdio: 'ignore' });
      } else {
        engineProcess.kill();
      }
    } catch {} 
    engineProcess = null; 
  }
  // Hard kill any rogue process still holding port 5000
  try {
    if (process.platform.startsWith('win')) {
      const out = execSync('netstat -ano | findstr :5000').toString();
      for (const line of out.split('\\n')) {
        if (line.includes('LISTENING')) {
          const pid = line.trim().split(/\\s+/).pop();
          if (pid && parseInt(pid) > 0) execSync(`taskkill /F /PID ${pid}`, { stdio: 'ignore' });
        }
      }
    }
  } catch(e) {}

  console.log('[AUTOPILOT] Releasing locks...');
  try { execSync('powershell -Command "Start-Sleep -Seconds 2"', { stdio: 'ignore' }); } catch(e) {}
  console.log('[AUTOPILOT] Building...');
  try { execSync(`"${NPM_CMD}" run build`, { cwd: __dirname, stdio: 'pipe', timeout: 120_000 }); }
  catch (e) { console.error(`[AUTOPILOT] Build fail: ${e.message}`); return; }

  engineProcess = spawn(NPM_CMD, ['run', 'start'], { cwd: __dirname, stdio: ['ignore', 'pipe', 'pipe'], shell: true });
  const rl = require('readline').createInterface({ input: engineProcess.stdout, terminal: false });
  rl.on('line', (l) => { console.log(`[ENGINE] ${l}`); });
  engineProcess.stderr.on('data', (d) => process.stderr.write(`[ENGINE-ERR] ${d}`));
  engineProcess.on('exit', (c) => { console.log(`[AUTOPILOT] Engine exit(${c})`); engineProcess = null; });
}

function tune() {
  const totalElapsed = (Date.now() - scriptStartTime) / 60000;
  if (totalElapsed > 55) {
     console.log(`[AUTOPILOT] Time limit reached (55m). Forcing convergence to best params.`);
     if (bestParams) {
         for (const key in bestParams) { PARAMS[key].current = bestParams[key].current; }
         writeParams();
         console.log(`[AUTOPILOT] Applied BEST:`, JSON.stringify(PARAMS));
         restartEngine();
     }
     console.log(`[AUTOPILOT] ✓✓✓ CONVERGED (Time Limit)!`);
     if (tuneInterval) clearInterval(tuneInterval);
     return;
  }

  const stats = readStats();
  if (!stats || stats.totalTrades < 1) { console.log('[AUTOPILOT] Waiting for first trade...'); return; }

  if (!snapshot) { snapshot = snapshotNow(); console.log('[AUTOPILOT] Snapshot taken.'); return; }

  const d = deltaMetrics(snapshot, stats);
  if (!d || d.dtrades < 2) { console.log(`[AUTOPILOT] Need ${2 - (d ? d.dtrades : 0)} more trades.`); return; }

  const { winRate, avgEV, avgPaperEV, freq, dtrades } = d;
  const issues = [];

  if (avgEV < TARGETS.evFloor) issues.push('EV');
  if (winRate < TARGETS.winRate) issues.push('WIN_RATE');
  if (d.elapsed >= 0.5 && freq < TARGETS.freqMin) issues.push('FREQ');
  if (avgEV <= avgPaperEV) issues.push('SHADOW_EAT_PAPER');

  console.log('');
  console.log(`[AUTOPILOT] ════════════════════════════════════════════════`);
  console.log(`[AUTOPILOT] Window: ${d.elapsed.toFixed(1)}min | ${dtrades} trades | ${freq.toFixed(3)}/min`);
  console.log(`[AUTOPILOT] WR: ${(winRate * 100).toFixed(1)}% | Shadow EV: ${avgEV.toFixed(2)}% | Paper EV: ${avgPaperEV.toFixed(2)}%`);
  console.log(`[AUTOPILOT] ════════════════════════════════════════════════`);

  const score = avgEV;
  if (!bestSnapshot || score >= (bestSnapshot._score ?? -Infinity)) {
    bestSnapshot = { ...stats, _score: score, _ts: Date.now() };
    bestParams = { ...PARAMS };
    stuckCount = 0;
    console.log(`[AUTOPILOT] ✓ New best EV: ${score.toFixed(2)}%`);
  }

  if (issues.length === 0) {
    convergeCount++;
    if (convergeCount >= 3) {
      console.log(`[AUTOPILOT] ✓✓✓ CONVERGED!`);
      console.log(`[AUTOPILOT]   EV=${avgEV.toFixed(2)}% WR=${(winRate*100).toFixed(1)}% Freq=${freq.toFixed(3)}/min`);
      console.log(`[AUTOPILOT]   Params:`, JSON.stringify(PARAMS));
      snapshot = snapshotNow();
      return;
    }
    console.log(`[AUTOPILOT] Within targets (${convergeCount}/3).`);
    snapshot = snapshotNow();
    return;
  }
  convergeCount = 0;

  let dir = 0, reason = '';
  if (issues.includes('EV')) { dir = 1; reason = `EV=${avgEV.toFixed(2)}%`; }
  else if (issues.includes('WIN_RATE')) { dir = 1; reason = `WR=${(winRate*100).toFixed(1)}%`; }
  else if (issues.includes('SHADOW_EAT_PAPER')) { dir = 1; reason = `Shadow(${avgEV.toFixed(2)}%) <= Paper(${avgPaperEV.toFixed(2)}%)`; }
  else if (issues.includes('FREQ')) { dir = -1; reason = `freq=${freq.toFixed(3)}`; }

  console.log(`[AUTOPILOT] ${dir > 0 ? 'TIGHTEN' : 'RELAX'} (${reason})`);

  const changed = (dir > 0) ?
    paramMove('minScoreToTrade', 1) ||
    paramMove('sniperMinBuyPressure', 1) ||
    paramMove('mgMinVolMomentum', 1) ||
    paramMove('sniperMaxAge', -1) ||
    paramMove('stopLoss', 1) :
    paramMove('minScoreToTrade', -1) ||
    paramMove('sniperMaxAge', 1) ||
    paramMove('sniperMinBuyPressure', -1) ||
    paramMove('mgMinVolMomentum', -1) ||
    paramMove('stopLoss', -1);

  if (!changed) {
    console.log(`[AUTOPILOT] Params at bounds. EV=${avgEV.toFixed(2)}% - strategy needs redesign.`);
    snapshot = snapshotNow();
    stuckCount++;
    return;
  }

  failedStates.add(stateHash());
  writeParams();
  console.log(`[AUTOPILOT] Applied:`, JSON.stringify(PARAMS));

  adjustCount++;
  stuckCount++;
  snapshot = snapshotNow();
  restartEngine();
}

console.log('[AUTOPILOT] ════════════════════════════════════════════════');
console.log('[AUTOPILOT]  AutoPilot v5 — Multi-Objective: EV + WR + Freq');
console.log('[AUTOPILOT] ════════════════════════════════════════════════');

loadParams();

const cur = readStats();
if (cur) {
  console.log(`[AUTOPILOT] Ledger: ${cur.totalTrades} trades | EV=${cur.totalTrades > 0 ? (cur.sumShadowPnl / cur.totalTrades).toFixed(2) : '?'}%`);
}

console.log('[AUTOPILOT] Building...');
try { execSync(`"${NPM_CMD}" run build`, { cwd: __dirname, stdio: 'pipe', timeout: 120_000 }); }
catch (e) { console.error(`[AUTOPILOT] Build fail: ${e.message}`); process.exit(1); }
console.log('[AUTOPILOT] Build OK.');
restartEngine();

tuneInterval = setInterval(tune, 30_000);
console.log('[AUTOPILOT] Ready. Monitoring every 30 seconds.');
