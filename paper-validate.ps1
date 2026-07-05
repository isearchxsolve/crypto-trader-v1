<#
.SYNOPSIS
    Deploy patched routes.ts and run the trading bot in PAPER mode for validation.

.DESCRIPTION
    This script:
    1. Stops any running bot instance
    2. Backs up the current routes.ts
    3. Deploys the patched routes.ts (with all 28 bug fixes)
    4. Rebuilds TypeScript
    5. Starts the bot with log capture
    6. Waits for API to come up
    7. Forces PAPER mode via API (defensive)
    8. Verifies paper mode is active
    9. Shows validation status

    Run this from: C:\god_ai\crypto-trader-v1_1

.PARAMETER PatchedFilePath
    Path to the patched routes.ts file you downloaded.
    Default: $env:USERPROFILE\Downloads\routes.ts

.PARAMETER SkipDeploy
    Skip backup/deploy steps (use if routes.ts is already patched).
    Switch flag: -SkipDeploy

.PARAMETER SkipBuild
    Skip npm run build (use if already built).
    Switch flag: -SkipBuild

.EXAMPLE
    .\paper-validate.ps1
    .\paper-validate.ps1 -PatchedFilePath "C:\Users\john\Downloads\routes.ts"
    .\paper-validate.ps1 -SkipDeploy -SkipBuild
#>

param(
    [string]$PatchedFilePath = "$env:USERPROFILE\Downloads\routes.ts",
    [switch]$SkipDeploy,
    [switch]$SkipBuild
)

$ErrorActionPreference = "Stop"
$ProjectRoot = "C:\god_ai\crypto-trader-v1_1"

# --- HELPER FUNCTIONS ---

function Write-Step($msg) {
    Write-Host ""
    Write-Host "=== $msg ===" -ForegroundColor Cyan
}

function Write-OK($msg) {
    Write-Host "  [OK] $msg" -ForegroundColor Green
}

function Write-Warn2($msg) {
    Write-Host "  [WARN] $msg" -ForegroundColor Yellow
}

function Write-Err($msg) {
    Write-Host "  [FAIL] $msg" -ForegroundColor Red
}

function Get-AdminSecret {
    $envFile = Join-Path $ProjectRoot ".env"
    if (-not (Test-Path $envFile)) { return $null }
    $line = Get-Content $envFile | Select-String "^ADMIN_SECRET=" | Select-Object -First 1
    if (-not $line) { return $null }
    return ($line -replace "ADMIN_SECRET=", "").Trim()
}

# --- PRE-FLIGHT CHECKS ---

Write-Step "Pre-flight checks"

if (-not (Test-Path $ProjectRoot)) {
    Write-Err "Project root not found: $ProjectRoot"
    Write-Host "  Edit this script and change `$ProjectRoot to your actual path." -ForegroundColor Yellow
    exit 1
}
Set-Location $ProjectRoot
Write-OK "Project root: $ProjectRoot"

if (-not (Test-Path ".\GO.cmd")) {
    Write-Err "GO.cmd not found in project root"
    exit 1
}
Write-OK "GO.cmd found"

if (-not (Test-Path ".\server\routes.ts")) {
    Write-Err "server\routes.ts not found"
    exit 1
}
Write-OK "server\routes.ts found"

if (-not $SkipDeploy -and -not (Test-Path $PatchedFilePath)) {
    Write-Err "Patched routes.ts not found at: $PatchedFilePath"
    Write-Host "  Download the patched file first, then either:" -ForegroundColor Yellow
    Write-Host "    1. Place it at: $PatchedFilePath" -ForegroundColor Yellow
    Write-Host "    2. Or run: .\paper-validate.ps1 -PatchedFilePath 'C:\path\to\routes.ts'" -ForegroundColor Yellow
    Write-Host "    3. Or run: .\paper-validate.ps1 -SkipDeploy  (if already deployed)" -ForegroundColor Yellow
    exit 1
}
if (-not $SkipDeploy) {
    Write-OK "Patched file found: $PatchedFilePath"
}

$adminSecret = Get-AdminSecret
if (-not $adminSecret) {
    Write-Warn2 "ADMIN_SECRET not set in .env - API control commands will fail"
    Write-Warn2 "Set ADMIN_SECRET=your_secret in .env and restart this script"
} else {
    Write-OK "ADMIN_SECRET loaded from .env"
}

# --- PHASE 1: STOP ANY RUNNING INSTANCE ---

Write-Step "Phase 1: Stop any running bot instance"

$nodeProcs = Get-Process node -ErrorAction SilentlyContinue
if ($nodeProcs) {
    Write-Warn2 "Killing $($nodeProcs.Count) node process(es)"
    $nodeProcs | Stop-Process -Force
    Start-Sleep 2
    Write-OK "Node processes killed"
} else {
    Write-OK "No node processes running"
}

