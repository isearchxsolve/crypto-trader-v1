// restart.cjs — hardened restart: kill by port, verify free, health-check each service
const { execSync, spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');
require('dotenv').config({ override: true });

const ROOT = __dirname;
const ts = () => new Date().toISOString().replace(/^(.+)T(.+)\..+$/, '$1 $2');
const LOG = (m) => console.log(`[${ts()}] [RESTART] ${m}`);
const WARN = (m) => console.log(`[${ts()}] [RESTART \u26A0] ${m}`);
const OK   = (m) => console.log(`[${ts()}] [RESTART \u2713] ${m}`);
const FAIL = (m) => { console.log(`[${ts()}] [RESTART \u2717] ${m}`); process.exitCode = 1; };

function exec(cmd, opts = {}) {
  try { return execSync(cmd, { cwd: ROOT, stdio: 'pipe', timeout: 20000, ...opts }).toString().trim(); }
  catch (e) { return ''; }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function httpGet(url, timeoutMs = 8000) {
  return new Promise(resolve => {
    const req = http.get(url, { timeout: timeoutMs }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => resolve({ ok: res.statusCode === 200, body: d, code: res.statusCode }));
    });
    req.on('error', () => resolve({ ok: false, body: '', code: 0 }));
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, body: '', code: 0 }); });
  });
}

async function waitPort(port, expectedFree, label, maxWaitMs = 15000) {
  const step = 1000;
  for (let waited = 0; waited < maxWaitMs; waited += step) {
    const r = exec(`netstat -ano | findstr ":${port}" | findstr "LISTENING"`);
    const free = !r;
    if (expectedFree && free) { OK(`${label} port ${port} is free`); return true; }
    if (!expectedFree && !free) { OK(`${label} port ${port} is listening`); return true; }
    await sleep(step);
  }
  FAIL(`${label} port ${port} ${expectedFree ? 'still in use' : 'not listening'} after ${maxWaitMs}ms`);
  return false;
}

