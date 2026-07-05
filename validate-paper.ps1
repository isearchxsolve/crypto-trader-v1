<#
.SYNOPSIS
    Validate paper-mode results against go-live gates.
    Run this after 24-48 hours of paper trading (need 30+ closed trades).

.DESCRIPTION
    Checks the bot's stats against the design targets:
      - Win rate >= 88%       (design target: 91.3%)
      - Avg loss >= -8%
      - Max drawdown < 15%
      - Paper/shadow PnL gap < 3%
      - Closed trades >= 30

    All gates must pass before switching to live mode.

.EXAMPLE
    .\validate-paper.ps1
#>

$ErrorActionPreference = "Continue"
$ProjectRoot = "C:\god_ai\crypto-trader-v1_1"

if (-not (Test-Path $ProjectRoot)) {
    Write-Host "Project root not found: $ProjectRoot" -ForegroundColor Red
    exit 1
}
Set-Location $ProjectRoot

# Load admin secret
$envFile = Join-Path $ProjectRoot ".env"
if (-not (Test-Path $envFile)) {
    Write-Host ".env file not found" -ForegroundColor Red
    exit 1
}
$line = Get-Content $envFile | Select-String "^ADMIN_SECRET=" | Select-Object -First 1
if (-not $line) {
    Write-Host "ADMIN_SECRET not set in .env" -ForegroundColor Red
    exit 1
}
$adminSecret = ($line -replace "ADMIN_SECRET=", "").Trim()

Write-Host ""
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  PAPER MODE VALIDATION - GO-LIVE GATES" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan

# --- CHECK 1: API IS UP ---

Write-Host ""
Write-Host "[1/5] Checking API connectivity..." -ForegroundColor Yellow

try {
    $health = Invoke-RestMethod http://localhost:5000/api/health -TimeoutSec 5
} catch {
    Write-Host "  FAIL: API not reachable at http://localhost:5000" -ForegroundColor Red
    Write-Host "  Start the bot first: .\GO.cmd" -ForegroundColor Yellow
    exit 1
}

if ($health.mode -ne "paper") {
    Write-Host "  FAIL: Bot is NOT in paper mode (current: $($health.mode))" -ForegroundColor Red
    Write-Host "  Switch to paper first or you risk real SOL losses!" -ForegroundColor Red
    exit 1
}

if (-not $health.isRunning) {
    Write-Host "  FAIL: Bot is not running" -ForegroundColor Red
    exit 1
}

Write-Host "  OK: API up, paper mode confirmed, bot running" -ForegroundColor Green

# --- CHECK 2: GATHER STATS ---

Write-Host ""
Write-Host "[2/5] Gathering trade statistics..." -ForegroundColor Yellow

try {
    $stats = Invoke-RestMethod http://localhost:5000/api/engine/stats -TimeoutSec 10
} catch {
    Write-Host "  FAIL: Could not fetch engine stats: $($_.Exception.Message)" -ForegroundColor Red
    exit 1
}

try {
    $shadow = Invoke-RestMethod http://localhost:5000/api/shadow/trades -TimeoutSec 10
} catch {
    Write-Host "  WARN: Could not fetch shadow trades (continuing without shadow check)" -ForegroundColor Yellow
    $shadow = $null
}

# --- CHECK 3: DISPLAY RAW STATS ---

Write-Host ""
Write-Host "[3/5] Current statistics:" -ForegroundColor Yellow

Write-Host ""
Write-Host "  Trade counts:" -ForegroundColor Cyan
Write-Host "    Total trades:     $($stats.totalTrades)"
Write-Host "    Closed trades:    $($stats.closedTrades)"
Write-Host "    Open trades:      $($stats.openTrades)"
Write-Host "    Wins:             $($stats.wins)"
Write-Host "    Losses:           $($stats.losses)"

Write-Host ""
Write-Host "  Performance:" -ForegroundColor Cyan
Write-Host "    Win rate:         $($stats.winRate)%"
Write-Host "    Avg win:          +$($stats.avgWinPct)%"
Write-Host "    Avg loss:         $($stats.avgLossPct)%"
Write-Host "    Total PnL:        $($stats.totalPnlSol) SOL"
Write-Host "    Daily PnL:        $($stats.dailyPnlSol) SOL"
Write-Host "    SOL/hour:         $($stats.solPerHour)"

Write-Host ""
Write-Host "  Risk:" -ForegroundColor Cyan
Write-Host "    Peak balance:     $($stats.peakBalance) SOL"
Write-Host "    Drawdown:         $($stats.drawdownPct)%"
Write-Host "    Consec. losses:   $($stats.consecutiveLosses)"
Write-Host "    Consec. wins:     $($stats.consecutiveWins)"
Write-Host "    Circuit breaker:  $($stats.circuitBreakerActive)"

