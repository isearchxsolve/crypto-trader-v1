while ($true) {
    Clear-Host

    try {
        $trades = Invoke-RestMethod "http://localhost:5000/api/shadow/trades"
        $stats  = Invoke-RestMethod "http://localhost:5000/api/shadow/stats"

        Write-Host "================ SHADOW STATS ================" -ForegroundColor Cyan
        $stats | Format-List

        Write-Host ""
        Write-Host "================ OPEN TRADES ================" -ForegroundColor Yellow
        if ($null -eq $trades.open -or $trades.open.Count -eq 0) {
            Write-Host "No open shadow trades"
        } else {
            $trades.open | Select-Object `
                id,
                tokenSymbol,
                mode,
                score,
                sizeSol,
                quoteImpactPct,
                ageSeconds,
                openedAt |
                Format-Table -AutoSize
        }

        Write-Host ""
        Write-Host "================ CLOSED TRADES ================" -ForegroundColor Green
        if ($null -eq $trades.closed -or $trades.closed.Count -eq 0) {
            Write-Host "No closed shadow trades yet"
        } else {
            $trades.closed |
                Select-Object `
                    id,
                    tokenSymbol,
                    mode,
                    score,
                    sizeSol,
                    paperPnlPct,
                    shadowPnlPct,
                    pnlGapPct,
                    exitReason,
                    holdSeconds |
                Format-Table -AutoSize
        }

        Write-Host ""
        Write-Host "Counts: open=$($trades.counts.open) closed=$($trades.counts.closed) total=$($trades.counts.total)" -ForegroundColor Magenta
        Write-Host "Refresh: 10s | Ctrl+C to stop" -ForegroundColor DarkGray
    } catch {
        Write-Host "Monitor error: $($_.Exception.Message)" -ForegroundColor Red
        Write-Host "Make sure bot is running and /api/shadow/trades route was added." -ForegroundColor Red
    }

    Start-Sleep -Seconds 10
}
