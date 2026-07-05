/**
 * LIVE RUNNER v2 — Autonomous agent with continuous monitoring,
 * automated failover, disaster recovery, and self-healing.
 *
 * Acts as an autonomous trading operations agent that:
 *   1. Continuously monitors server health (15s interval)
 *   2. Monitors RPC endpoints and wallet balance
 *   3. Auto-kills and restarts on failure
 *   4. Force-sells all open positions before failover
 *   5. Auto-switches to paper mode after repeated crashes
 *   6. Sends alerts via webhook on critical events
 *   7. Cleans up stale resources automatically
 *   8. Shuts down gracefully with position closure
 */
import { spawn, exec } from "child_process";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";
import { existsSync, appendFileSync, mkdirSync, writeFileSync, readFileSync } from "fs";
import http from "http";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ── Config ────────────────────────────────────────────────────────────
const LOG_DIR = resolve(__dirname, "logs");
if (!existsSync(LOG_DIR)) mkdirSync(LOG_DIR, { recursive: true });

const LOG_FILE = resolve(LOG_DIR, `live-runner-${new Date().toISOString().split("T")[0]}.log`);
const PID_FILE = resolve(__dirname, ".live-runner.pid");

const HEALTH_CHECK_PORT = parseInt(process.env.PORT || "5000", 10);
const HEALTH_CHECK_TIMEOUT_MS = 5_000;
const HEALTH_CHECK_INTERVAL_MS = 15_000;
const RPC_CHECK_INTERVAL_MS = 60_000;
const WALLET_CHECK_INTERVAL_MS = 120_000;
const MAX_RESTART_DELAY_MS = 30_000;
const INITIAL_RESTART_DELAY_MS = 1_000;
const MAX_CRASHES_BEFORE_GIVEUP = 5;
const CRASH_WINDOW_MS = 5 * 60_000;
const FAILOVER_TO_PAPER_AFTER_CRASHES = 3;
const BALANCE_DROP_ALERT_PCT = 50;
const BALANCE_SYNC_INTERVAL_MS = 60_000;
const WEBHOOK_URL = process.env.ALERT_WEBHOOK_URL || null;

// ── State ─────────────────────────────────────────────────────────────
let child = null;
let crashCount = 0;
let lastCrashTime = 0;
let healthCheckInterval = null;
let rpcCheckInterval = null;
let walletCheckInterval = null;
let syncBalanceInterval = null;
let isShuttingDown = false;
let lastKnownBalance = 0;
let lastAlertTime = 0;

// ── PID ───────────────────────────────────────────────────────────────
try { writeFileSync(PID_FILE, String(process.pid)); } catch {}

// ── Logging ───────────────────────────────────────────────────────────
function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  try { appendFileSync(LOG_FILE, line + "\n"); } catch {}
}

// ── Alerting (Telegram / Discord / Slack via webhook) ─────────────────
function sendAlert(message, level = "WARN") {
  const now = Date.now();
  if (now - lastAlertTime < 30_000) return; // rate-limit: max 1 alert per 30s
  lastAlertTime = now;
  const payload = { text: `[${level}] LIVE-RUNNER: ${message}`, timestamp: new Date().toISOString() };
  log(`[ALERT ${level}] ${message}`);
  if (!WEBHOOK_URL) return;
  const data = JSON.stringify(payload);
  const url = new URL(WEBHOOK_URL);
  const req = http.request({
    hostname: url.hostname, port: url.port || 443, path: url.pathname,
    method: "POST", headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) },
    timeout: 5000,
  }, (res) => { res.resume(); });
  req.on("error", (e) => { /* silently ignore webhook failures */ });
  req.write(data);
  req.end();
}

