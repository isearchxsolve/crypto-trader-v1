<#
  run.ps1 -- single-file Windows controller for the trading engine + failsafe.

  Usage (from the project folder):
    powershell -ExecutionPolicy Bypass -File .\run.ps1 <command>

  Commands:
    setup       Install deps + build dist/ (run once, or after code changes)
    start       Build if needed, then launch engine + failsafe (background)
    stop        Stop engine + failsafe started by this script
    status      Show whether engine + failsafe are alive
    panic       Trigger emergency: HALT -> KILL -> LIQUIDATE -> FLAG
    liquidate   Direct emergency dump (bypasses watchdog; use if all dead)
    resume      Clear HALT/PANIC flags after a fix
    logs        Tail engine + failsafe logs

  Double-clickable: a .cmd shim is written next to this file on first run.
#>

param(
  [Parameter(Position = 0)]
  [ValidateSet('bootstrap','setup','start','stop','restart','status','panic','liquidate','resume','logs')]
  [string]$Command = 'start'
)

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $Root

$LogDir       = Join-Path $Root 'logs'
$EnginePidF   = Join-Path $Root '.engine.pid'
$FailsafePidF = Join-Path $Root '.failsafe.pid'
$HaltFile     = Join-Path $Root '.HALT'
$PanicFile    = Join-Path $Root '.PANIC'
$EngineEntry  = Join-Path $Root 'dist\index.cjs'
$FailsafeEntry= Join-Path $Root 'failsafe.cjs'
$LiquidEntry  = Join-Path $Root 'dist\liquidator.cjs'

function Info($m){ Write-Host "[run] $m" -ForegroundColor Cyan }
function Warn($m){ Write-Host "[run] $m" -ForegroundColor Yellow }
function Err ($m){ Write-Host "[run] $m" -ForegroundColor Red }

function Require-Node {
  if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Err 'Node.js not found in PATH. Install Node 18+ and retry.'
    exit 1
  }
}

# Load .env into this process so child processes inherit it.
function Load-DotEnv {
  $envFile = Join-Path $Root '.env'
  if (-not (Test-Path $envFile)) {
    Warn '.env not found -- copy .env.example to .env and fill it in.'
    return
  }
  Get-Content $envFile | ForEach-Object {
    $line = $_.Trim()
    if ($line -eq '' -or $line.StartsWith('#')) { return }
    $idx = $line.IndexOf('=')
    if ($idx -lt 1) { return }
    $k = $line.Substring(0, $idx).Trim()
    $v = $line.Substring($idx + 1).Trim().Trim('"')
    [System.Environment]::SetEnvironmentVariable($k, $v, 'Process')
  }
  Info '.env loaded into process environment.'
}

function Ensure-Cmd-Shim {
  $shim = Join-Path $Root 'run.cmd'
  if (-not (Test-Path $shim)) {
    '@echo off' , 'powershell -ExecutionPolicy Bypass -File "%~dp0run.ps1" %*' |
      Set-Content -Path $shim -Encoding ASCII
  }
}

function Is-Alive($pidFile) {
  if (-not (Test-Path $pidFile)) { return $false }
  $procId = (Get-Content $pidFile -ErrorAction SilentlyContinue | Select-Object -First 1)
  if (-not $procId) { return $false }
  return [bool](Get-Process -Id $procId -ErrorAction SilentlyContinue)
}

function Start-Proc($name, $entry, $pidFile, $logName) {
  if (Is-Alive $pidFile) { Warn "$name already running (pid $(Get-Content $pidFile))."; return }
  if (-not (Test-Path $entry)) { Err "$name entry missing: $entry  (run: .\run.ps1 setup)"; exit 1 }
  New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
  $out = Join-Path $LogDir "$logName.out.log"
  $errl= Join-Path $LogDir "$logName.err.log"
  $p = Start-Process -FilePath 'node' -ArgumentList "`"$entry`"" -WorkingDirectory $Root `
        -WindowStyle Hidden -PassThru -RedirectStandardOutput $out -RedirectStandardError $errl
  $p.Id | Set-Content -Path $pidFile
  Info "$name started (pid $($p.Id)) -> logs/$logName.*.log"
}

function Stop-Proc($name, $pidFile) {
  if (-not (Test-Path $pidFile)) { Warn "$name not tracked."; return }
  $procId = (Get-Content $pidFile | Select-Object -First 1)
  $proc = Get-Process -Id $procId -ErrorAction SilentlyContinue
  if ($proc) { Stop-Process -Id $procId -Force; Info "$name stopped (pid $procId)." }
  else { Warn "$name pid $procId not alive." }
  Remove-Item $pidFile -ErrorAction SilentlyContinue
}

function Do-Setup {
  Require-Node
  if (-not (Test-Path (Join-Path $Root 'node_modules'))) { Info 'npm install...'; npm install }
  Info 'npm run build...'
  npm run build
  Info 'Setup complete.'
}

function Do-Start {
  Require-Node
  Load-DotEnv
  if (-not (Test-Path $EngineEntry) -or -not (Test-Path $LiquidEntry)) {
    Warn 'dist/ missing -- running setup first.'; Do-Setup
  }
  # If we were halted previously, refuse to start until explicitly resumed.
  if (Test-Path $HaltFile) { Err 'HALT flag present. Run: .\run.ps1 resume  before starting.'; exit 1 }
  Start-Proc 'engine'   $EngineEntry   $EnginePidF   'engine'
  Start-Proc 'failsafe' $FailsafeEntry $FailsafePidF 'failsafe'
  Info 'System up. Check: .\run.ps1 status'
}

