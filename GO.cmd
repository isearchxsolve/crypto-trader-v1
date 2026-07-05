@echo off
REM =====================================================================
REM  SINGLE COMMAND: bootstrap + run the FULL system end to end.
REM  Installs deps + coding agent, builds, and launches engine + failsafe
REM  in unattended self-healing mode. Double-click this file.
REM =====================================================================
cd /d "%~dp0"
title Trading System - GO (end to end)
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0run.ps1" bootstrap
pause