// ── Self-heal: clean stale resources ─────────────────────────────────
function clearStaleResources() {
  try {
    const viteCache = resolve(__dirname, "node_modules", ".vite", "deps");
    if (existsSync(viteCache)) {
      exec(`rmdir /s /q "${viteCache}" 2>nul`, { windowsHide: true }, (err) => {});
      log("[SELF-HEAL] Cleared stale Vite deps cache");
    }
    const stalePidFile = resolve(__dirname, "bot.pid");
    if (existsSync(stalePidFile)) {
      try {
        const oldPid = parseInt(readFileSync(stalePidFile, "utf8").trim(), 10);
        if (oldPid) exec(`taskkill /PID ${oldPid} /T /F 2>nul`, { windowsHide: true }, () => {});
      } catch {}
      try { writeFileSync(stalePidFile, ""); } catch {}
      log("[SELF-HEAL] Cleaned stale bot.pid");
    }
  } catch (e) {
    log(`[SELF-HEAL] Cleanup error: ${e.message}`);
  }
}

// ── HTTP helper ───────────────────────────────────────────────────────
function httpGet(path) {
  return new Promise((resolve) => {
    const url = `http://127.0.0.1:${HEALTH_CHECK_PORT}${path}`;
    const req = http.get(url, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => resolve({ status: res.statusCode, body: data }));
    });
    req.on("error", () => resolve(null));
    req.setTimeout(HEALTH_CHECK_TIMEOUT_MS, () => { req.destroy(); resolve(null); });
  });
}

function httpPost(path) {
  return new Promise((resolve) => {
    const data = JSON.stringify({});
    const options = {
      hostname: "127.0.0.1", port: HEALTH_CHECK_PORT, path, method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) },
      timeout: 10_000,
    };
    const req = http.request(options, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode, body }));
    });
    req.on("error", (e) => { log(`[HTTP POST] ${path} failed: ${e.message}`); resolve(null); });
    req.write(data);
    req.end();
  });
}

// ── 1. Emergency sell-all (live positions) ────────────────────────────
async function emergencySellAll(reason) {
  log(`[EMERGENCY] Force-selling all open positions — reason: ${reason}`);
  try {
    const result = await httpPost("/api/bot/force-sell-all");
    if (result && result.status === 200) {
      const parsed = JSON.parse(result.body);
      log(`[EMERGENCY] Sell-all complete: ${parsed.closedCount || 0} positions closed, balance: ${parsed.newBalance || "?"} SOL`);
      sendAlert(`🛑 Emergency sell-all: ${parsed.closedCount || 0} positions closed (${reason})`, "CRITICAL");
    } else {
      log(`[EMERGENCY] Sell-all HTTP ${result?.status || "failed"} — server may be down, skipping on-chain sell`);
      sendAlert(`🛑 Emergency sell-all attempted but server unresponsive (${reason})`, "CRITICAL");
    }
  } catch (e) {
    log(`[EMERGENCY] Sell-all exception: ${e.message}`);
  }
}

// ── 2. Switch to paper mode ───────────────────────────────────────────
function switchToPaperMode() {
  log("[FAILOVER] Switching DB trading mode to PAPER to protect funds...");
  sendAlert("🛑 Failover: switching to PAPER mode", "CRITICAL");
  try {
    const script = resolve(__dirname, "set_paper.cjs");
    if (existsSync(script)) {
      const fail = exec(`node "${script}"`, { cwd: __dirname, windowsHide: true });
      fail.stdout?.on("data", (d) => log(`[FAILOVER] ${d.toString().trim()}`));
      fail.stderr?.on("data", (d) => log(`[FAILOVER ERR] ${d.toString().trim()}`));
      fail.on("exit", (code) => log(`[FAILOVER] set_paper.cjs exited with code ${code}`));
    } else {
      log("[FAILOVER] set_paper.cjs not found — cannot auto-switch to paper mode");
    }
  } catch (e) {
    log(`[FAILOVER] Failed to switch to paper mode: ${e.message}`);
  }
}

