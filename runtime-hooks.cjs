const fs = require("fs");
const http = require("http");
const path = require("path");

const ROOT = process.cwd();
const HEARTBEAT_FILE = path.join(ROOT, ".heartbeat");
const HALT_FILE = path.join(ROOT, ".HALT");

let healthy = true;
let lastError = null;

function isHalted() { return fs.existsSync(HALT_FILE); }
function setUnhealthy(reason) { healthy = false; lastError = reason; }
function setHealthy() { healthy = true; lastError = null; }
function healthState() {
  return { status: healthy ? "ok" : "error", halted: isHalted(), lastError, ts: Date.now() };
}

function startHeartbeat(beat) {
  beat = beat || 5000;
  const writeBeat = function() { try { fs.writeFileSync(HEARTBEAT_FILE, String(Date.now())); } catch {} };
  writeBeat();
  const hb = setInterval(writeBeat, beat);
  if (typeof hb.unref === "function") hb.unref();
  process.on("uncaughtException", function(e) { setUnhealthy("uncaught: " + (e && e.message ? e.message : e)); });
  process.on("unhandledRejection", function(e) { setUnhealthy("unhandled: " + (e && e.message ? e.message : e)); });
  return hb;
}

function installRuntimeHooks(opts) {
  opts = opts || {};
  startHeartbeat(opts.heartbeatMs || 5000);
  if (opts.healthServer === false) return { isHalted: isHalted, setHealthy: setHealthy, setUnhealthy: setUnhealthy };
  var port = Number(opts.port || process.env.HEALTH_PORT || 3000);
  var server = http.createServer(function(req, res) {
    if (req.url === "/api/health" || req.url === "/health") {
      res.writeHead(healthy ? 200 : 503, { "Content-Type": "application/json" });
      res.end(JSON.stringify(healthState()));
    } else { res.writeHead(404); res.end(); }
  });
  server.listen(port, "127.0.0.1", function() {
    console.log("[HOOKS] health http://127.0.0.1:" + port + "/api/health | heartbeat " + (opts.heartbeatMs || 5000) + "ms");
  });
  if (typeof server.unref === "function") server.unref();
  return { isHalted: isHalted, setHealthy: setHealthy, setUnhealthy: setUnhealthy };
}

module.exports = { installRuntimeHooks, isHalted, setUnhealthy, setHealthy, startHeartbeat, healthState };