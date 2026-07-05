// autofix.cjs -- UNATTENDED diagnose -> fix -> validate -> redeploy. No human approval.
//
// Safety model: the human approval gate is replaced by AUTOMATED gates.
// A fix only reaches LIVE trading after BOTH:
//   (a) the test suite passes  (npm test)
//   (b) a paper-mode canary runs clean for CANARY_MINUTES
// Until then the system stays HALTED and FLAT, so capital at risk is zero.
// If no fix passes within AUTOFIX_MAX_ATTEMPTS, it STOPS trying and stays safe
// (halted + flat) rather than looping a bad patch into live trading.
//
// Usage: node autofix.cjs <incidentFile.json>   (spawned automatically by failsafe.cjs)
const { execSync, spawn } = require("child_process");
const fs = require("fs");
const path = require("path");

const ROOT        = __dirname;
const HALT_FILE   = path.join(ROOT, ".HALT");
const STATE_FILE  = path.join(ROOT, ".autofix-state.json");
const MAIN_BRANCH = process.env.GIT_MAIN_BRANCH || "main";
const MAX_ATTEMPTS = parseInt(process.env.AUTOFIX_MAX_ATTEMPTS || "3", 10);
const WINDOW_MS    = parseInt(process.env.AUTOFIX_WINDOW_MS || String(24 * 3600 * 1000), 10);
const CANARY_MIN   = parseInt(process.env.CANARY_MINUTES || "15", 10);
// Headless coding-agent command. {INCIDENT} and {BRANCH} are substituted.
// Examples:
//   opencode run --headless --task "{INCIDENT}"
//   antigravity fix --non-interactive --input {INCIDENT}
const AGENT_CMD = process.env.AGENT_CMD || "";

function log(m) { console.log(`[AUTOFIX] ${new Date().toISOString()} ${m}`); }

async function alert(text) {
  const msg = `\u{1F527} AUTO-FIX\n${new Date().toISOString()}\n${text}`;
  try {
    if (process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID) {
      await fetch(`{{https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}}}/sendMessage`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: process.env.TELEGRAM_CHAT_ID, text: msg }),
      });
    }
    if (process.env.ALERT_WEBHOOK_URL) {
      await fetch(process.env.ALERT_WEBHOOK_URL, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: msg }),
      });
    }
  } catch (e) { console.error("alert failed", e.message); }
}

function sh(cmd, opts = {}) {
  log(`$ ${cmd}`);
  return execSync(cmd, { cwd: ROOT, stdio: "pipe", encoding: "utf8", ...opts });
}
function trySh(cmd, opts = {}) { try { return { ok: true, out: sh(cmd, opts) }; } catch (e) { return { ok: false, out: (e.stdout || "") + (e.stderr || e.message) }; } }

function loadState() { try { return JSON.parse(fs.readFileSync(STATE_FILE, "utf8")); } catch { return { attempts: [] }; } }
function saveState(s) { fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2)); }

// Coarse incident signature so we don't retry the SAME failure forever.
function signatureOf(incident) {
  const base = `${incident.reason || ""}`.replace(/[0-9]+/g, "#").slice(0, 120);
  return base || "unknown";
}

// Paper-mode canary: run the engine with LIVE=false for CANARY_MIN minutes and
// require a fresh heartbeat and zero FATAL log lines. Real funds are never used.
function paperCanary() {
  return new Promise((resolve) => {
    const hb = path.join(ROOT, ".heartbeat");
    try { fs.unlinkSync(hb); } catch {}
    const logFile = path.join(ROOT, "logs", "canary.log");
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    const fd = fs.openSync(logFile, "w");
    const child = spawn(process.execPath, [path.join(ROOT, "dist", "index.cjs")], {
      cwd: ROOT,
      env: { ...process.env, LIVE: "false", PAPER: "true" },
      stdio: ["ignore", fd, fd],
    });
    const deadline = Date.now() + CANARY_MIN * 60_000;
    const timer = setInterval(() => {
      const logTxt = (() => { try { return fs.readFileSync(logFile, "utf8"); } catch { return ""; } })();
      const fatal = /FATAL|UnhandledPromiseRejection|Cannot find module|SyntaxError/.test(logTxt);
      const hbFresh = (() => { try { return Date.now() - Number(fs.readFileSync(hb, "utf8").trim()) < 60_000; } catch { return false; } })();
      if (fatal) { clearInterval(timer); child.kill("SIGTERM"); return resolve({ ok: false, why: "FATAL in canary log" }); }
      if (Date.now() >= deadline) {
        clearInterval(timer); child.kill("SIGTERM");
        return resolve(hbFresh ? { ok: true } : { ok: false, why: "no fresh heartbeat during canary" });
      }
    }, 5_000);
    child.on("exit", (code) => { clearInterval(timer); resolve({ ok: false, why: `canary engine exited early (code ${code})` }); });
  });
}

