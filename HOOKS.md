# Engine hooks + health endpoint (now implemented)

The heartbeat, HALT guard, and health endpoint are shipped as drop-in modules so
you don't hand-write them. Pick the one matching your engine source language.

## If your engine is TypeScript (compiled by `npm run build`)

File: `server/runtime-hooks.ts` (already in the zip). In your engine entry
(`server/live-runner.ts` or wherever `main()` starts):

```ts
import { installRuntimeHooks, isHalted } from "./runtime-hooks";

installRuntimeHooks();   // starts heartbeat (5s) + health server on HEALTH_PORT
```

Then at the very top of every buy decision (e.g. inside `buyToken` / your signal handler):

```ts
if (isHalted()) return;  // failsafe pulled the HALT flag -- stop digging
```

## If your engine is plain JavaScript

File: `runtime-hooks.cjs` (root of the zip).

```js
const { installRuntimeHooks, isHalted } = require("./runtime-hooks.cjs");
installRuntimeHooks();
// ...
if (isHalted()) return;
```

## What each piece does

- **Heartbeat:** writes `Date.now()` to `.heartbeat` every 5s. The watchdog treats a
  file older than 60s as a hang and triggers HALT -> KILL -> LIQUIDATE -> FLAG.
- **HALT guard:** `isHalted()` returns true when the `.HALT` flag exists; your buy
  path must bail out so a partially-alive engine stops buying instantly.
- **Health endpoint:** `GET http://127.0.0.1:<HEALTH_PORT>/api/health` returns
  `{ "status": "ok", "halted": false, ... }`. Matches the watchdog's `HEALTH_URL`.
  A deliberate halt still returns 200 (so the watchdog won't re-panic an intentionally
  halted engine); genuine failures return 503 with `status:"error"`.
- **Crash visibility:** uncaught exceptions / rejections flip the endpoint to
  `error` so the watchdog acts even before the process dies.

## Optional: signal a bad internal state yourself

If your strategy detects something wrong (e.g. RPC all-down, P&L breaker tripped),
call `setUnhealthy("reason")` and the watchdog will liquidate + (if AUTO_FIX) start
the agent. Call `setHealthy()` to clear it.

```ts
import { setUnhealthy } from "./runtime-hooks";
if (dailyLossSol > Number(process.env.MAX_DAILY_LOSS_SOL || 0.5)) {
  setUnhealthy("daily loss breaker");
}
```