// ── 3. Health check ───────────────────────────────────────────────────
function checkHealth() {
  return new Promise((resolve) => {
    const url = `http://127.0.0.1:${HEALTH_CHECK_PORT}/api/health`;
    const req = http.get(url, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        const ok = res.statusCode === 200;
        if (ok) {
          try {
            const h = JSON.parse(data);
            if (h.walletBalance) lastKnownBalance = parseFloat(h.walletBalance);
            if (h.mode === "paper" && h.openPositions === 0) {
              log("[HEALTH] Server is in paper mode with no positions — stable");
            }
          } catch {}
        } else {
          log(`[HEALTH] HTTP ${res.statusCode} from /api/health — body: ${data.slice(0, 100)}`);
        }
        resolve(ok);
      });
    });
    req.on("error", (err) => {
      resolve(false);
    });
    req.setTimeout(HEALTH_CHECK_TIMEOUT_MS, () => {
      req.destroy();
      resolve(false);
    });
  });
}

// ── 4. RPC health monitoring ──────────────────────────────────────────
async function checkRpcHealth() {
  if (!child || isShuttingDown) return;
  const result = await httpGet("/api/wallet");
  if (!result) {
    log("[RPC] Wallet endpoint unreachable — server may be starting");
    return;
  }
  if (result.status === 200) {
    try {
      const w = JSON.parse(result.body);
      if (!w.connected) {
        sendAlert("⚠️ RPC disconnected — wallet not reachable", "CRITICAL");
      }
    } catch {}
  }
}

// ── 5. Wallet balance monitoring ──────────────────────────────────────
async function checkWalletBalance() {
  if (!child || isShuttingDown) return;
  const result = await httpGet("/api/health");
  if (!result || result.status !== 200) return;
  try {
    const h = JSON.parse(result.body);
    const current = parseFloat(h.walletBalance || "0");
    if (lastKnownBalance > 0 && current > 0 && current < lastKnownBalance * (1 - BALANCE_DROP_ALERT_PCT / 100)) {
      sendAlert(
        `⚠️ Wallet balance DROPPED ${(((lastKnownBalance - current) / lastKnownBalance) * 100).toFixed(1)}% — ` +
        `${lastKnownBalance.toFixed(4)} → ${current.toFixed(4)} SOL. Possible loss.`,
        "CRITICAL"
      );
    }
    if (current > 0) lastKnownBalance = current;
    if (current < 0.005) {
      log(`[WALLET] Critically low balance: ${current.toFixed(4)} SOL — trading will be skipped`);
    }
  } catch {}
}

// ── 6. Continuous wallet balance sync ────────────────────────────────
async function syncWalletBalance() {
  if (!child || isShuttingDown) return;
  const result = await httpGet("/api/wallet");
  if (!result || result.status !== 200) return;
  try {
    const w = JSON.parse(result.body);
    if (w.balanceSol === undefined || w.balanceSol === null) return;
    const onChainBal = parseFloat(w.balanceSol);
    if (isNaN(onChainBal) || onChainBal <= 0) return;
    if (Math.abs(onChainBal - lastKnownBalance) > 0.0001) {
      log(`[BALANCE SYNC] Wallet: ${onChainBal.toFixed(4)} SOL (prev: ${lastKnownBalance.toFixed(4)} SOL)`);
      lastKnownBalance = onChainBal;
    }
    const script = resolve(__dirname, "sync_balance.cjs");
    if (existsSync(script)) {
      exec(`node "${script}" ${onChainBal.toFixed(4)}`, { cwd: __dirname, windowsHide: true }, (err, stdout) => {
        if (err) log(`[BALANCE SYNC] DB write error: ${err.message}`);
      });
    } else {
      // Fallback: inline SQL via pg
      exec(
        `node -e "const{Client}=require('pg');const c=new Client({connectionString:process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/crypto_db'});c.connect().then(()=>c.query('UPDATE bot_status SET wallet_balance=\\'${onChainBal.toFixed(4)}\\'')).then(()=>{console.log('BALANCE SYNCED');c.end();}).catch(e=>{console.error(e.message);process.exit(1);})"`,
        { cwd: __dirname, timeout: 5000, windowsHide: true },
        (err, stdout) => {
          if (stdout) log(`[BALANCE SYNC] ${stdout.trim()}`);
          if (err && err.message) log(`[BALANCE SYNC] DB error: ${err.message.substring(0, 100)}`);
        }
      );
    }
  } catch (e) {
    log(`[BALANCE SYNC] Parse error: ${e.message}`);
  }
}
async function startHealthChecks() {
  if (healthCheckInterval) clearInterval(healthCheckInterval);
  healthCheckInterval = setInterval(async () => {
    if (!child || isShuttingDown) return;
    const alive = await checkHealth();
    if (!alive) {
      sendAlert("🔄 Server health check FAILED — initiating recovery", "WARN");
      log("[HEALTH] Health check FAILED — server not responding on port " + HEALTH_CHECK_PORT);
      log("[HEALTH] Attempting emergency sell + recovery kill + restart...");
      await emergencySellAll("health_check_failure");
      killChild();
    }
  }, HEALTH_CHECK_INTERVAL_MS);
}

