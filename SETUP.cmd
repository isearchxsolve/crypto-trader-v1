@echo off
REM Run ONCE first: installs dependencies and builds dist/.
cd /d "%~dp0"
title Trading System - SETUP
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0run.ps1" setup
pause
