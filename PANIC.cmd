@echo off
REM EMERGENCY: double-click to HALT -> KILL -> LIQUIDATE -> FLAG.
cd /d "%~dp0"
title Trading System - PANIC
echo *** EMERGENCY STOP + LIQUIDATE ALL POSITIONS ***
choice /m "Are you sure you want to PANIC and sell everything"
if errorlevel 2 goto :cancel
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0run.ps1" panic
goto :done
:cancel
echo Cancelled.
:done
pause
