<#
.SYNOPSIS
    Emergency stop - kill the bot immediately and clean up lock files.
#>

$ErrorActionPreference = "Continue"
$ProjectRoot = "C:\god_ai\crypto-trader-v1_1"

Write-Host "=== EMERGENCY STOP ===" -ForegroundColor Red

# 1. Try graceful stop via API first (if bot is responsive)
try {
    $envFile = Join-Path $ProjectRoot ".env"
    $line = Get-Content $envFile | Select-String "^ADMIN_SECRET=" | Select-Object -First 1
    if ($line) {
        $adminSecret = ($line -replace "ADMIN_SECRET=", "").Trim()
        $body = @{ isRunning = $false } | ConvertTo-Json
        Invoke-RestMethod -Method Post -Uri http://localhost:5000/api/bot/toggle `
            -Headers @{ "x-admin-secret" = $adminSecret } `
            -ContentType "application/json" `
            -Body $body -TimeoutSec 3 | Out-Null
        Write-Host "  [OK] Bot isRunning=false via API" -ForegroundColor Green
    }
} catch {
    Write-Host "  [WARN] API not responsive - proceeding to hard kill" -ForegroundColor Yellow
}

# 2. Hard kill all node processes
$nodeProcs = Get-Process node -ErrorAction SilentlyContinue
if ($nodeProcs) {
    $nodeProcs | Stop-Process -Force
    Write-Host "  [OK] Killed $($nodeProcs.Count) node process(es)" -ForegroundColor Green
} else {
    Write-Host "  [OK] No node processes running" -ForegroundColor Green
}

# 3. Clean up stale lock and heartbeat files
Start-Sleep 1
$lockFiles = @(".heartbeat", ".engine.pid", ".failsafe.pid")
foreach ($f in $lockFiles) {
    $path = Join-Path $ProjectRoot $f
    if (Test-Path $path) {
        Remove-Item $path -Force
        Write-Host "  [OK] Removed: $f" -ForegroundColor Green
    }
}

# 4. Show any open positions
Write-Host ""
Write-Host "=== OPEN POSITIONS ===" -ForegroundColor Cyan
try {
    $open = Invoke-RestMethod http://localhost:5000/api/trades/open -TimeoutSec 3
    if ($open -and $open.Count -gt 0) {
        $open | Format-Table id, tokenSymbol, mode, amount, pnl -AutoSize
        Write-Host "  $($open.Count) open position(s) remain in DB." -ForegroundColor Yellow
    } else {
        Write-Host "  No open positions." -ForegroundColor Green
    }
} catch {
    Write-Host "  (Bot already down - cannot check open positions)" -ForegroundColor DarkGray
}

Write-Host ""
Write-Host "=== Bot stopped ===" -ForegroundColor Green
