// runtime-hooks.ts -- heartbeat + HALT guard + (optional) health endpoint.
//
// Two ways to use it:
//  A) Your app ALREADY serves /api/health (this project's routes.ts does):
//       import { startHeartbeat, isHalted } from "./runtime-hooks";
//       startHeartbeat();                 // heartbeat only, no second server
//  B) Your app has NO health endpoint:
//       import { installRuntimeHooks, isHalted } from "./runtime-hooks";
//       installRuntimeHooks();            // heartbeat + standalone health server
//
// Then at the TOP of every buy decision:  if (isHalted()) return;
import fs from "fs";
import http from "http";
import path from "path";

const ROOT           = process.cwd();
const HEARTBEAT_FILE = path.join(ROOT, ".heartbeat");
const HALT_FILE      = path.join(ROOT, ".HALT");

let healthy = true;
let lastError: string | null = null;

/** True when the failsafe has halted trading. Check at the top of every buy. */
export function isHalted(): boolean { return fs.existsSync(HALT_FILE); }
export function setUnhealthy(reason: string): void { healthy = false; lastError = reason; }
export function setHealthy(): void { healthy = true; lastError = null; }
/** Snapshot for a health endpoint to return. "halted" stays 200 (intentional state). */
export function healthState() {
  return { status: healthy ? "ok" : "error", halted: isHalted(), lastError, ts: Date.now() };
}

/** Heartbeat ONLY -- use when your app already serves /api/health. */
export function startHeartbeat(beat = 5000) {
  const writeBeat = () => { try { fs.writeFileSync(HEARTBEAT_FILE, String(Date.now())); } catch {} };
  writeBeat();
  const hb = setInterval(writeBeat, beat);
  if (typeof hb.unref === "function") hb.unref();
  process.on("uncaughtException",  (e: any) => setUnhealthy(`uncaught: ${e?.message ?? e}`));
  process.on("unhandledRejection", (e: any) => setUnhealthy(`unhandled: ${e?.message ?? e}`));
  return hb;
}

/** Heartbeat + standalone health server -- use when you DON'T already serve /api/health. */
export function installRuntimeHooks(opts: { port?: number; heartbeatMs?: number; healthServer?: boolean } = {}) {
  startHeartbeat(opts.heartbeatMs ?? 5000);
  if (opts.healthServer === false) return { isHalted, setHealthy, setUnhealthy };
  const port = opts.port ?? Number(process.env.HEALTH_PORT ?? 3000);
  const server = http.createServer((req, res) => {
    if (req.url === "/api/health" || req.url === "/health") {
      res.writeHead(healthy ? 200 : 503, { "Content-Type": "application/json" });
      res.end(JSON.stringify(healthState()));
    } else { res.writeHead(404); res.end(); }
  });
  server.listen(port, "127.0.0.1", () =>
    console.log(`[HOOKS] health http://127.0.0.1:${port}/api/health | heartbeat ${opts.heartbeatMs ?? 5000}ms`));
  if (typeof server.unref === "function") server.unref();
  return { isHalted, setHealthy, setUnhealthy };
}
