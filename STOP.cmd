@echo off
REM Double-click to stop engine + failsafe.
cd /d "%~dp0"
title Trading System - STOP
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0run.ps1" stop
pause
