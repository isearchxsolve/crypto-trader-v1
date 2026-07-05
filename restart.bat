@echo off
chcp 65001 >nul 2>&1
cd /d "%~dp0"
echo [%DATE% %TIME%] Starting restart...
node restart.cjs
if %ERRORLEVEL% NEQ 0 (
  echo [%DATE% %TIME%] Restart completed with ERRORS ^(exit code %ERRORLEVEL%^)
  pause
) else (
  echo [%DATE% %TIME%] Restart completed successfully
  timeout /t 5 /nobreak >nul
)
