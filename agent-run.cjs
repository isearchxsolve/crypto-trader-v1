// agent-run.cjs -- adapter so AUTO_FIX can drive ANY headless coding agent.
// AUTO_FIX (autofix.cjs) calls AGENT_CMD; point AGENT_CMD at this adapter:
//     AGENT_CMD=node agent-run.cjs "{INCIDENT}" {BRANCH}
// Then choose the agent with AGENT_PROVIDER=opencode|antigravity|custom.
const { spawnSync } = require("child_process");
const fs   = require("fs");
const path = require("path");

// Load .env (zero-dependency) so this adapter works the SAME whether it's run
// standalone for testing or spawned by autofix.cjs. The real environment always
// wins -- we only fill vars that aren't already set (standard dotenv behavior).
try {
  const envPath = path.join(__dirname, ".env");
  for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
    if (!line || line.trim().startsWith("#")) continue;
    const m = line.match(/^\s*([\w.-]+)\s*=\s*(.*)$/);
    if (!m) continue;
    const k = m[1];
    const v = m[2].trim().replace(/^["']|["']$/g, "");
    if (!(k in process.env)) process.env[k] = v;
  }
} catch { /* no .env present -> rely on inherited environment */ }

const prompt   = process.argv[2] || "Fix the latest production incident. Keep changes minimal. npm test must pass.";
const branch   = process.argv[3] || "";
const provider = (process.env.AGENT_PROVIDER || "custom").toLowerCase();
const root     = __dirname;
const onWin    = process.platform === "win32";

function exec(cmd, args) {
  console.log(`[AGENT] provider=${provider} branch=${branch}`);
  console.log(`[AGENT] exec: ${cmd} ${args.join(" ")}`);
  const r = spawnSync(cmd, args, { cwd: root, stdio: "inherit", env: process.env, shell: onWin });
  return r.status == null ? 1 : r.status;
}
function run(cmd, args) {
  process.exit(exec(cmd, args));
}
function sleepSync(ms) {
  // synchronous backoff inside this blocking adapter (no async context here)
  if (ms > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
// Like exec(), but CAPTURES output so we can tell a transient rate-limit from a
// permanent error and decide whether retrying is worthwhile. Still prints output.
function execCapture(cmd, args, timeoutMs) {
  console.log(`[AGENT] provider=${provider} branch=${branch}`);
  console.log(`[AGENT] exec: ${cmd} ${args.join(" ")}`);
  const r = spawnSync(cmd, args, { cwd: root, env: process.env, shell: onWin, encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024, timeout: timeoutMs > 0 ? timeoutMs : undefined, killSignal: "SIGTERM" });
  const out = (r.stdout || "") + (r.stderr || "");
  if (out) process.stdout.write(out.endsWith("\n") ? out : out + "\n");
  const timedOut = !!(r.error && r.error.code === "ETIMEDOUT") || r.signal === "SIGTERM";
  return { status: r.status == null ? 1 : r.status, out, timedOut };
}
// Heuristic: does the agent output look like a TRANSIENT (worth-retrying) failure?
// Permanent errors (no permission / unsupported field / no such model) return false.
function isRateLimit(s) {
  return /\b429\b|\b503\b|rate.?limit|too many requests|tokens per minute|\bTPM\b|quota|overloaded|capacity|temporarily unavailable|timed? ?out/i.test(s || "");
}

switch (provider) {
  case "opencode": {
    // opencode non-interactive run mode -- edits the repo in place on the current branch.
    // Quota/rate-limit resilience: "free" models are NOT unlimited (rate limits + daily quotas),
    // so we (1) try an ordered CHAIN of models and (2) retry each a few times with backoff to
    // ride out transient 429s. Chain = AGENT_MODELS (comma-separated) OR [AGENT_MODEL, FALLBACK].
    // If the whole chain is exhausted we exit non-zero: autofix then reverts, ALERTS A HUMAN,
    // and the system stays HALTED + FLAT. Downstream gates (npm test + canary) guard correctness.
    const models = (process.env.AGENT_MODELS
      ? process.env.AGENT_MODELS.split(",")
      : [process.env.AGENT_MODEL, process.env.AGENT_MODEL_FALLBACK]
    ).map((s) => (s || "").trim()).filter(Boolean);
    if (models.length === 0) { run("opencode", ["run", prompt]); break; }
    const retries = Math.max(0, parseInt(process.env.AGENT_MODEL_RETRIES || "1", 10));
    const backoff = Math.max(0, parseInt(process.env.AGENT_RETRY_BACKOFF_MS || "20000", 10));
    // Per-attempt timeout so a hung/slow free model can't eat the whole 20-min budget.
    const timeoutMs = Math.max(0, parseInt(process.env.AGENT_MODEL_TIMEOUT_MS || "180000", 10));
    for (let m = 0; m < models.length; m++) {
      for (let attempt = 0; attempt <= retries; attempt++) {
        const { status, out, timedOut } = execCapture("opencode", ["run", "--model", models[m], prompt], timeoutMs);
        if (status === 0) process.exit(0);
        if (timedOut) {
          console.error(`[AGENT] ${models[m]} timed out after ${Math.round(timeoutMs / 1000)}s [hung]; switching to next model...`);
          break; // a hung model will likely hang again -- don't retry, move on
        }
        // Only retry TRANSIENT failures (rate limit / quota / overload). Permanent
        // errors (403 no-permission, 400 unsupported field, 404 no such model) will
        // never clear, so switch models immediately instead of wasting the backoff.
        const transient = isRateLimit(out);
        const willRetry = transient && attempt < retries;
        const willSwitch = !willRetry && m < models.length - 1;
        console.error(`[AGENT] ${models[m]} failed (exit ${status}) ` +
          (transient ? "[transient/rate-limit]" : "[permanent error]") + "; " + (
          willRetry ? `retry ${attempt + 1}/${retries} in ${Math.round(backoff * (attempt + 1) / 1000)}s...`
          : willSwitch ? "switching to next model..."
          : "chain exhausted."));
        if (willRetry) sleepSync(backoff * (attempt + 1));
        else break; // permanent error, or retries exhausted -> move to next model
      }
    }
    console.error("[AGENT] all models exhausted -- staying SAFE (HALTED+FLAT), human required.");
    process.exit(1);
  }
  case "antigravity":
    // Antigravity headless task mode.
    run("antigravity", ["run", "--headless", "--prompt", prompt]);
    break;
  default: {
    // custom: put your literal command in AGENT_RAW_CMD ({INCIDENT}/{BRANCH} substituted).
    const raw = (process.env.AGENT_RAW_CMD || "")
      .replace("{INCIDENT}", prompt)
      .replace("{BRANCH}", branch);
    if (!raw) { console.error("[AGENT] AGENT_PROVIDER=custom but AGENT_RAW_CMD is empty."); process.exit(2); }
    run(onWin ? "cmd" : "sh", [onWin ? "/c" : "-c", raw]);
  }
}
