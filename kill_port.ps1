$proc = Get-NetTCPConnection -LocalPort 5000 -ErrorAction SilentlyContinue | Select-Object -First 1
if ($proc) {
    Stop-Process -Id $proc.OwningProcess -Force
    Write-Output "Killed process $($proc.OwningProcess)"
} else {
    Write-Output "No process on port 5000"
}
