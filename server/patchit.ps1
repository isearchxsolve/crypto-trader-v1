# ============================================================
# patchit.ps1  v2  --  Gold Hunter + Exit Strategy Fixes
# ============================================================
$ErrorActionPreference = 'Stop'
$nl   = "`r`n"
$file = Join-Path $PSScriptRoot 'routes_EXPLOSIVE_SELECT.ts'
$bak  = Join-Path $PSScriptRoot ("routes_EXPLOSIVE_SELECT.BAK_" + (Get-Date -Format 'yyyyMMdd_HHmmss') + '.ts')

if (-not (Test-Path $file)) {
    Write-Error "File not found: $file"; exit 1
}

Copy-Item $file $bak
Write-Host "[BAK] $bak" -ForegroundColor Cyan

$src = [System.IO.File]::ReadAllText($file)
$applied = 0

function Patch {
    param([string]$label, [string]$anchor, [string]$code, [string]$mode)
    if (-not $script:src.Contains($anchor)) {
        Write-Host "[SKIP] $label (anchor not found)" -ForegroundColor Yellow; return
    }
    switch ($mode) {
        'before'  { $script:src = $script:src.Replace($anchor, $code + $script:nl + $anchor) }
        'after'   { $script:src = $script:src.Replace($anchor, $anchor + $script:nl + $code) }
        'replace' { $script:src = $script:src.Replace($anchor, $code) }
    }
    $script:applied++
    Write-Host "[OK]   $label" -ForegroundColor Green
}

# ── PATCH A: Gold Hunter import ─────────────────────────────
$codeA  = '// ======================================================'
$codeA += $nl + '// GOLD STANDARD HUNTER'
$codeA += $nl + '// ======================================================'
$codeA += $nl + "import { runHunter, checkMint } from './gold_standard_hunter';"
if (-not $src.Contains('gold_standard_hunter')) {
    Patch 'A: Gold Hunter import' '// -- Bot state' $codeA 'before'
}
else { Write-Host "[SKIP] A: already present" -ForegroundColor Yellow }

# ── PATCH B: helper functions ────────────────────────────────
$codeB  = '// ======================================================'
$codeB += $nl + '// EXIT HELPERS'
$codeB += $nl + '// ======================================================'
$codeB += $nl + 'function getDynamicTrailPct(peakPnl: number): number {'
$codeB += $nl + '  if (peakPnl < 0.01) return 0.008;'
$codeB += $nl + '  if (peakPnl < 0.03) return 0.012;'
$codeB += $nl + '  if (peakPnl < 0.06) return 0.018;'
$codeB += $nl + '  if (peakPnl < 0.12) return 0.025;'
$codeB += $nl + '  return 0.035;'
$codeB += $nl + '}'
$codeB += $nl + 'function getMidHoldRiskSeverity(flags: string): string {'
$codeB += $nl + "  if (/honeypot|freeze.*true|mint.*true/i.test(flags)) return 'CRITICAL';"
$codeB += $nl + "  if (/lp_unlocked|lpUnlocked.*true/i.test(flags))     return 'MODERATE';"
$codeB += $nl + "  return 'LOW';"
$codeB += $nl + '}'
if (-not $src.Contains('getDynamicTrailPct')) {
    Patch 'B: helper functions' '// -- Scan cycle' $codeB 'before'
}
else { Write-Host "[SKIP] B: already present" -ForegroundColor Yellow }