(async function main() {
  const incidentFile = process.argv[2];
  let incident = {};
  try { incident = JSON.parse(fs.readFileSync(incidentFile, "utf8")); } catch {}
  const sig = signatureOf(incident);

  // Loop guard: count attempts for this signature within the rolling window.
  const state = loadState();
  const now = Date.now();
  state.attempts = state.attempts.filter(a => now - a.at < WINDOW_MS);
  const sameSig = state.attempts.filter(a => a.sig === sig).length;
  if (sameSig >= MAX_ATTEMPTS) {
    await alert(`STOPPED: "${sig}" hit ${MAX_ATTEMPTS} attempts in window. Staying HALTED + FLAT. Needs a human.`);
    log("max attempts reached -- staying safe");
    process.exit(3);
  }
  state.attempts.push({ at: now, sig });
  saveState(state);

  if (!AGENT_CMD) { await alert("AGENT_CMD not set -- cannot auto-fix. Staying HALTED + FLAT."); process.exit(4); }

  await alert(`Starting unattended fix for "${sig}" (attempt ${sameSig + 1}/${MAX_ATTEMPTS}). System is FLAT + HALTED.`);

  // 1. Fresh branch off main -- never touch the running checkout's working tree blindly.
  const branch = `autofix/${Date.now()}`;
  let r = trySh(`git fetch --all && git checkout ${MAIN_BRANCH} && git pull --ff-only && git checkout -b ${branch}`);
  if (!r.ok) { await alert(`git branch failed: ${r.out.slice(-300)}`); process.exit(5); }

  // 2. Hand the incident to the coding agent (headless / non-interactive).
  const prompt = `Fix the production incident described in ${incidentFile}. ` +
    `Reason: ${incident.reason}. Keep changes minimal. Do NOT touch key handling or position sizing. ` +
    `All tests in 'npm test' must pass.`;
  const agentCmd = AGENT_CMD.replace("{INCIDENT}", prompt.replace(/"/g, "'")).replace("{BRANCH}", branch);
  r = trySh(agentCmd, { timeout: 20 * 60_000 });
  if (!r.ok) { await alert(`agent run failed: ${r.out.slice(-300)}`); trySh(`git checkout -- . ; git checkout ${MAIN_BRANCH}`); process.exit(6); }

  // 2b. Commit the agent's edits onto the branch (agents don't always self-commit).
  trySh("git add -A");
  const committed = trySh(`git commit -m "autofix(agent): ${sig}" --no-verify`);
  if (/nothing to commit/i.test(committed.out)) {
    await alert("Agent produced NO changes -- staying HALTED + FLAT."); trySh(`git checkout ${MAIN_BRANCH}`); process.exit(6);
  }
  if (!committed.ok) {
    await alert(`Could not commit agent changes: ${committed.out.slice(-200)}`); trySh(`git checkout ${MAIN_BRANCH}`); process.exit(6);
  }

  // 3. AUTOMATED GATE A -- tests.
  r = trySh("npm test", { timeout: 15 * 60_000 });
  if (!r.ok) { await alert(`Tests FAILED -- discarding patch, staying HALTED.\n${r.out.slice(-300)}`); trySh(`git checkout ${MAIN_BRANCH}`); process.exit(7); }

  // 4. Build.
  r = trySh("npm run build", { timeout: 10 * 60_000 });
  if (!r.ok) { await alert(`Build FAILED -- discarding patch.\n${r.out.slice(-300)}`); trySh(`git checkout ${MAIN_BRANCH}`); process.exit(8); }

  // 5. AUTOMATED GATE B -- paper-mode canary (no real funds).
  await alert(`Tests green. Running ${CANARY_MIN}-min paper canary...`);
  const canary = await paperCanary();
  if (!canary.ok) { await alert(`Canary FAILED (${canary.why}) -- discarding patch, staying HALTED.`); trySh(`git checkout ${MAIN_BRANCH}`); process.exit(9); }

  // 6. Both gates passed -> merge, rebuild, clear HALT, go live. No human approval.
  r = trySh(`git checkout ${MAIN_BRANCH} && git merge --no-ff ${branch} -m "autofix: ${sig}" && npm run build`);
  if (!r.ok) { await alert(`Merge/build FAILED -- staying HALTED.\n${r.out.slice(-300)}`); process.exit(10); }

  // 6b. Optional: push to the git remote so the fix is persisted off-box.
  //     Off by default (AUTO_PUSH=false) -> commits stay local only.
  if (process.env.AUTO_PUSH === "true") {
    const remote = process.env.GIT_REMOTE || "origin";
    let pushed = trySh(`git push ${remote} ${MAIN_BRANCH}`);
    // If the remote moved during the run, rebase our merge on top and retry once.
    if (!pushed.ok && /non-fast-forward|fetch first|behind|rejected/i.test(pushed.out)) {
      const sync = trySh(`git pull --rebase ${remote} ${MAIN_BRANCH}`);
      if (sync.ok) { trySh("npm run build"); pushed = trySh(`git push ${remote} ${MAIN_BRANCH}`); }
      else { trySh("git rebase --abort"); }
    }
    await alert(pushed.ok
      ? `Pushed fix to ${remote}/${MAIN_BRANCH}.`
      : `Push FAILED (fix is LIVE locally, just not pushed): ${pushed.out.slice(-200)}`);
  }

  try { fs.unlinkSync(HALT_FILE); } catch {}        // clear HALT -> engine may trade again
  try { fs.unlinkSync(path.join(ROOT, ".PANIC")); } catch {}

  // Restart the live engine (pm2 or systemd, whichever manages it).
  const restart = trySh(process.platform === "win32"
    ? `pm2 restart ${process.env.ENGINE_PM2_NAME || "trading-engine"}`
    : `systemctl restart trading-engine || pm2 restart ${process.env.ENGINE_PM2_NAME || "trading-engine"}`);

  await alert(`AUTO-FIX APPLIED & LIVE \u2705  "${sig}" fixed, tests+canary green, engine ${restart.ok ? "restarted" : "restart NEEDS CHECK"}.`);
  log("done -- live again");
  process.exit(0);
})();