async function main() {
  console.log(`\n[${ts()}] ============ CRYPTO-TRADER RESTART ============`);
  let failures = 0;
  const step = (n, label, fn) =>
    console.log(`\n[${ts()}] --- Step ${n}: ${label} ---`);

  // ── Step 1: Kill everything by port + image (safe: exclude self PID) ──
  step(1, 'Kill old processes');
  const selfPid = process.pid;
  // Kill by port first (targeted — never matches this script)
  LOG('Killing process on port 5000 (engine)...');
  exec(`for /f "tokens=5" %a in ('netstat -ano ^| findstr ":5000" ^| findstr "LISTENING"') do taskkill /F /PID %a 2>nul`);
  LOG('Killing process on port 5001 (ML server)...');
  exec(`for /f "tokens=5" %a in ('netstat -ano ^| findstr ":5001" ^| findstr "LISTENING"') do taskkill /F /PID %a 2>nul`);
  // Kill other node processes (exclude self PID)
  LOG(`Killing other node.exe processes (self PID: ${selfPid})...`);
  // tasklist → filter out self → pipe to taskkill
  exec(`for /f "skip=3 tokens=2" %a in ('tasklist /fi "imagename eq node.exe" /nh') do if %a neq ${selfPid} taskkill /F /PID %a 2>nul`);
  // Also kill any orphaned python ML processes by port
  exec(`for /f "tokens=5" %a in ('netstat -ano ^| findstr ":5001" ^| findstr "LISTENING"') do taskkill /F /PID %a 2>nul`);
  await sleep(2000);
  const p0 = await waitPort(5000, true, 'Engine', 10000);
  const p1 = await waitPort(5001, true, 'ML', 10000);
  if (!p0 || !p1) failures++;

  // ── Step 2: Clean stale artifacts ──────────────────
  step(2, 'Clean stale artifacts');
  ['bot.pid', 'node_modules/.vite/deps'].forEach(f => {
    const p = path.join(ROOT, f);
    try { fs.rmSync(p, { recursive: true, force: true }); LOG(`Removed ${f}`); } catch {}
  });
  // Truncate old app.log — new rotation starts fresh
  const appLog = path.join(ROOT, 'logs', 'app.log');
  try {
    const size = fs.statSync(appLog).size;
    if (size > 50 * 1024 * 1024) {  // >50MB
      fs.renameSync(appLog, appLog + '.old');
      LOG(`Archived app.log (${(size / 1024 / 1024).toFixed(1)}MB) → app.log.old`);
    }
  } catch {}
  OK('Stale artifacts cleaned');

  // ── Step 3: Verify + reset DB ──────────────────
  step(3, 'Reset DB to LIVE mode');
  try {
    const { Pool } = require('pg');
    const pool = new Pool({
      connectionString: process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/postgres',
      connectionTimeoutMillis: 5000,
    });
    await pool.query(`UPDATE bot_status SET trading_mode = 'live', is_running = false`);
    const r = await pool.query('SELECT trading_mode FROM bot_status');
    const mode = r.rows[0]?.trading_mode;
    if (mode === 'live') { OK(`DB trading_mode = ${mode}`); }
    else { FAIL(`DB trading_mode = ${mode}, expected 'live'`); failures++; }
    await pool.end();
  } catch (e) { FAIL(`DB connection failed: ${e.message}`); failures++; }

  // ── Step 4: Start ML server ──────────────────
  step(4, 'Start ML server on port 5001');
  const mlDir = path.join(ROOT, 'solana_hybrid_sniper_ultra');
  const mlLogOut = path.join(ROOT, 'logs', 'ml_server_out.log');
  const mlLogErr = path.join(ROOT, 'logs', 'ml_server_err.log');
  const mlOut = fs.openSync(mlLogOut, 'a');
  const mlErr = fs.openSync(mlLogErr, 'a');
  const mlProc = spawn('python', ['ml_server.py'], {
    cwd: mlDir,
    stdio: ['ignore', mlOut, mlErr],
    env: { ...process.env, ML_PORT: '5001' },
    detached: true,
  });
  mlProc.unref();
  LOG(`ML server spawned (PID: ${mlProc.pid})`);
  // Wait for ML health check
  let mlReady = false;
  for (let i = 0; i < 12; i++) {
    await sleep(5000);
    try {
      const r = await httpGet('http://127.0.0.1:5001/docs', 3000);
      if (r.ok || r.code === 404 || r.code === 405) { mlReady = true; break; }
    } catch {}
    LOG(`Waiting for ML server... (${(i+1)*5}s)`);
  }
  if (mlReady) { OK('ML server is responding'); }
  else {
    const errLog = fs.readFileSync(mlLogErr, 'utf8').split('\n').slice(-5).join('\n');
    FAIL(`ML server not responding. Last errors:\n${errLog}`);
    failures++;
  }

  // ── Step 5: Start supervisor ──────────────────
  step(5, 'Start supervisor (live-runner.js)');
  const stdLog = fs.openSync(path.join(ROOT, 'logs', 'live-runner-stdout.log'), 'a');
  const errLogF = fs.openSync(path.join(ROOT, 'logs', 'live-runner-stderr.log'), 'a');
  const supProc = spawn('node', ['live-runner.js'], {
    cwd: ROOT,
    stdio: ['ignore', stdLog, errLogF],
    env: { ...process.env, SKIP_VITE: 'true', NODE_ENV: 'production' },
    detached: true,
  });
  supProc.unref();
  LOG(`Supervisor spawned (PID: ${supProc.pid})`);
  // Wait for engine health
  let engineReady = false;
  for (let i = 0; i < 12; i++) {
    await sleep(5000);
    const r = await httpGet('http://127.0.0.1:5000/api/health', 3000);
    if (r.ok) { engineReady = true; break; }
    LOG(`Waiting for engine... (${(i+1)*5}s)`);
  }
  if (engineReady) {
    const h = JSON.parse(await (await httpGet('http://127.0.0.1:5000/api/health', 3000)).body);
    OK(`Engine running | mode:${h.mode} | balance:${h.walletBalance} SOL | positions:${h.openPositions}`);
  } else { FAIL('Engine not responding on :5000 after 60s'); failures++; }

  // ── Step 6: Toggle isRunning ──────────────────
  step(6, 'Toggle engine isRunning=true');
  try {
    const secret = process.env.ADMIN_SECRET || 'crypto-trader-admin-2026';
    const postData = JSON.stringify({ isRunning: true });
    const r = await new Promise(resolve => {
      const req = http.request('http://127.0.0.1:5000/api/bot/toggle', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(postData),
          'x-admin-secret': secret,
        },
        timeout: 5000,
      }, res => { let d=''; res.on('data',c=>d+=c); res.on('end',()=>resolve({ok:res.statusCode===200,body:d})); });
      req.on('error', () => resolve({ok:false,body:''}));
      req.write(postData); req.end();
    });
    if (r.ok) { OK('Engine isRunning = true'); }
    else { FAIL(`Toggle failed: ${r.body}`); failures++; }
  } catch (e) { FAIL(`Toggle error: ${e.message}`); failures++; }

  // ── Summary ──────────────────
  console.log(`\n[${ts()}] ============ SUMMARY ============`);
  if (failures === 0) {
    OK(`All ${6} steps passed`);
    console.log(`[${ts()}] Engine: http://localhost:5000`);
    console.log(`[${ts()}] ML:     http://localhost:5001`);
  } else {
    FAIL(`${failures} step(s) failed — check logs above`);
  }
  console.log(`[${ts()}] ==================================\n`);
  process.exit(failures > 0 ? 1 : 0);
}

main();
