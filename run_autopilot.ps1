$logPath = "C:\god_ai\crypto-trader-v1_1\autopilot_live.log"
$scriptPath = "C:\god_ai\crypto-trader-v1_1\autopilot.cjs"
while($true) {
  node $scriptPath 2>&1 | Tee-Object -FilePath $logPath -Append
  Start-Sleep -Seconds 30
}