# ── PATCH C: entry caps + gold gate ─────────────────────────
$codeC  = '// -- GOLD GATE'
$codeC += $nl + "if (process.env.GOLD_HUNTER_ENABLED === 'true') {"
$codeC += $nl + '  try {'
$codeC += $nl + '    const goldSig = await checkMint(token.address ?? token.pairAddress);'
$codeC += $nl + "    if (goldSig === null) { log('[GOLD] hard-reject ' + (token.address ?? '').slice(0,8)); continue; }"
$codeC += $nl + "    if (goldSig.score < 35) { log('[GOLD] low score ' + goldSig.score); continue; }"
$codeC += $nl + '    (token as any)._goldScore = goldSig.score;'
$codeC += $nl + '    (token as any)._goldTier  = goldSig.tier;'
$codeC += $nl + "    log('[GOLD] ' + goldSig.tier + ' score=' + goldSig.score);"
$codeC += $nl + '  } catch(e) { log("[GOLD] warn: " + e); }'
$codeC += $nl + '}'
$codeC += $nl + '// -- ENTRY CAPS'
$codeC += $nl + '{'
$codeC += $nl + '  const px5mRaw   = (token as any).priceChange5m ?? (token as any).px5m ?? 0;'
$codeC += $nl + '  const volMomRaw = (token as any).volumeMomentum ?? (token as any).volMom ?? 0;'
$codeC += $nl + '  const ageS      = (token as any).ageSeconds ?? 99999;'
$codeC += $nl + "  const eMode     = (token as any)._mode ?? 'MG';"
$codeC += $nl + '  const liqUsd    = (token as any).liquidityUsd ?? (token as any).liquidity ?? 0;'
$codeC += $nl + '  if (px5mRaw > 2.0 && ageS > 120) {'
$codeC += $nl + "    log('[CHASE-VETO] SKIP ' + (token as any).symbol + ' px5m=' + (px5mRaw*100).toFixed(0) + '%');"
$codeC += $nl + '    continue;'
$codeC += $nl + '  }'
$codeC += $nl + "  const px5mCap = eMode === 'SNIPER' ? 0.08 : 0.15;"
$codeC += $nl + '  const isViral = volMomRaw > 8.0 && ageS < 300;'
$codeC += $nl + '  if (px5mRaw > px5mCap && !isViral) {'
$codeC += $nl + "    log('[ENTRY-CAP] SKIP ' + (token as any).symbol + ' px5m=' + (px5mRaw*100).toFixed(1) + '%');"
$codeC += $nl + '    continue;'
$codeC += $nl + '  }'
$codeC += $nl + "  const minLiq = eMode === 'MG' ? 20000 : 15000;"
$codeC += $nl + '  if (liqUsd < minLiq) {'
$codeC += $nl + "    log('[LIQ-GUARD] SKIP ' + (token as any).symbol + ' liq=$' + liqUsd);"
$codeC += $nl + '    continue;'
$codeC += $nl + '  }'
$codeC += $nl + '}'
if (-not $src.Contains('CHASE-VETO')) {
    Patch 'C: Entry caps + Gold gate' '// [SCAN] Funnel' $codeC 'before'
}
else { Write-Host "[SKIP] C: already present" -ForegroundColor Yellow }

# ── PATCH D: dynamic trail + breakeven lock ──────────────────
$codeD  = "// -- DYNAMIC TRAIL + BREAKEVEN LOCK"
$codeD += $nl + "if (process.env.DYNAMIC_TRAIL_ENABLED !== 'false') {"
$codeD += $nl + '  const BE_TRIG = parseFloat(process.env.BREAKEVEN_TRIGGER_PCT ?? "1.0") / 100;'
$codeD += $nl + '  const BE_FLOOR = parseFloat(process.env.BREAKEVEN_FLOOR_PCT ?? "-0.2") / 100;'
$codeD += $nl + '  if (!(trade as any).breakevenLocked && peakPnl >= BE_TRIG) {'
$codeD += $nl + '    (trade as any).breakevenLocked  = true;'
$codeD += $nl + '    (trade as any).dynamicStopFloor = BE_FLOOR;'
$codeD += $nl + "    log('[PROFIT-LOCK] ' + (trade.symbol ?? (trade as any).tokenSymbol) + ' floor=' + (BE_FLOOR*100).toFixed(1) + '%');"
$codeD += $nl + '  }'
$codeD += $nl + '  const trailPct  = getDynamicTrailPct(peakPnl);'
$codeD += $nl + '  const trailFloor = peakPnl - trailPct;'
$codeD += $nl + '  const stopFloor  = (trade as any).dynamicStopFloor ?? -Infinity;'
$codeD += $nl + '  const effStop    = Math.max(trailFloor, stopFloor);'
$codeD += $nl + '  if (currentPnl < effStop) {'
$codeD += $nl + "    const reason = (trade as any).breakevenLocked ? 'BREAKEVEN_LOCK_HIT' : 'DYNAMIC_TRAIL';"
$codeD += $nl + "    log('[EXIT][' + reason + '] ' + (trade.symbol ?? (trade as any).tokenSymbol) + ' pnl=' + (currentPnl*100).toFixed(2) + '% trail=' + (trailPct*100).toFixed(1) + '%');"
$codeD += $nl + '    await executeSell(trade, reason);'
$codeD += $nl + '    continue;'
$codeD += $nl + '  }'
$codeD += $nl + '}'
if (-not $src.Contains('DYNAMIC_TRAIL_ENABLED')) {
    Patch 'D: Dynamic trail + breakeven lock' 'if (currentPnl > peakPnl)' $codeD 'before'
}
else { Write-Host "[SKIP] D: already present" -ForegroundColor Yellow }

# ── PATCH E: MID_HOLD_RISK profit guard (replace the sell call) ─
$anchorE = "executeSell(trade, 'MID_HOLD_RISK')"
$codeE   = '(async () => {'
$codeE  += $nl + "  const sev   = getMidHoldRiskSeverity(midHoldRiskReason ?? '');"
$codeE  += $nl + "  const guard = process.env.MID_HOLD_PROFIT_GUARD !== 'false';"
$codeE  += $nl + "  if (sev === 'CRITICAL') {"
$codeE  += $nl + "    await executeSell(trade, 'MID_HOLD_CRITICAL');"
$codeE  += $nl + "  } else if (sev === 'MODERATE' && guard && currentPnl > 0.005) {"
$codeE  += $nl + '    (trade as any).dynamicStopFloor = currentPnl - 0.008;'
$codeE  += $nl + "    log('[MID-HOLD][MODERATE] profitable — tightening trail');"
$codeE  += $nl + '  } else if (currentPnl <= 0) {'
$codeE  += $nl + "    await executeSell(trade, 'MID_HOLD_RISK');"
$codeE  += $nl + '  }'
$codeE  += $nl + '})();'
if (-not $src.Contains('MID_HOLD_CRITICAL')) {
    Patch 'E: MID_HOLD_RISK profit guard' $anchorE $codeE 'replace'
}
else { Write-Host "[SKIP] E: already present" -ForegroundColor Yellow }

