@echo off
REM ============================================================
REM  Single-screen LIVE dashboard: status + open/last trades +
REM  heartbeat health + recent activity + errors. Auto-refresh.
REM  Double-click, or run:  DASHBOARD.cmd   (Ctrl+C to quit)
REM  Optional: DASHBOARD.cmd 3   to refresh every 3 seconds.
REM ============================================================
cd /d "%~dp0"
set "REFRESH=%~1"
if "%REFRESH%"=="" set "REFRESH=5"
title Trading Bot - LIVE DASHBOARD (refresh %REFRESH%s)
:loop
cls
echo ============================================================
echo   TRADING BOT - LIVE DASHBOARD     %date% %time%
echo ============================================================
node check_trades.cjs
echo.
echo ------------------------- ENGINE ---------------------------
node -e "try{const fs=require('fs');const hb=+fs.readFileSync('.heartbeat','utf8').trim();const age=Math.round((Date.now()-hb)/1000);console.log('Heartbeat age: '+age+'s '+(age>60?'  <<< STALE / ENGINE LIKELY DOWN':'  (alive)'))}catch(e){console.log('Heartbeat: MISSING (engine not running?)')}"
if exist .HALT (echo HALT FLAG SET -^> & type .HALT)
if exist .PANIC echo *** PANIC FLAG SET ***
echo.
echo --------------------- RECENT ACTIVITY ----------------------
powershell -NoProfile -Command "if(Test-Path 'logs\engine.out.log'){Get-Content 'logs\engine.out.log' -Tail 8}else{'(no engine.out.log yet)'}"
echo.
echo ------------------------ LAST ERRORS -----------------------
powershell -NoProfile -Command "if(Test-Path 'logs\engine.err.log'){Get-Content 'logs\engine.err.log' -Tail 5}else{'(no errors logged)'}"
echo.
echo  refreshing every %REFRESH%s -- press Ctrl+C to quit
timeout /t %REFRESH% /nobreak >nul
goto loop
