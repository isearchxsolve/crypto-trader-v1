@echo off
REM ============================================================
REM  Trading System - single-click control menu
REM  Double-click this file. Pick a number. That's it.
REM ============================================================
cd /d "%~dp0"
title Trading System Control

:menu
cls
echo ============================================================
echo                 TRADING SYSTEM CONTROL
echo ============================================================
echo.
call :status_line
echo.
echo   [1]  SETUP      (run once: install + build)
echo   [2]  START      (launch engine + failsafe)
echo   [3]  STATUS     (are they alive?)
echo   [4]  STOP       (stop both)
echo   [5]  RESTART
echo   [6]  LOGS       (live tail)
echo   [7]  RESUME     (clear HALT/PANIC flags)
echo.
echo   [9]  *** PANIC ***  HALT - KILL - LIQUIDATE - FLAG
echo.
echo   [0]  Exit
echo.
set "choice="
set /p "choice=Enter choice: "

if "%choice%"=="1" ( call :run setup    & goto pause_menu )
if "%choice%"=="2" ( call :run start    & goto pause_menu )
if "%choice%"=="3" ( call :run status   & goto pause_menu )
if "%choice%"=="4" ( call :run stop     & goto pause_menu )
if "%choice%"=="5" ( call :run restart  & goto pause_menu )
if "%choice%"=="6" ( call :run logs     & goto pause_menu )
if "%choice%"=="7" ( call :run resume   & goto pause_menu )
if "%choice%"=="9" ( goto panic )
if "%choice%"=="0" ( goto :eof )
echo Invalid choice.
timeout /t 1 >nul
goto menu

:panic
echo.
echo *** EMERGENCY: this will HALT, kill the engine, and SELL ALL POSITIONS. ***
choice /m "Are you absolutely sure"
if errorlevel 2 goto menu
call :run panic
goto pause_menu

:run
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0run.ps1" %1
goto :eof

:status_line
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0run.ps1" status
goto :eof

:pause_menu
echo.
echo ------------------------------------------------------------
pause
goto menu
