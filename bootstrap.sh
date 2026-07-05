#!/usr/bin/env bash
# Single command, Linux/macOS: bootstrap + run the full system end to end.
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p logs

if [ ! -f .env ]; then
  cp .env.example .env
  echo "[bootstrap] Created .env -- fill in secrets (wallet, RPC, AGENT_PROVIDER) then re-run."
  exit 1
fi
set -a; . ./.env; set +a

command -v node >/dev/null || { echo "Install Node 18+"; exit 1; }
command -v git  >/dev/null || { echo "Install git";      exit 1; }

if [ ! -d .git ]; then
  echo "[bootstrap] git init (required for unattended auto-fix)"
  git init -q; git add -A; git commit -qm bootstrap; git branch -M "${GIT_MAIN_BRANCH:-main}"
fi

[ -d node_modules ] || npm install

case "${AGENT_PROVIDER:-custom}" in
  opencode)    command -v opencode    >/dev/null || npm i -g opencode-ai ;;
  antigravity) command -v antigravity >/dev/null || echo "[bootstrap] Install Antigravity CLI on PATH" ;;
  *)           echo "[bootstrap] Using custom AGENT_RAW_CMD" ;;
esac

npm run build

if command -v pm2 >/dev/null; then
  pm2 start ecosystem.config.js && pm2 save
elif systemctl list-unit-files 2>/dev/null | grep -q trading-engine; then
  sudo systemctl restart trading-engine trading-failsafe
else
  nohup node dist/live-runner.js > logs/engine.out.log   2>&1 & echo $! > .engine.pid
  nohup node failsafe.cjs        > logs/failsafe.out.log 2>&1 & echo $! > .failsafe.pid
fi

echo "[bootstrap] End-to-end system is LIVE and self-healing."
