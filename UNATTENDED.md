# Fully unattended operation (no approval for restart or fixes)

This mode runs the whole system with **zero human approval** for restarts and code
fixes. The catch: "no human approval" does **not** mean "no checks." The human
gate is replaced by **automated gates**, because the alternative -- letting an AI
patch and instantly resume a live engine that controls a real wallet -- can turn a
single bug into a continuous drain.

## What runs without approval

| Event | Action | Approval? |
| --- | --- | --- |
| Engine crashes | pm2/systemd/run.ps1 auto-restart | None |
| Boot / reboot | Scheduled Task relaunches everything | None |
| Health failure / hang | Watchdog: HALT -> KILL -> LIQUIDATE -> FLAG | None |
| After liquidation | `autofix.cjs` diagnoses + patches + redeploys | None |

## The two automated gates a fix MUST pass before going live

1. **Tests** -- `npm test` must pass.
2. **Paper canary** -- the patched engine runs in paper mode (`LIVE=false`) for
   `CANARY_MINUTES` with a fresh heartbeat and zero FATAL log lines. No real funds.

Until both pass, the system stays **HALTED and FLAT** (positions already sold), so
capital at risk is zero while it iterates. If no fix passes within
`AUTOFIX_MAX_ATTEMPTS` for the same failure signature, it **stops trying** and stays
safe rather than looping a bad patch into live trading.

## Always-on money guards (even with humans fully out of the loop)

- **Crash-loop breaker** (`MAX_RESTART_LOOP`): too many restarts in a row ->
  liquidate + stay down instead of thrashing into losses.
- **Daily loss breaker** (`MAX_DAILY_LOSS_SOL`): engine self-HALTs + liquidates if
  realized daily loss crosses the limit. (Add this check to your P&L tracker.)
- **Liquidate-first ordering**: every incident sells to SOL *before* any fix is
  attempted, so the wallet is safe regardless of whether the fix works.

## Setup for unattended run

1. In `.env` set:
   - `AUTO_FIX=true`
   - `AGENT_CMD=...` your headless coding agent (opencode / antigravity). Use the
     `{INCIDENT}` and `{BRANCH}` placeholders.
   - `GIT_MAIN_BRANCH`, `CANARY_MINUTES`, `AUTOFIX_MAX_ATTEMPTS`, `MAX_DAILY_LOSS_SOL`.
2. Make the repo a git checkout the agent can branch/merge on the box.
3. Add a real `npm test` suite -- it is now your safety net. Weak tests = weak safety.
4. Run `INSTALL-AUTOSTART.cmd` as Administrator (boot auto-start), then start once
   via `TRADING-SYSTEM.cmd` -> Start, or just reboot.

## Residual risk (read this once)

Fully unattended auto-merge to live trading means a fix that passes tests + canary
but is still subtly wrong **can** trade real funds before you ever see it. The
guards above cap the damage (flat-first, loss breaker, attempt cap) but do not make
it zero. The single biggest lever on your safety is the quality of `npm test` and
the length/realism of the paper canary. Invest there.

---

# Coding-agent integration + single-command run

## How the agent plugs in

```
incident  ->  failsafe.cjs  ->  autofix.cjs  ->  AGENT_CMD  ->  agent-run.cjs  ->  your agent
                                   |                                   (opencode / antigravity / custom)
                                   +-- gates: npm test + paper canary -> merge -> restart live
```

- `agent-run.cjs` is a thin adapter. You never edit `autofix.cjs` to switch agents --
  just set `AGENT_PROVIDER` in `.env`.
- **opencode:** `AGENT_PROVIDER=opencode` (bootstrap runs `npm i -g opencode-ai`).
- **antigravity:** `AGENT_PROVIDER=antigravity` (install the Antigravity CLI on PATH).
- **anything else:** `AGENT_PROVIDER=custom` and put the literal command in
  `AGENT_RAW_CMD`, e.g. `AGENT_RAW_CMD=claude -p "{INCIDENT}"`.

The agent runs on a fresh `autofix/<ts>` branch, in the repo root, with the incident
as its task. Its output only reaches live trading after tests + the paper canary pass.

## Single command, end to end

**Windows:** double-click **`GO.cmd`** (or run `run.ps1 bootstrap`). It will:
check Node + git -> create `.env` if missing -> `git init` -> `npm install` ->
install the coding agent -> `npm run build` -> start engine + failsafe unattended.

```bat
GO.cmd
```

**Linux / macOS:**

```bash
chmod +x bootstrap.sh && ./bootstrap.sh
```

First run creates `.env` and stops so you can fill in secrets (wallet key, RPC,
`AGENT_PROVIDER`). Run the same command again and the full system comes up live and
self-healing. For boot persistence on Windows, run `INSTALL-AUTOSTART.cmd` once as admin.
