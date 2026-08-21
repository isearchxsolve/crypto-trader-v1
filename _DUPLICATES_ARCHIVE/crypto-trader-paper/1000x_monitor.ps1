Write-Host "Starting 1000x ROI Continuous Monitor..."
$target = 2.900

# Ensure running
if (!(Get-Process node -ErrorAction SilentlyContinue)) {
    Start-Process node -ArgumentList "dist/index.cjs" -NoNewWindow -RedirectStandardOutput "logs/console.log" -RedirectStandardError "logs/console.err.log"
    Start-Sleep 5
}

while ($true) {
    try {
        $res = Invoke-RestMethod -Uri "http://localhost:5000/api/bot/status" -TimeoutSec 3 -ErrorAction Stop
        $stats = Invoke-RestMethod -Uri "http://localhost:5000/api/engine/stats" -TimeoutSec 3 -ErrorAction Stop
        
        $bal = $res.walletBalance
        $wr = $stats.winRate
        $trades = $stats.totalTrades
        $sig = $res.lastSignal
        
        Write-Host "[1000x TRACKER] Target: $target SOL | Current: $bal SOL | Trades: $trades | WR: $wr% | Last: $sig"
    } catch {
        Write-Host "[!] API Unreachable. Executing Instant Disaster Recovery..."
        Get-Process node -ErrorAction SilentlyContinue | Stop-Process -Force
        Start-Sleep 2
        Start-Process node -ArgumentList "dist/index.cjs" -NoNewWindow -RedirectStandardOutput "logs/console.log" -RedirectStandardError "logs/console.err.log"
        Write-Host "[+] Recovery Complete. Bot restarted."
        Start-Sleep 10
    }
    Start-Sleep 15
}