Write-Host ""
Write-Host "  Best/Worst trades:" -ForegroundColor Cyan
if ($stats.bestTrade) {
    Write-Host "    Best:  $($stats.bestTrade.symbol)  +$($stats.bestTrade.pnl)%  ($($stats.bestTrade.mode))"
}
if ($stats.worstTrade) {
    Write-Host "    Worst: $($stats.worstTrade.symbol)  $($stats.worstTrade.pnl)%  ($($stats.worstTrade.mode))"
}

if ($shadow) {
    Write-Host ""
    Write-Host "  Shadow mode (paper vs simulated live):" -ForegroundColor Cyan
    Write-Host "    Total shadow trades:  $($shadow.summary.totalShadowTrades)"
    Write-Host "    Avg paper PnL:        $($shadow.summary.avgPaperPnlPct)%"
    Write-Host "    Avg shadow PnL:       $($shadow.summary.avgShadowPnlPct)%"
    Write-Host "    Avg PnL gap:          $($shadow.summary.avgPnlGapPct)%"
    Write-Host "    Avg price impact:     $($shadow.summary.avgPriceImpactPct)%"
    Write-Host "    Interpretation:       $($shadow.summary.interpretation)"
}

# --- CHECK 4: EVALUATE GO-LIVE GATES ---

Write-Host ""
Write-Host "[4/5] Evaluating go-live gates..." -ForegroundColor Yellow

$gates = @()

# Gate 1: Sample size
$closedTrades = [int]$stats.closedTrades
$sampleOk = $closedTrades -ge 30
$gates += [PSCustomObject]@{
    Name = "Sample size (>= 30 trades)"
    Value = "$closedTrades trades"
    Pass = $sampleOk
    Target = ">= 30"
}

# Gate 2: Win rate
$wr = [double]$stats.winRate
$wrOk = $wr -ge 88
$gates += [PSCustomObject]@{
    Name = "Win rate (>= 88%)"
    Value = "$wr%"
    Pass = $wrOk
    Target = ">= 88%"
}

# Gate 3: Avg loss
$avgLoss = [double]$stats.avgLossPct
$avgLossOk = $avgLoss -ge -8
$gates += [PSCustomObject]@{
    Name = "Avg loss (>= -8%)"
    Value = "$avgLoss%"
    Pass = $avgLossOk
    Target = ">= -8%"
}

# Gate 4: Drawdown
$dd = [double]$stats.drawdownPct
$ddOk = $dd -lt 15
$gates += [PSCustomObject]@{
    Name = "Max drawdown (< 15%)"
    Value = "$dd%"
    Pass = $ddOk
    Target = "< 15%"
}

# Gate 5: Paper/shadow gap (if shadow data available)
$gapOk = $true
if ($shadow -and $shadow.summary.totalShadowTrades -ge 10) {
    $gap = [double]$shadow.summary.avgPnlGapPct
    $gapOk = $gap -lt 3
    $gates += [PSCustomObject]@{
        Name = "Paper/Live gap (< 3%)"
        Value = "$gap%"
        Pass = $gapOk
        Target = "< 3%"
    }
} else {
    Write-Host "  (Skipping shadow gate - need 10+ shadow trades for meaningful comparison)" -ForegroundColor DarkGray
}

# Gate 6: Circuit breaker not tripping
$cbOk = -not [bool]$stats.circuitBreakerActive
$gates += [PSCustomObject]@{
    Name = "Circuit breaker (not active)"
    Value = "$($stats.circuitBreakerActive)"
    Pass = $cbOk
    Target = "false"
}

# Gate 7: Profit factor (wins/losses by SOL amount)
$profitFactor = 0
if ($stats.losses -gt 0 -and [double]$stats.avgLossPct -lt 0) {
    $grossWin = [double]$stats.wins * [double]$stats.avgWinPct
    $grossLoss = [double]$stats.losses * [math]::Abs([double]$stats.avgLossPct)
    if ($grossLoss -gt 0) {
        $profitFactor = [math]::Round($grossWin / $grossLoss, 2)
    } else {
        $profitFactor = 99  # no losses = infinite profit factor
    }
}
$pfOk = $profitFactor -ge 2.5
$gates += [PSCustomObject]@{
    Name = "Profit factor (>= 2.5)"
    Value = "$profitFactor"
    Pass = $pfOk
    Target = ">= 2.5"
}