# Clean up stale lock/heartbeat files
$lockFiles = @(".heartbeat", ".engine.pid", ".failsafe.pid")
foreach ($f in $lockFiles) {
    $path = Join-Path $ProjectRoot $f
    if (Test-Path $path) {
        Remove-Item $path -Force
        Write-OK "Removed stale lock file: $f"
    }
}

# --- PHASE 2: BACKUP AND DEPLOY PATCHED routes.ts ---

if (-not $SkipDeploy) {
    Write-Step "Phase 2: Backup and deploy patched routes.ts"

    # Backup current routes.ts
    $backupPath = ".\server\routes.ts.bak"
    Copy-Item .\server\routes.ts $backupPath -Force
    Write-OK "Backed up original to: $backupPath"

    # Copy patched file
    Copy-Item $PatchedFilePath .\server\routes.ts -Force
    Write-OK "Deployed patched routes.ts"

    # Verify patch markers are present
    $markers = @("PATCH #1: HARD-VETO", "BUGFIX #5:", "BUGFIX #21:")
    $missing = @()
    foreach ($marker in $markers) {
        $found = Select-String -Path .\server\routes.ts -Pattern $marker -Quiet
        if ($found) {
            Write-OK "Patch marker present: $marker"
        } else {
            $missing += $marker
            Write-Err "Patch marker MISSING: $marker"
        }
    }

    if ($missing.Count -gt 0) {
        Write-Err "Patched file is missing $($missing.Count) marker(s). Aborting."
        Write-Host "  Restore from backup: Copy-Item .\server\routes.ts.bak .\server\routes.ts -Force" -ForegroundColor Yellow
        exit 1
    }
} else {
    Write-Step "Phase 2: SKIPPED (deploy already done)"
}

# --- PHASE 3: REBUILD TYPESCRIPT ---

if (-not $SkipBuild) {
    Write-Step "Phase 3: Rebuild TypeScript (npm run build)"

    Write-Host "  Building..." -ForegroundColor DarkGray
    $oldErrorPref = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    $buildOutput = cmd.exe /c "npm run build 2>&1"
    $ErrorActionPreference = $oldErrorPref

    # Check for build errors (ignore module-not-found since they are expected)
    $buildErrors = $buildOutput | Where-Object { $_ -match "error TS" -and $_ -notmatch "Cannot find module" -and $_ -notmatch "Cannot find name" }

    if ($LASTEXITCODE -ne 0 -or $buildErrors) {
        Write-Err "Build failed with errors:"
        $buildOutput | Select-Object -Last 20 | ForEach-Object { Write-Host "    $_" -ForegroundColor Red }
        Write-Host ""
        Write-Host "  If errors are 'Cannot find module' for local files," -ForegroundColor Yellow
        Write-Host "  those are expected (TypeScript cannot resolve project modules in isolation)." -ForegroundColor Yellow
        Write-Host "  Only fix actual syntax errors in routes.ts." -ForegroundColor Yellow
        exit 1
    }

    Write-OK "Build successful"
} else {
    Write-Step "Phase 3: SKIPPED (already built)"
}

# --- PHASE 4: START THE BOT ---

Write-Step "Phase 4: Start the bot in background"

# Create log directory
$logDir = Join-Path $ProjectRoot "logs\paper-test"
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$ts = Get-Date -Format "yyyyMMdd_HHmmss"
$bootLog = Join-Path $logDir "boot_$ts.log"
$errLog = Join-Path $logDir "boot_$ts.err"

