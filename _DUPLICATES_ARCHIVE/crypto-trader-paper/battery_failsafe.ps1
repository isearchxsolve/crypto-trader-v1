# =========================================================
# Crypto Trader Ultra - Smart Battery Failsafe
# =========================================================
# This script monitors your laptop battery in the background.
# If the power is cut (discharging) and the battery drops 
# below 15%, it triggers an EMERGENCY FORCE SELL ALL 
# on the bot, then toggles the engine to OFF.
# =========================================================

$CRITICAL_BATTERY_PERCENT = 15
$CHECK_INTERVAL_SECONDS = 30

Write-Host "🔋 Smart Battery Failsafe is active and monitoring..." -ForegroundColor Cyan

while ($true) {
    try {
        # Fetch battery status using WMI
        $battery = Get-WmiObject -Class Win32_Battery
        
        if ($battery) {
            $status = $battery.BatteryStatus
            $charge = $battery.EstimatedChargeRemaining

            # BatteryStatus 1 means "Discharging" (Laptop is unplugged)
            if ($status -eq 1 -and $charge -lt $CRITICAL_BATTERY_PERCENT) {
                Write-Host "⚠️ CRITICAL POWER LEVEL REACHED ($charge%)! INITIATING EMERGENCY SHUTDOWN PROTOCOL..." -ForegroundColor Red
                
                # 1. Force Sell All Open Positions
                Write-Host "-> Triggering Force-Sell All API..." -ForegroundColor Yellow
                try {
                    Invoke-RestMethod -Uri "http://127.0.0.1:5000/api/bot/force-sell-all" -Method Post -TimeoutSec 10
                    Write-Host "✅ All positions force-sold successfully." -ForegroundColor Green
                } catch {
                    Write-Host "❌ Failed to Force Sell: $($_.Exception.Message)" -ForegroundColor Red
                }

                # 2. Toggle Bot to OFF to prevent new trades
                Write-Host "-> Halting Trading Engine..." -ForegroundColor Yellow
                try {
                    Invoke-RestMethod -Uri "http://127.0.0.1:5000/api/bot/toggle" -Method Post -TimeoutSec 10
                    Write-Host "✅ Trading engine halted." -ForegroundColor Green
                } catch {
                    Write-Host "❌ Failed to toggle engine: $($_.Exception.Message)" -ForegroundColor Red
                }

                # 3. Prevent infinite loops (we did our job, exit the script)
                Write-Host "Failsafe executed successfully. Exiting monitor." -ForegroundColor Green
                Exit
            }
        }
    } catch {
        # Silently handle WMI errors and retry
    }

    Start-Sleep -Seconds $CHECK_INTERVAL_SECONDS
}