# ── PATCH F: Gold Hunter background polling loop ─────────────
$codeF  = "// -- GOLD HUNTER POLLING LOOP"
$codeF += $nl + "if (process.env.GOLD_HUNTER_ENABLED === 'true') {"
$codeF += $nl + "  log('[GOLD HUNTER] Starting...');"
$codeF += $nl + '  const runGoldCycle = async () => {'
$codeF += $nl + '    try {'
$codeF += $nl + '      const signals = await runHunter();'
$codeF += $nl + '      for (const sig of signals) {'
$codeF += $nl + "        if (sig.tier === 'SKIP' || !sig.gmgn || !sig.dex) continue;"
$codeF += $nl + "        log('[GOLD] ' + sig.tier + ' | ' + sig.mintAddress.slice(0,8) + ' | score=' + sig.score);"
$codeF += $nl + "        if (process.env.MODE === 'live' && sig.tier !== 'LEGENDARY') continue;"
$codeF += $nl + "        if (sig.tier === 'MEDIUM') continue;"
$codeF += $nl + '        const t: any = {'
$codeF += $nl + '          address: sig.mintAddress, pairAddress: sig.dex.pairAddress,'
$codeF += $nl + '          symbol: sig.dex.baseToken.symbol, name: sig.dex.baseToken.name,'
$codeF += $nl + '          liquidity: sig.dex.liquidity?.usd ?? 0, marketCap: sig.dex.marketCap ?? 0,'
$codeF += $nl + '          holders: sig.gmgn.holder_count, volume24h: sig.dex.volume?.h24 ?? 0,'
$codeF += $nl + '          buys1h: sig.dex.txns?.h1?.buys ?? 0, sells1h: sig.dex.txns?.h1?.sells ?? 0,'
$codeF += $nl + '          priceChangeH1: sig.dex.priceChange?.h1 ?? 0,'
$codeF += $nl + '          createdAt: sig.gmgn.creation_timestamp * 1000,'
$codeF += $nl + '          _goldScore: sig.score, _goldTier: sig.tier,'
$codeF += $nl + "          source: 'GOLD_HUNTER',"
$codeF += $nl + '        };'
$codeF += $nl + '        try { await checkTokenSafety(t); } catch(e) { log("[GOLD] inject err: " + e); }'
$codeF += $nl + '      }'
$codeF += $nl + '    } catch(e) { log("[GOLD HUNTER] cycle error: " + e); }'
$codeF += $nl + '  };'
$codeF += $nl + '  setTimeout(() => { runGoldCycle(); setInterval(runGoldCycle, 30000); }, 10000);'
$codeF += $nl + "  log('[GOLD HUNTER] Active - polling every 30s');"
$codeF += $nl + '} else {'
$codeF += $nl + "  log('[GOLD HUNTER] Disabled - set GOLD_HUNTER_ENABLED=true to activate');"
$codeF += $nl + '}'

# Try multiple anchors for the server.listen line
$foundF = $false
foreach ($anchor in @("server.listen(", "app.listen(")) {
    if ($src.Contains($anchor) -and -not $foundF) {
        $lineEnd = $src.IndexOf($nl, $src.LastIndexOf($anchor))
        if ($lineEnd -ge 0) {
            $listenLine = $src.Substring($src.LastIndexOf($anchor), $lineEnd - $src.LastIndexOf($anchor))
            if (-not $src.Contains('GOLD HUNTER] Active')) {
                Patch ('F: Gold Hunter loop (anchor: ' + $anchor + ')') $anchor $codeF 'after'
                $foundF = $true
            } else {
                Write-Host "[SKIP] F: already present" -ForegroundColor Yellow
                $foundF = $true
            }
        }
    }
}
if (-not $foundF) {
    Write-Host "[SKIP] F: server.listen anchor not found" -ForegroundColor Yellow
}

# ── WRITE ───────────────────────────────────────────────────
if ($applied -eq 0) {
    Write-Host "`n[RESULT] 0 patches applied (all present or anchors missing)" -ForegroundColor Yellow
    exit 0
}

[System.IO.File]::WriteAllText($file, $src, [System.Text.Encoding]::UTF8)
Write-Host "`n[RESULT] Applied $applied patch(es) to routes_EXPLOSIVE_SELECT.ts" -ForegroundColor Green
Write-Host "Backup: $bak"
Write-Host "`nNext: npm run build && npm run start"