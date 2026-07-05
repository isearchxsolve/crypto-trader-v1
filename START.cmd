@echo off
REM Double-click to build (if needed) and launch engine + failsafe.
cd /d "%~dp0"
title Trading System - START
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0run.ps1" start
echo.
echo ---------------------------------------------
echo System launched in the background.
echo Double-click STATUS.cmd to check it.
echo ---------------------------------------------
pause