async function startPeriodicChecks() {
  if (rpcCheckInterval) clearInterval(rpcCheckInterval);
  rpcCheckInterval = setInterval(() => checkRpcHealth(), RPC_CHECK_INTERVAL_MS);

  if (walletCheckInterval) clearInterval(walletCheckInterval);
  walletCheckInterval = setInterval(() => checkWalletBalance(), WALLET_CHECK_INTERVAL_MS);

  if (syncBalanceInterval) clearInterval(syncBalanceInterval);
  // Run immediately then every BALANCE_SYNC_INTERVAL_MS
  syncWalletBalance();
  syncBalanceInterval = setInterval(() => syncWalletBalance(), BALANCE_SYNC_INTERVAL_MS);
}

// ── Process management ────────────────────────────────────────────────
function killProcessTree(pid) {
  if (!pid) return Promise.resolve();
  return new Promise((resolve) => {
    const cmd = process.platform === "win32"
      ? `taskkill /PID ${pid} /T /F`
      : `kill -9 ${pid}`;
    exec(cmd, { windowsHide: true }, (err) => {
      if (err) log(`[KILL] ${cmd} result: ${err.message}`);
      resolve();
    });
  });
}

function killChild() {
  if (!child) return;
  const pid = child.pid;
  try { child.kill("SIGTERM"); } catch (e) { log(`[KILL] SIGTERM failed: ${e.message}`); }
  setTimeout(async () => {
    if (child) {
      try { child.kill("SIGKILL"); } catch {}
      await killProcessTree(pid);
    }
    child = null;
  }, 5_000);
}

// ── Server lifecycle ──────────────────────────────────────────────────
function startServer() {
  if (isShuttingDown) return;
  if (child) killChild();

  clearStaleResources();

  const now = Date.now();
  const recentCrashes = crashCount > 0 && now - lastCrashTime < CRASH_WINDOW_MS;

  if (recentCrashes && crashCount >= MAX_CRASHES_BEFORE_GIVEUP) {
    const msg = `Crash threshold exceeded (${crashCount} crashes in <${CRASH_WINDOW_MS / 60000}min). Stopping auto-restart.`;
    log(`[SUPERVISOR] ${msg}`);
    sendAlert(`🛑 ${msg}`, "CRITICAL");
    emergencySellAll("crash_threshold_exceeded").then(() => {
      switchToPaperMode();
      shutdown("CRASH_LIMIT");
    });
    return;
  }

  const delay = Math.min(
    INITIAL_RESTART_DELAY_MS * Math.pow(2, Math.min(crashCount, 5)),
    MAX_RESTART_DELAY_MS
  );

  if (crashCount > 0 && recentCrashes) {
    log(`[SUPERVISOR] Crash #${crashCount} — waiting ${delay}ms before restart...`);
  }

  setTimeout(() => {
    log("[SUPERVISOR] Starting trading server...");
    const serverPath = resolve(__dirname, "server/index.ts");
    child = spawn("npx", ["tsx", serverPath], {
      cwd: __dirname,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        NODE_ENV: "production",
        SKIP_VITE: "true",
        PORT: String(HEALTH_CHECK_PORT),
      },
      shell: true,
      windowsHide: true,
    });

    child.stdout.on("data", (d) => { process.stdout.write(d); appendFileSync(resolve(__dirname, "logs/crash.log"), d); });
    child.stderr.on("data", (d) => { process.stderr.write(d); appendFileSync(resolve(__dirname, "logs/crash.log"), d); });

    child.on("error", (err) => {
      log(`[SUPERVISOR] Process error: ${err.message}`);
    });

    child.on("exit", async (code, signal) => {
      const exitInfo = `exit_code=${code} signal=${signal}`;
      log(`[SUPERVISOR] Process terminated (${exitInfo})`);
      child = null;
      if (isShuttingDown) return;
      crashCount++;
      lastCrashTime = Date.now();

      if (crashCount === FAILOVER_TO_PAPER_AFTER_CRASHES) {
        sendAlert(`🔄 ${FAILOVER_TO_PAPER_AFTER_CRASHES} crashes reached — emergency sell + switch to paper`, "CRITICAL");
        await emergencySellAll("crash_threshold_reached");
        switchToPaperMode();
      }

      setTimeout(() => startServer(), 2_000);
    });

    setTimeout(() => {
      if (child) startHealthChecks();
    }, 10_000);
  }, crashCount > 0 ? delay : 500);
}