# Display gate table
Write-Host ""
foreach ($g in $gates) {
    $status = if ($g.Pass) { "[PASS]" } else { "[FAIL]" }
    $color = if ($g.Pass) { "Green" } else { "Red" }
    $name = $g.Name.PadRight(36)
    $value = $g.Value.PadRight(12)
    Write-Host "  $status $name $value  (target: $($g.Target))" -ForegroundColor $color
}

# --- CHECK 5: FINAL VERDICT ---

Write-Host ""
Write-Host "[5/5] Final verdict..." -ForegroundColor Yellow

$allPass = ($gates | Where-Object { -not $_.Pass }).Count -eq 0

if ($allPass) {
    Write-Host ""
    Write-Host "  ===========================================" -ForegroundColor Green
    Write-Host "  ALL GATES PASSED - SAFE TO SWITCH TO LIVE" -ForegroundColor Green
    Write-Host "  ===========================================" -ForegroundColor Green

    Write-Host ""
    Write-Host "  Next steps:" -ForegroundColor Cyan
    Write-Host "    1. Verify your live wallet balance:"
    Write-Host "       Invoke-RestMethod http://localhost:5000/api/wallet | Format-List"
    Write-Host ""
    Write-Host "    2. Switch to live mode:"
    Write-Host '       $body = @{ mode = "live"; confirmed = $true } | ConvertTo-Json'
    Write-Host '       Invoke-RestMethod -Method Post -Uri http://localhost:5000/api/bot/trading-mode `'
    Write-Host '           -Headers @{ "x-admin-secret" = $adminSecret } `'
    Write-Host '           -ContentType "application/json" -Body $body'
    Write-Host ""
    Write-Host "    3. Watch the first 5 live trades VERY carefully:"
    Write-Host '       Get-Content .\logs\trading.log -Wait -Tail 50 | '
    Write-Host '           Select-String "LIVE|LIVE_FEE|OVERSPEND|SAFETY-VETO|LIFECYCLE"'
    Write-Host ""
    Write-Host "    4. After 20 live trades, re-run this script - live should be >= 80% win rate."
} else {
    $failCount = ($gates | Where-Object { -not $_.Pass }).Count
    Write-Host ""
    Write-Host "  ===========================================" -ForegroundColor Red
    Write-Host "  GATES NOT MET - DO NOT SWITCH TO LIVE MODE" -ForegroundColor Red
    Write-Host "  ===========================================" -ForegroundColor Red

    Write-Host ""
    Write-Host "  Failed gates ($failCount of $($gates.Count)):" -ForegroundColor Yellow
    $gates | Where-Object { -not $_.Pass } | ForEach-Object {
        Write-Host "    - $($_.Name)" -ForegroundColor Red
        Write-Host "      Got: $($_.Value)   Target: $($_.Target)"
    }

    Write-Host ""
    Write-Host "  Recommended actions:" -ForegroundColor Cyan

    if (-not $sampleOk) {
        Write-Host "    * Sample size too small - let paper mode run longer."
        Write-Host "      Need 30+ trades for statistically meaningful results."
    }
    if (-not $wrOk) {
        Write-Host "    * Win rate too low - review logs for which exits are firing:"
        Write-Host '      Get-Content .\logs\trading.log | Select-String "LIFECYCLE:EXIT" | Select-Object -Last 20'
        Write-Host "      If HARD_LOSS_KILL fires often, exits are too slow."
        Write-Host "      If many SAFETY-VETO rejections, PATCH #1 veto list may be too aggressive."
    }
    if (-not $avgLossOk) {
        Write-Host "    * Avg loss too deep - HARD_LOSS_KILL (-10%) is firing late."
        Write-Host "      Check RPC latency: Invoke-RestMethod http://localhost:5000/api/latency/log"
    }
    if (-not $ddOk) {
        Write-Host "    * Drawdown too high - sizing may be too aggressive for current market."
        Write-Host "      Consider lowering tierPct in getTieredSizing() temporarily."
    }
    if ($shadow -and -not $gapOk) {
        Write-Host "    * Paper/Live gap too wide - live will lose money."
        Write-Host "      Avg price impact: $($shadow.summary.avgPriceImpactPct)%"
        Write-Host "      If impact > 3%, need higher liquidity floor (sniperMinLiquidity)."
    }
    if (-not $cbOk) {
        Write-Host "    * Circuit breaker is active - wait for it to clear before evaluating."
    }
    if (-not $pfOk) {
        Write-Host "    * Profit factor too low - wins are not big enough relative to losses."
        Write-Host "      Consider raising trailingStopActivation (currently 5%) to let winners run."
    }
}

Write-Host ""
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  Validation complete" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
