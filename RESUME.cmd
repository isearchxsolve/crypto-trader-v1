@echo off
REM Double-click to clear HALT/PANIC flags after a fix.
cd /d "%~dp0"
title Trading System - RESUME
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0run.ps1" resume
pause
