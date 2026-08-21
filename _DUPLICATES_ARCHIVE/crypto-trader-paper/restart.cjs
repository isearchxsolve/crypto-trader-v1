// restart.cjs — PAPER ENGINE restart (ports 5002/5003, paper mode)
// IMPORTANT: This script manages the PAPER engine only.
// It does NOT touch port 5000 (live engine) or port 5001 (live ML server).
const { execSync, spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');
require('dotenv').config({ override: true });

const ROOT = __dirname;
const ENGINE_PORT = 5002;
const ML_PORT     = 5003;

const ts   = () => new Date().toISOString().replace(/^(.+)T(.+)\..+$/, '$1 $2');
const LOG  = (m) => console.log(`[${ts()}] [PAPER-RESTART] ${m}`);
const WARN = (m) => console.log(`[${ts()}] [PAPER-RESTART ⚠] ${m}`);
const OK   = (m) => console.log(`[${ts()}] [PAPER-RESTART ✓] ${m}`);
const FAIL = (m) => { console.log(`[${ts()}] [PAPER-RESTART ✗] ${m}`); process.exitCode = 1; };

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
  console.log(`\n[${ts()}] ============ PAPER ENGINE RESTART (Port ${ENGINE_PORT}) ============`);
  let failures = 0;
  const step = (n, label) => console.log(`\n[${ts()}] --- Step ${n}: ${label} ---`);

  // ── Step 1: Kill ONLY paper engine ports (5002, 5003) ──
  step(1, `Kill old paper processes (ports ${ENGINE_PORT}, ${ML_PORT})`);
  LOG(`Killing process on port ${ENGINE_PORT} (paper engine)...`);
  exec(`for /f "tokens=5" %a in ('netstat -ano ^| findstr ":${ENGINE_PORT}" ^| findstr "LISTENING"') do taskkill /F /PID %a 2>nul`);
  LOG(`Killing process on port ${ML_PORT} (paper ML server)...`);
  exec(`for /f "tokens=5" %a in ('netstat -ano ^| findstr ":${ML_PORT}" ^| findstr "LISTENING"') do taskkill /F /PID %a 2>nul`);
  await sleep(2000);
  const p0 = await waitPort(ENGINE_PORT, true, 'Paper Engine', 10000);
  const p1 = await waitPort(ML_PORT, true, 'Paper ML', 10000);
  if (!p0 || !p1) failures++;

  // ── Step 2: Clean stale artifacts ──
  step(2, 'Clean stale artifacts');
  ['bot.pid', 'node_modules/.vite/deps'].forEach(f => {
    const p = path.join(ROOT, f);
    try { fs.rmSync(p, { recursive: true, force: true }); LOG(`Removed ${f}`); } catch {}
  });
  OK('Stale artifacts cleaned');

  // ── Step 3: Set DB to PAPER mode ──
  step(3, 'Set DB to PAPER mode');
  try {
    const { Pool } = require('pg');
    const pool = new Pool({
      connectionString: process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/postgres',
      connectionTimeoutMillis: 5000,
    });
    await pool.query(`UPDATE bot_status SET trading_mode = 'paper', is_running = false`);
    const r = await pool.query('SELECT trading_mode FROM bot_status');
    const mode = r.rows[0]?.trading_mode;
    if (mode === 'paper') { OK(`DB trading_mode = ${mode}`); }
    else { FAIL(`DB trading_mode = ${mode}, expected 'paper'`); failures++; }
    await pool.end();
  } catch (e) { FAIL(`DB connection failed: ${e.message}`); failures++; }

  // ── Step 4: Start paper ML server on port 5003 ──
  step(4, `Start ML server on port ${ML_PORT}`);
  const mlDir    = path.join(ROOT, 'solana_hybrid_sniper_ultra');
  const mlLogOut = path.join(ROOT, 'logs', 'ml_server_out.log');
  const mlLogErr = path.join(ROOT, 'logs', 'ml_server_err.log');
  const mlOut = fs.openSync(mlLogOut, 'a');
  const mlErr = fs.openSync(mlLogErr, 'a');
  const mlProc = spawn('python', ['ml_server.py'], {
    cwd: mlDir,
    stdio: ['ignore', mlOut, mlErr],
    env: { ...process.env, ML_PORT: String(ML_PORT) },
    detached: true,
  });
  mlProc.unref();
  LOG(`ML server spawned (PID: ${mlProc.pid})`);
  let mlReady = false;
  for (let i = 0; i < 12; i++) {
    await sleep(5000);
    try {
      const r = await httpGet(`http://127.0.0.1:${ML_PORT}/docs`, 3000);
      if (r.ok || r.code === 404 || r.code === 405) { mlReady = true; break; }
    } catch {}
    LOG(`Waiting for ML server... (${(i+1)*5}s)`);
  }
  if (mlReady) { OK('ML server is responding'); }
  else {
    const errLog = fs.readFileSync(mlLogErr, 'utf8').split('\n').slice(-5).join('\n');
    WARN(`ML server not responding — paper engine will run without ML scoring.\nLast errors:\n${errLog}`);
    // Not a fatal failure for paper mode
  }

  // ── Step 5: Start paper supervisor ──
  step(5, 'Start paper supervisor (live-runner.js)');
  const stdLog  = fs.openSync(path.join(ROOT, 'logs', 'live-runner-stdout.log'), 'a');
  const errLogF = fs.openSync(path.join(ROOT, 'logs', 'live-runner-stderr.log'), 'a');
  const supProc = spawn('node', ['live-runner.js'], {
    cwd: ROOT,
    stdio: ['ignore', stdLog, errLogF],
    env: {
      ...process.env,
      SKIP_VITE: 'true',
      NODE_ENV: 'production',
      PORT: String(ENGINE_PORT),
      ML_PORT: String(ML_PORT),
    },
    detached: true,
  });
  supProc.unref();
  LOG(`Supervisor spawned (PID: ${supProc.pid})`);
  let engineReady = false;
  for (let i = 0; i < 12; i++) {
    await sleep(5000);
    const r = await httpGet(`http://127.0.0.1:${ENGINE_PORT}/api/health`, 3000);
    if (r.ok) { engineReady = true; break; }
    LOG(`Waiting for engine... (${(i+1)*5}s)`);
  }
  if (engineReady) {
    const h = JSON.parse((await httpGet(`http://127.0.0.1:${ENGINE_PORT}/api/health`, 3000)).body);
    OK(`Paper engine running | mode:${h.mode} | balance:${h.walletBalance} SOL | positions:${h.openPositions}`);
  } else { FAIL(`Paper engine not responding on :${ENGINE_PORT} after 60s`); failures++; }

  // ── Step 6: Toggle isRunning ──
  step(6, 'Toggle paper engine isRunning=true');
  try {
    const secret = process.env.ADMIN_SECRET || 'crypto-trader-admin-2026';
    const postData = JSON.stringify({ isRunning: true });
    const r = await new Promise(resolve => {
      const req = http.request(`http://127.0.0.1:${ENGINE_PORT}/api/bot/toggle`, {
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
    if (r.ok) { OK('Paper engine isRunning = true'); }
    else { FAIL(`Toggle failed: ${r.body}`); failures++; }
  } catch (e) { FAIL(`Toggle error: ${e.message}`); failures++; }

  // ── Summary ──
  console.log(`\n[${ts()}] ============ SUMMARY ============`);
  if (failures === 0) {
    OK(`All 6 steps passed`);
    console.log(`[${ts()}] Paper Engine: http://localhost:${ENGINE_PORT}`);
    console.log(`[${ts()}] Paper ML:     http://localhost:${ML_PORT}`);
  } else {
    FAIL(`${failures} step(s) failed — check logs above`);
  }
  console.log(`[${ts()}] ==================================\n`);
  process.exit(failures > 0 ? 1 : 0);
}

main();
