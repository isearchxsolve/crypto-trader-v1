@echo off
chcp 65001 >nul 2>&1
cd /d "%~dp0"
echo.
echo ============================================
echo  CRYPTO TRADER — HEADLESS MODE (PM2)
echo ============================================
echo.

:: ── Kill existing server processes on ports 5000/5001 ──────────────────
echo [1/4] Clearing ports 5000 and 5001...
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":5000 " ^| findstr "LISTENING" 2^>nul') do (
  echo   Killing PID %%a on port 5000
  taskkill /F /PID %%a >nul 2>&1
)
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":5001 " ^| findstr "LISTENING" 2^>nul') do (
  echo   Killing PID %%a on port 5001
  taskkill /F /PID %%a >nul 2>&1
)
timeout /t 2 /nobreak >nul

:: ── Reset DB to live mode ───────────────────────────────────────────────
echo [2/4] Resetting DB to LIVE mode...
node -e "require('dotenv').config();const{Pool}=require('pg');const p=new Pool({connectionString:process.env.DATABASE_URL});p.query(\"UPDATE bot_status SET trading_mode='live',is_running=false\").then(()=>{console.log('  DB OK');p.end()}).catch(e=>{console.log('  DB skipped:',e.message);p.end()})"
timeout /t 2 /nobreak >nul

:: ── Stop any stale PM2 processes ────────────────────────────────────────
echo [3/4] Removing stale PM2 processes...
pm2 delete crypto-engine crypto-ml >nul 2>&1

:: ── Start fresh under PM2 ───────────────────────────────────────────────
echo [4/4] Starting under PM2 (headless)...
pm2 start ecosystem.config.cjs

:: ── Persist so processes survive reboots (if pm2 startup was run) ──────
pm2 save --force

echo.
echo ============================================
echo  STATUS
echo ============================================
pm2 status
echo.
echo  Engine:    http://localhost:5000
echo  ML Server: http://localhost:5001
echo  Logs:      pm2 logs
echo  Monitor:   pm2 monit
echo  Stop all:  pm2 stop all
echo.
echo  To survive REBOOTS (run once as Admin):
echo    pm2 startup
echo    ^(then copy+run the command it prints^)
echo ============================================
pause
