#!/bin/bash
while true; do
  if ! pgrep -f "dist/index.cjs" > /dev/null; then
    echo "$(date) Bot crashed. Restarting..." >> logs/crash.log
    cd "C:/Users/Admin/Downloads/god_ai/crypto-trader-v1_1" && node dist/index.cjs >> logs/console.log 2>&1 &
  fi
  sleep 2
done
