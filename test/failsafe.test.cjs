// failsafe.test.cjs -- safety-invariant gate for unattended AUTO_FIX.
// These tests MUST pass before any agent-proposed fix is allowed back into live trading
// (autofix.cjs runs `npm test` as automated GATE A). Run locally with:  npm test
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

// Isolate ALL .HALT/.heartbeat file I/O in a throwaway temp dir BEFORE loading runtime-hooks,
// so the test run can never halt or disturb a live engine using the real project root.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "failsafe-test-"));
process.chdir(TMP);

const hooks = require("../runtime-hooks.cjs");
const { decideLiveness } = require("../failsafe.cjs");

const HALT = path.join(TMP, ".HALT");
const BEAT = path.join(TMP, ".heartbeat");
const rm = (f) => { try { fs.unlinkSync(f); } catch {} };

test("HALT guard: isHalted() false with no flag, true once .HALT exists", () => {
  rm(HALT);
  assert.strictEqual(hooks.isHalted(), false);
  fs.writeFileSync(HALT, "test halt");
  assert.strictEqual(hooks.isHalted(), true);
  rm(HALT);
  assert.strictEqual(hooks.isHalted(), false);
});

test("healthState(): ok -> error (setUnhealthy) -> ok (setHealthy)", () => {
  hooks.setHealthy();
  assert.strictEqual(hooks.healthState().status, "ok");
  hooks.setUnhealthy("boom");
  const s = hooks.healthState();
  assert.strictEqual(s.status, "error");
  assert.strictEqual(s.lastError, "boom");
  hooks.setHealthy();
  assert.strictEqual(hooks.healthState().status, "ok");
});

test("healthState().halted mirrors the HALT flag", () => {
  fs.writeFileSync(HALT, "halt");
  assert.strictEqual(hooks.healthState().halted, true);
  rm(HALT);
  assert.strictEqual(hooks.healthState().halted, false);
});

test("startHeartbeat(): writes a fresh timestamp to .heartbeat", () => {
  rm(BEAT);
  const hb = hooks.startHeartbeat(60_000); // writes once immediately, then every 60s
  clearInterval(hb);
  const val = Number(fs.readFileSync(BEAT, "utf8").trim());
  assert.ok(Number.isFinite(val), "heartbeat must contain a numeric timestamp");
  assert.ok(Date.now() - val < 5_000, "heartbeat timestamp must be fresh");
});

// --- Dual-signal watchdog decision (the core of the false-PANIC fix) ---
test("decideLiveness: ALIVE when both signals good", () => {
  assert.strictEqual(decideLiveness({ ok: true }, { ok: true }), null);
});

test("decideLiveness: ALIVE on heartbeat-only (HTTP unreachable)", () => {
  assert.strictEqual(
    decideLiveness({ ok: true }, { ok: false, reason: "health unreachable" }), null);
});

test("decideLiveness: ALIVE on HTTP-only (heartbeat stale)", () => {
  assert.strictEqual(
    decideLiveness({ ok: false, reason: "heartbeat stale 200s" }, { ok: true }), null);
});

test("decideLiveness: ESCALATE only when BOTH signals fail", () => {
  const r = decideLiveness(
    { ok: false, reason: "heartbeat stale 200s" },
    { ok: false, reason: "health unreachable: fetch failed" });
  assert.ok(typeof r === "string", "must return an escalation reason");
  assert.match(r, /heartbeat stale/);
  assert.match(r, /unreachable/);
});