// ── Graceful shutdown ─────────────────────────────────────────────────
async function shutdown(signal) {
  if (isShuttingDown) return;
  isShuttingDown = true;
  log(`[SUPERVISOR] Received ${signal} — executing full shutdown sequence...`);
  sendAlert(`🔄 Supervisor shutting down (${signal})`, "INFO");

  if (healthCheckInterval) clearInterval(healthCheckInterval);
  if (rpcCheckInterval) clearInterval(rpcCheckInterval);
  if (walletCheckInterval) clearInterval(walletCheckInterval);
  if (syncBalanceInterval) clearInterval(syncBalanceInterval);

  // Final balance sync before shutdown
  await syncWalletBalance();
  await emergencySellAll(`supervisor_shutdown_${signal}`);
  switchToPaperMode();
  killChild();
  try { writeFileSync(PID_FILE, ""); } catch {}
  setTimeout(() => process.exit(0), 1000);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("uncaughtException", (err) => {
  log(`[FATAL] Uncaught exception in supervisor: ${err.message}`);
  shutdown("UNCAUGHT");
});
process.on("unhandledRejection", (reason) => {
  log(`[FATAL] Unhandled rejection in supervisor: ${String(reason)}`);
});

// ── Start ──────────────────────────────────────────────────────────────
log("======================================================");
log("LIVE RUNNER v2 — Autonomous Trading Operations Agent");
log("PID: " + process.pid);
log("Health endpoint: http://127.0.0.1:" + HEALTH_CHECK_PORT + "/api/health");
log("Log file: " + LOG_FILE);
log("Alerts: " + (WEBHOOK_URL ? "ENABLED" : "DISABLED (set ALERT_WEBHOOK_URL)"));
log("======================================================");
clearStaleResources();
startServer();
startPeriodicChecks();

log("[AGENT] Continuous monitoring active — all automated mitigations online");
log("[AGENT]   • Health check every " + (HEALTH_CHECK_INTERVAL_MS / 1000) + "s → kill+restart on failure");
log("[AGENT]   • Emergency sell-all on crash × " + FAILOVER_TO_PAPER_AFTER_CRASHES);
log("[AGENT]   • Paper-mode failover after " + FAILOVER_TO_PAPER_AFTER_CRASHES + " crashes");
log("[AGENT]   • Hard stop after " + MAX_CRASHES_BEFORE_GIVEUP + " crashes in " + (CRASH_WINDOW_MS / 60000) + "min");
log("[AGENT]   • RPC health check every " + (RPC_CHECK_INTERVAL_MS / 1000) + "s");
log("[AGENT]   • Wallet balance monitoring every " + (WALLET_CHECK_INTERVAL_MS / 60000) + "min");
log("[AGENT]   • Self-heal: stale Vite cache + PID cleanup on startup");
log("[AGENT]   • Wallet balance sync every " + (BALANCE_SYNC_INTERVAL_MS / 1000) + "s → DB updated with real on-chain balance");
log("[AGENT] Agent online — waiting for server to start...");