function Do-Stop {
  Stop-Proc 'engine'   $EnginePidF
  Stop-Proc 'failsafe' $FailsafePidF
}

function Do-Status {
  $e = if (Is-Alive $EnginePidF)   { "ALIVE (pid $(Get-Content $EnginePidF))" }   else { 'down' }
  $f = if (Is-Alive $FailsafePidF) { "ALIVE (pid $(Get-Content $FailsafePidF))" } else { 'down' }
  Write-Host "engine   : $e"
  Write-Host "failsafe : $f"
  if (Test-Path $HaltFile)  { Warn "HALT flag set: $(Get-Content $HaltFile -Raw)" }
  if (Test-Path $PanicFile) { Warn 'PANIC flag set.' }
}

function Do-Panic {
  Load-DotEnv
  Err 'PANIC requested -- writing .PANIC; failsafe will HALT -> KILL -> LIQUIDATE -> FLAG.'
  'manual run.ps1 panic' | Set-Content -Path $PanicFile
  if (-not (Is-Alive $FailsafePidF)) {
    Warn 'Failsafe not running -- liquidating directly.'
    Do-Liquidate
  }
}

function Do-Liquidate {
  Require-Node; Load-DotEnv
  if (-not (Test-Path $LiquidEntry)) { Err "$LiquidEntry missing (run setup)."; exit 1 }
  Info 'Running emergency liquidation (foreground)...'
  node "$LiquidEntry"
}

function Do-Resume {
  Remove-Item $HaltFile  -ErrorAction SilentlyContinue
  Remove-Item $PanicFile -ErrorAction SilentlyContinue
  Info 'HALT/PANIC flags cleared. Safe to start.'
}

function Do-Logs {
  New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
  $files = Get-ChildItem $LogDir -Filter *.log -ErrorAction SilentlyContinue
  if (-not $files) { Warn 'No logs yet.'; return }
  Info 'Tailing logs (Ctrl+C to stop)...'
  Get-Content ($files.FullName) -Wait -Tail 20
}

function Require-Git {
  if (-not (Get-Command git -ErrorAction SilentlyContinue)) { Err 'git not found in PATH. Install Git for Windows: https://git-scm.com/download/win'; exit 1 }
}

function Install-Agent {
  $prov = $env:AGENT_PROVIDER
  if (-not $prov) { Warn 'AGENT_PROVIDER not set in .env (opencode|antigravity|custom) -- skipping agent install.'; return }
  switch ($prov.ToLower()) {
    'opencode' {
      if (Get-Command opencode -ErrorAction SilentlyContinue) { Info 'opencode already installed.' }
      else { Info 'Installing opencode CLI (npm i -g opencode-ai)...'; npm install -g opencode-ai }
    }
    'antigravity' {
      if (Get-Command antigravity -ErrorAction SilentlyContinue) { Info 'antigravity CLI found.' }
      else { Warn 'antigravity CLI not on PATH -- install it so unattended auto-fix can run.' }
    }
    default { Info "Custom agent provider ('$prov') -- using AGENT_RAW_CMD as-is." }
  }
}

function Do-Bootstrap {
  Require-Node; Require-Git
  $envFile = Join-Path $Root '.env'
  if (-not (Test-Path $envFile)) {
    Copy-Item (Join-Path $Root '.env.example') $envFile
    Err 'Created .env from template. FILL IN your secrets (wallet key, RPC, AGENT_PROVIDER), then run GO again.'
    exit 1
  }
  Load-DotEnv
  $inGit = $false
  try { $inGit = ((git rev-parse --is-inside-work-tree 2>$null) -eq 'true') } catch {}
  if (-not $inGit) {
    Info 'Initializing git repo (required for unattended auto-fix branch/merge)...'
    git init | Out-Null; git add -A | Out-Null; git commit -m 'bootstrap' | Out-Null
    $main = if ($env:GIT_MAIN_BRANCH) { $env:GIT_MAIN_BRANCH } else { 'main' }
    git branch -M $main
  } else {
    Info 'Already inside a git work tree (parent repo) -- skipping git init.'
  }
  if (-not (Test-Path (Join-Path $Root 'node_modules'))) { Info 'npm install...'; npm install }
  Install-Agent
  Info 'Building dist/...'; npm run build
  Info 'Launching full system (engine + failsafe, unattended self-heal)...'
  Do-Start
  Info 'BOOTSTRAP COMPLETE -- end-to-end system is live and self-healing.'
  Do-Status
}

Ensure-Cmd-Shim
switch ($Command) {
  'bootstrap' { Do-Bootstrap }
  'setup'     { Do-Setup }
  'start'     { Do-Start }
  'stop'      { Do-Stop }
  'restart'   { Do-Stop; Start-Sleep -Seconds 2; Do-Start }
  'status'    { Do-Status }
  'panic'     { Do-Panic }
  'liquidate' { Do-Liquidate }
  'resume'    { Do-Resume }
  'logs'      { Do-Logs }
}
