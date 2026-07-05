@echo off
REM Double-click to see whether engine + failsafe are alive.
cd /d "%~dp0"
title Trading System - STATUS
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0run.ps1" status
pause