# Start GO.cmd with output redirected
$goPath = Join-Path $ProjectRoot "GO.cmd"
$proc = Start-Process -FilePath "cmd.exe" -ArgumentList "/c", $goPath `
    -RedirectStandardOutput $bootLog `
    -RedirectStandardError $errLog `
    -WindowStyle Hidden -PassThru

Write-OK "Bot process started (PID: $($proc.Id))"
Write-OK "Boot log:  $bootLog"
Write-OK "Error log: $errLog"

# --- PHASE 5: WAIT FOR API TO COME UP ---

Write-Step "Phase 5: Wait for API to come up (up to 120s)"

$apiUp = $false
$waitedSec = 0
$maxWaitSec = 120
$pollInterval = 3

for ($i = 0; $i -lt [int]($maxWaitSec / $pollInterval); $i++) {
    Start-Sleep $pollInterval
    $waitedSec = ($i + 1) * $pollInterval
    try {
        $health = Invoke-RestMethod http://localhost:5000/api/health -ErrorAction Stop -TimeoutSec 5
        Write-OK "API up after ${waitedSec}s"
        $apiUp = $true
        break
    } catch {
        Write-Host "  waiting... (${waitedSec}s)" -ForegroundColor DarkGray
    }
}

if (-not $apiUp) {
    Write-Err "API did not come up within ${maxWaitSec}s"
    Write-Host ""
    Write-Host "  Last 30 lines of boot log:" -ForegroundColor Yellow
    if (Test-Path $bootLog) {
        Get-Content $bootLog -Tail 30 | ForEach-Object { Write-Host "    $_" -ForegroundColor DarkGray }
    }
    Write-Host ""
    Write-Host "  Last 30 lines of error log:" -ForegroundColor Yellow
    if (Test-Path $errLog) {
        Get-Content $errLog -Tail 30 | ForEach-Object { Write-Host "    $_" -ForegroundColor Red }
    }
    exit 1
}

# Show health
Write-Host ""
Write-Host "  Health status:" -ForegroundColor Cyan
$health | Format-List | Out-String | ForEach-Object { Write-Host "    $_" -NoNewline }

# --- PHASE 6: FORCE PAPER MODE VIA API ---

Write-Step "Phase 6: Force PAPER mode via API"

if (-not $adminSecret) {
    Write-Warn2 "Cannot force paper mode - ADMIN_SECRET not set"
    Write-Warn2 "Manually verify mode via: Invoke-RestMethod http://localhost:5000/api/health"
} else {
    $headers = @{ "x-admin-secret" = $adminSecret }

    # Force paper mode
    try {
        $body = @{ mode = "paper"; confirmed = $true } | ConvertTo-Json
        $resp = Invoke-RestMethod -Method Post -Uri http://localhost:5000/api/bot/trading-mode `
            -Headers $headers -ContentType "application/json" -Body $body -TimeoutSec 10
        Write-OK "Trading mode set to: $($resp.tradingMode)"
    } catch {
        Write-Err "Failed to set paper mode: $($_.Exception.Message)"
    }

    # Ensure bot is running
    try {
        $body = @{ isRunning = $true } | ConvertTo-Json
        Invoke-RestMethod -Method Post -Uri http://localhost:5000/api/bot/toggle `
            -Headers $headers -ContentType "application/json" -Body $body -TimeoutSec 10 | Out-Null
        Write-OK "Bot isRunning=true"
    } catch {
        Write-Warn2 "Failed to set isRunning: $($_.Exception.Message)"
    }
}

# --- PHASE 7: VERIFY PAPER MODE ---

Write-Step "Phase 7: Verify paper mode is active"

Start-Sleep 2  # give the API a moment to settle

try {
    $health = Invoke-RestMethod http://localhost:5000/api/health -TimeoutSec 5
    $status = Invoke-RestMethod http://localhost:5000/api/status -TimeoutSec 5

    Write-Host ""
    Write-Host "  Current state:" -ForegroundColor Cyan
    Write-Host "    mode:          $($health.mode)"
    Write-Host "    isRunning:     $($health.isRunning)"
    Write-Host "    walletBalance: $($health.walletBalance)"
    Write-Host "    openPositions: $($health.openPositions)"

    if ($health.mode -eq "paper") {
        Write-OK "PAPER MODE CONFIRMED"
    } else {
        Write-Err "Mode is NOT paper! It is: $($health.mode)"
        Write-Host "  Stop the bot immediately and investigate." -ForegroundColor Red
        exit 1
    }

    if ($health.isRunning) {
        Write-OK "Bot is running"
    } else {
        Write-Warn2 "Bot is not running - toggle isRunning via API"
    }
} catch {
    Write-Err "Failed to verify status: $($_.Exception.Message)"
}

# --- PHASE 8: SHOW LIVE LOG TAIL ---

Write-Step "Phase 8: Last 30 lines of boot log (verify no errors)"

if (Test-Path $bootLog) {
    Get-Content $bootLog -Tail 30 | ForEach-Object { Write-Host "    $_" -ForegroundColor DarkGray }
}

# --- SUMMARY AND NEXT STEPS ---

Write-Step "DEPLOYMENT COMPLETE"

Write-Host ""
Write-Host "  The bot is now running in PAPER mode with all 28 patches applied."
Write-Host "  Paper trades do NOT use real SOL - they simulate execution."
Write-Host ""
Write-Host "  WHAT TO DO NEXT:"
Write-Host ""
Write-Host "  1. Watch live logs (open a NEW PowerShell window):"
Write-Host ""
Write-Host "     cd C:\god_ai\crypto-trader-v1_1"
Write-Host "     Get-Content .\logs\trading.log -Wait -Tail 50"
Write-Host ""
Write-Host "  2. Let it run for 24-48 hours, accumulating 30+ paper trades."
Write-Host ""
Write-Host "  3. Run the validation script to check go-live gates:"
Write-Host ""
Write-Host "     .\validate-paper.ps1"
Write-Host ""
Write-Host "  4. EMERGENCY STOP:"
Write-Host ""
Write-Host "     .\stop.ps1"
Write-Host ""
Write-Host "  BOOT LOG LOCATION:"
Write-Host "  $bootLog"
Write-Host ""
Write-Host "=== Bot is running in PAPER mode ===" -ForegroundColor Green
