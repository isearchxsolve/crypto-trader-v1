@echo off
title PAPER TRADING SESSION — 24h

REM ============================================================
REM  24-HOUR PAPER TRADING SESSION LAUNCHER
REM  Starts all services, captures timestamped logs, and reports
REM
REM  Usage:  double-click or run from CMD:
REM     run_paper_24h.cmd
REM ============================================================

REM === Compute safe timestamp (no colons/spaces) ===
set TIMESTAMP=%DATE:~10,4%%DATE:~4,2%%DATE:~7,2%_%TIME:~0,2%%TIME:~3,2%%TIME:~6,2%
set TIMESTAMP=%TIMESTAMP: =0%
set TIMESTAMP=%TIMESTAMP::=%

set LOGDIR=paper_logs_%TIMESTAMP%
mkdir %LOGDIR% 2>nul

echo ============================================================
echo  PAPER TRADING SESSION 24h
echo  Started: %DATE% %TIME%
echo  Logs:    %CD%\%LOGDIR%
echo ============================================================
echo.

REM === Step 1: Set paper mode ===
echo [1/5] Setting paper mode in database...
node set_paper.cjs >> %LOGDIR%\setup.log 2>&1
echo MODE=paper > %LOGDIR%\env_snapshot.txt 2>&1
type .env | findstr MODE >> %LOGDIR%\env_snapshot.txt 2>&1
type .env1 | findstr MODE >> %LOGDIR%\env_snapshot.txt 2>&1
type .env1 | findstr GMGN_CLI >> %LOGDIR%\env_snapshot.txt 2>&1
echo.
echo  Environment snapshot saved to %LOGDIR%\env_snapshot.txt

REM === Step 2: Start ML Server ===
echo [2/5] Starting ML Server (port 5001)...
start "ML-Server" cmd /k "python solana_hybrid_sniper_ultra/ml_server.py >> %CD%\%LOGDIR%\ml_server.log 2>&1"
timeout /t 3 /nobreak >nul

REM === Step 3: Start Fast Scanner ===
echo [3/5] Starting Fast Scanner...
start "Fast-Scanner" cmd /k "node fast_scanner.cjs >> %CD%\%LOGDIR%\fast_scanner.log 2>&1"
timeout /t 3 /nobreak >nul

REM === Step 4: Start TSX Trading Engine ===
echo [4/5] Starting TSX Trading Engine (port 5000)...
start "TSX-Server" cmd /k "npx cross-env NODE_ENV=development tsx server/index.ts >> %CD%\%LOGDIR%\trading_engine.log 2>&1"

REM === Step 5: Start Gold Standard Hunter ===
echo [5/5] Starting Gold Standard Hunter (token discovery)...
start "Gold-Hunter" cmd /k "npx tsx gold_hunter_runner.cjs >> %CD%\%LOGDIR%\gold_hunter.log 2>&1"
timeout /t 5 /nobreak >nul

echo.
echo ============================================================
echo  ALL 5 SERVICES STARTED — Let engine initialize...
echo ============================================================
echo.
timeout /t 25 /nobreak >nul

REM === Initial health check ===
echo [HEALTH CHECK] Verifying services...
echo.

REM Check ML Server
node -e "fetch('http://localhost:5001/health').then(r=>r.ok).then(ok=>console.log('[ML Server]      ' + (ok ? 'Running on port 5001' : 'Not responding') + ' ' + (ok ? '✅' : '⚠️'))).catch(()=>console.log('[ML Server]      Not responding on port 5001 ⚠️'))" 2>&1 | findstr /v "node -e"

REM Check TSX Server
node -e "fetch('http://localhost:5000/api/health').then(r=>r.json()).then(d=>console.log('[Trading Engine]  Running on port 5000 ✅ Status: ' + (d.halted ? 'HALTED' : 'Active'))).catch(()=>console.log('[Trading Engine]  Not responding on port 5000 ⚠️ (may still be compiling)'))" 2>&1 | findstr /v "node -e"

echo  [Gold Hunter]    Started in separate window (check Gold-Hunter window for signals)
echo  [Fast Scanner]   Started in separate window (check dashboard for scan results)

echo.
echo ============================================================
echo  MONITORING LOOP — Runs every 60 seconds
echo  Press Ctrl+C to stop
echo ============================================================
echo.

REM === Monitor loop ===
set START_TIME=%TIME%
set COUNTER=0

:MONITOR_LOOP
set /a COUNTER+=1
set CURRENT_TIME=%TIME%
echo [%DATE% %CURRENT_TIME%] Cycle #%COUNTER% >> %LOGDIR%\monitor.log

REM Health check via node (more reliable than curl)
node -e "fetch('http://localhost:5000/api/health').then(r=>r.json()).then(d=>console.log('HEALTH:',JSON.stringify(d))).catch(e=>console.log('HEALTH: down'))" >> %LOGDIR%\health_checks.log 2>&1
echo. >> %LOGDIR%\health_checks.log

REM Check shadow ledger
echo. >> %LOGDIR%\monitor.log
echo ===== CYCLE #%COUNTER% ===== >> %LOGDIR%\monitor.log
echo Timestamp: %DATE% %CURRENT_TIME% >> %LOGDIR%\monitor.log

if exist shadow-stats.json (
  for /f "tokens=*" %%a in ('type shadow-stats.json') do (
    echo %%a >> %LOGDIR%\monitor.log
  )
) else (
  echo [No shadow stats yet — bot scanning for candidates...] >> %LOGDIR%\monitor.log
)

REM Print quick summary to console
if exist shadow-stats.json (
  node -e "
    try {
      const fs = require('fs');
      const raw = fs.readFileSync('./shadow-stats.json', 'utf8');
      const s = JSON.parse(raw);
      s.compoundedMult = s.compoundedMult ?? 1;
      const n = s.totalTrades || 0;
      const wins = s.wins || 0;
      const losses = s.losses || 0;
      const wr = n ? ((wins/n)*100).toFixed(1) : '0.0';
      const avg = n ? (s.sumShadowPnl/n).toFixed(2) : '0.00';
      const growth = ((s.compoundedMult-1)*100).toFixed(2);
      console.log('📊 CYCLE #' + %COUNTER% + ' — Trades: ' + n + ' | WR: ' + wr + '% | Avg: ' + avg + '% | Growth: ' + growth + '%');
    } catch(e) {
      console.log('📊 CYCLE #' + %COUNTER% + ' — Shadow ledger loading...(' + e.message + ')');
    }
  "
)

REM Count open windows (optional check)
echo. >> %LOGDIR%\monitor.log

REM Sleep 60 seconds
timeout /t 60 /nobreak >nul
goto MONITOR_LOOP
