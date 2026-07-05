@echo off
REM Remove the boot auto-start task.
cd /d "%~dp0"
title Remove Auto-Start
schtasks /Delete /TN "TradingSystemAutostart" /F
echo.
echo Auto-start removed (the system will no longer launch on boot).
pause
