@echo off
REM Register the system to auto-start at every boot (runs whether or not you log in).
REM Double-click once. Requires admin (right-click > Run as administrator).
cd /d "%~dp0"
title Install Auto-Start
set "TASK=TradingSystemAutostart"
set "PS=powershell -NoProfile -ExecutionPolicy Bypass -File \"%~dp0run.ps1\" start"
schtasks /Create /TN "%TASK%" /TR "%PS%" /SC ONSTART /RU SYSTEM /RL HIGHEST /F
if %errorlevel%==0 (
  echo.
  echo Installed. The trading system will now start automatically on every boot.
  echo It will also auto-restart on crash via the watchdog + pm2/systemd.
) else (
  echo.
  echo FAILED. Re-run this file as Administrator ^(right-click ^> Run as administrator^).
)
pause
