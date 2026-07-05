#!/bin/bash
echo "Starting 1000x ROI Continuous Monitor..."
# Ensure bot is running
if ! tasklist | grep -qi "node.exe"; then
    node dist/index.cjs >> logs/console.log 2>&1 &
    sleep 5
fi

while true; do
    res=$(curl -s http://localhost:5000/api/bot/status 2>/dev/null)
    stats=$(curl -s http://localhost:5000/api/engine/stats 2>/dev/null)
    
    if [ -n "$res" ] && [ -n "$stats" ]; then
        bal=$(echo "$res" | grep -o '"walletBalance":"[^"]*"' | cut -d'"' -f4)
        wr=$(echo "$stats" | grep -o '"winRate":"[^"]*"' | cut -d'"' -f4)
        trades=$(echo "$stats" | grep -o '"totalTrades":[^,}]*' | cut -d':' -f2)
        sig=$(echo "$res" | grep -o '"lastSignal":"[^"]*"' | cut -d'"' -f4)
        
        echo "[1000x TRACKER] Target: 2.900 SOL | Current: ${bal} SOL | Trades: ${trades} | WR: ${wr}% | Last: ${sig}"
    else
        echo "[!] API Unreachable. Executing Instant Disaster Recovery..."
        taskkill //F //IM node.exe //T >/dev/null 2>&1
        sleep 2
        node dist/index.cjs >> logs/console.log 2>&1 &
        echo "[+] Recovery Complete. Bot restarted."
        sleep 10
    fi
    sleep 15
done
