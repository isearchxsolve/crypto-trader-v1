@echo off
REM ============================================================
REM  reset_balance.bat - calls POST /api/bot/reset-balance
REM  Closes open positions, resets paper balance/peak/daily,
REM  clears streaks + all in-memory cooldown/strike guards.
REM  (Does NOT wipe trade history or the shadow ledger.)
REM ============================================================

REM --- edit these two if needed ---
set "HOST=http://localhost:5000"
set "ADMIN_SECRET=crypto-trader-admin-2026"
REM --------------------------------

echo.
echo Calling reset-balance on %HOST% ...
echo.

curl -s -X POST "%HOST%/api/bot/reset-balance" -H "x-admin-secret: %ADMIN_SECRET%"

set "RC=%ERRORLEVEL%"
echo.
echo.
if "%RC%"=="0" (
  echo Done. ^(HTTP request sent — see JSON above for success:true^)
) else (
  echo curl failed with exit code %RC%. Is the bot running on %HOST% ?
)
echo.
pause
