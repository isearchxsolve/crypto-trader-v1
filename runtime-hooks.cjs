// runtime-hooks.cjs -- heartbeat + HALT guard + (optional) health endpoint (plain JS).
const fs = require("fs");
const http = require("http");
const path = require("path");

const ROOT           = process.cwd();
const HEARTBEAT_FILE = path.join(ROOT, ".heartbeat");
const HALT_FILE      = path.join(ROOT, ".HALT");

let healthy = true;
let lastError = null;

function isHalted() { return fs.existsSync(HALT_FILE); }
function setUnhealthy(reason) { healthy = false; lastError = reason; }
function setHealthy() { healthy = true; lastError = null; }
function healthState() { return { status: healthy ? "ok" : "error", halted: isHalted(), lastError, ts: Date.now() }; }

function startHeartbeat(beat) {
  beat = beat || 5000;
  const writeBeat = () => { try { fs.writeFileSync(HEARTBEAT_FILE, String(Date.now())); } catch {} };
  writeBeat();
  const hb = setInterval(writeBeat, beat);
  if (hb.unref) hb.unref();
  process.on("uncaughtException",  (e) => setUnhealthy(`uncaught: ${(e && e.message) || e}`));
  process.on("unhandledRejection", (e) => setUnhealthy(`unhandled: ${(e && e.message) || e}`));
  return hb;
}

function installRuntimeHooks(opts = {}) {
  startHeartbeat(opts.heartbeatMs);
  if (opts.healthServer === false) return { isHalted, setHealthy, setUnhealthy };
  const port = opts.port != null ? opts.port : Number(process.env.HEALTH_PORT || 3000);
  const server = http.createServer((req, res) => {
    if (req.url === "/api/health" || req.url === "/health") {
      res.writeHead(healthy ? 200 : 503, { "Content-Type": "application/json" });
      res.end(JSON.stringify(healthState()));
    } else { res.writeHead(404); res.end(); }
  });
  server.listen(port, "127.0.0.1", () =>
    console.log(`[HOOKS] health http://127.0.0.1:${port}/api/health`));
  if (server.unref) server.unref();
  return { isHalted, setHealthy, setUnhealthy };
}

module.exports = { installRuntimeHooks, startHeartbeat, isHalted, setHealthy, setUnhealthy, healthState };
