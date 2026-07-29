/**
 * generate_report.cjs — 24-Hour Paper Trading Session Report Generator
 *
 * Analyzes shadow-stats.json, shadow-trades.jsonl, and paper session logs
 * to produce a comprehensive performance report.
 *
 * Usage: node generate_report.cjs [logdir]
 *   If logdir is provided, it includes engine log analysis from that directory.
 *   If omitted, generates report from live state only.
 */

const fs = require('fs');
const path = require('path');

const ROOT = process.cwd();
const SHADOW_STATS = path.join(ROOT, 'shadow-stats.json');
const SHADOW_TRADES = path.join(ROOT, 'shadow-trades.jsonl');


// ── Banner ──────────────────────────────────────────────────────────────────
console.log(`
╔═══════════════════════════════════════════════════════════════╗
║     🏆  24-HOUR PAPER TRADING SESSION REPORT               ║
║     Generated: ${new Date().toISOString().replace('T', ' ').slice(0, 19)}                     ║
╚═══════════════════════════════════════════════════════════════╝
`);

// ── 1. Shadow Ledger Analysis ──────────────────────────────────────────────
console.log('📊  SHADOW LEDGER (Real Execution Simulation)\n');

let shadow = { totalTrades: 0, wins: 0, losses: 0, sumShadowPnl: 0, sumPaperPnl: 0,
               sumInflation: 0, compoundedMult: 1, bestPct: 0, worstPct: 0, firstAt: null, lastAt: null };

if (fs.existsSync(SHADOW_STATS)) {
  try {
    shadow = JSON.parse(fs.readFileSync(SHADOW_STATS, 'utf8'));
    // Ensure compoundedMult exists (older versions may not have it)
    shadow.compoundedMult = shadow.compoundedMult ?? 1;
    const n = shadow.totalTrades;
    const avgShadow = n ? (shadow.sumShadowPnl / n).toFixed(2) : '0.00';
    const avgPaper = n ? (shadow.sumPaperPnl / n).toFixed(2) : '0.00';
    const avgInfl = n ? (shadow.sumInflation / n).toFixed(2) : '0.00';
    const winRate = n ? ((shadow.wins / n) * 100).toFixed(1) : '0.0';
    const growthPct = ((shadow.compoundedMult - 1) * 100).toFixed(2);
    const score = (n >= 20 && avgShadow > 0 && growthPct > 0) ? '✅ POSITIVE' :
                  (n >= 20) ? '❌ NEGATIVE' : '⏳ INSUFFICIENT DATA';

    console.log(`  Total Trades:    ${n}`);
    console.log(`  Wins:            ${shadow.wins}`);
    console.log(`  Losses:          ${shadow.losses}`);
    console.log(`  Win Rate:        ${winRate}%`);
    console.log(`  Avg Shadow PnL:  ${avgShadow}%/trade`);
    console.log(`  Avg Paper PnL:   ${avgPaper}%/trade (${avgInfl}% inflation)`);
    console.log(`  Compounded Growth: ${growthPct}%`);
    console.log(`  Best Trade:      ${shadow.bestPct.toFixed(2)}%`);
    console.log(`  Worst Trade:     ${shadow.worstPct.toFixed(2)}%`);
    console.log(`  Verdict:         ${score}`);
  } catch (e) {
    console.log('  [ERROR loading shadow-stats.json]');
  }
} else {
  console.log('  [No shadow trades yet — bot is scanning/accumulating]');
}

// ── 2. Per-Trade Breakdown ────────────────────────────────────────────────
console.log('\n📝  RECENT TRADE BREAKDOWN\n');

if (fs.existsSync(SHADOW_TRADES)) {
  try {
    const lines = fs.readFileSync(SHADOW_TRADES, 'utf8').trim().split('\n').filter(Boolean);
    const trades = lines.map(l => JSON.parse(l)).sort((a, b) => (b.ts || 0) - (a.ts || 0));
    
    console.log(`  Total trades recorded: ${trades.length}\n`);
    
    // Show last 20 trades
    const recent = trades.slice(0, 20);
    console.log('  Last 20 trades:');
    console.log('  ───────────────────────────────────────────────────────────────');
    console.log('  #   Token     Mode  Score  Size    PaperPnl  ShadowPnl  Exit');
    console.log('  ───────────────────────────────────────────────────────────────');
    
    for (const t of recent) {
      const paperStr = (t.paperPnlPct || 0).toFixed(2);
      const shadowStr = (t.shadowPnlPct || 0).toFixed(2);
      const scoreStr = String(t.score || '?');
      const sizeStr = (t.sizeSol || 0).toFixed(4);
      const exitStr = (t.exitReason || '?').slice(0, 20);
      console.log(`  ${String(t.id).padEnd(3)} ${(t.token || '???').padEnd(9)} ${(t.mode || '?').padEnd(5)} ${scoreStr.padEnd(5)} ${sizeStr.padEnd(7)} ${paperStr.padEnd(8)}% ${shadowStr.padEnd(8)}% ${exitStr}`);
    }
    
    // Trading frequency
    const firstTs = trades.length ? Math.min(...trades.map(t => t.ts || Infinity)) : 0;
    const lastTs = trades.length ? Math.max(...trades.map(t => t.ts || 0)) : 0;
    const sessionHours = (lastTs - firstTs) / 3600000;
    const tradesPerHour = sessionHours > 0 ? (trades.length / sessionHours).toFixed(2) : 'N/A';
    
    // Aggregate by mode
    const byMode = {};
    for (const t of trades) {
      const m = t.mode || 'UNKNOWN';
      if (!byMode[m]) byMode[m] = { count: 0, sumShadowPnl: 0, wins: 0, losses: 0 };
      byMode[m].count++;
      byMode[m].sumShadowPnl += t.shadowPnlPct || 0;
      if ((t.shadowPnlPct || 0) > 0) byMode[m].wins++;
      else byMode[m].losses++;
    }
    
    // Aggregate by exit reason
    const byExit = {};
    for (const t of trades) {
      const r = (t.exitReason || 'UNKNOWN').split(' ')[0].split('(')[0]; // Get exit type prefix
      if (!byExit[r]) byExit[r] = { count: 0, sumShadowPnl: 0, wins: 0 };
      byExit[r].count++;
      byExit[r].sumShadowPnl += t.shadowPnlPct || 0;
      if ((t.shadowPnlPct || 0) > 0) byExit[r].wins++;
    }
    
    console.log(`\n  Session Duration: ${sessionHours.toFixed(1)} hours`);
    console.log(`  Trade Frequency:  ${tradesPerHour} trades/hour`);
    
    console.log('\n  Performance by Mode:');
    console.log('  ─────────────────────────────────────────────');
    console.log('  Mode     Trades  WinRate  AvgShadow  Score');
    console.log('  ─────────────────────────────────────────────');
    for (const [mode, data] of Object.entries(byMode)) {
      const wr = data.count ? ((data.wins / data.count) * 100).toFixed(1) : '0.0';
      const avg = data.count ? (data.sumShadowPnl / data.count).toFixed(2) : '0.00';
      const score2 = data.count >= 5 && avg > 0 ? '✅' : (data.count >= 5 ? '❌' : '⏳');
      console.log(`  ${mode.padEnd(9)} ${String(data.count).padEnd(7)} ${wr.padEnd(7)}% ${avg.padEnd(9)}% ${score2}`);
    }
    
    console.log('\n  Performance by Exit Reason:');
    console.log('  ────────────────────────────────────────────────────────');
    console.log('  Exit Type        Count  WinRate  AvgShadow  Impact');
    console.log('  ────────────────────────────────────────────────────────');
    for (const [reason, data] of Object.entries(byExit).sort((a,b) => b[1].count - a[1].count)) {
      const wr = data.count ? ((data.wins / data.count) * 100).toFixed(1) : '0.0';
      const avg = data.count ? (data.sumShadowPnl / data.count).toFixed(2) : '0.00';
      console.log(`  ${reason.padEnd(18)} ${String(data.count).padEnd(6)} ${wr.padEnd(7)}% ${avg.padEnd(9)}% ${avg > 0 ? '✅' : '❌'}`);
    }
    
  } catch (e) {
    console.log('  [ERROR loading shadow-trades.jsonl]');
  }
} else {
  console.log('  [No trade history file found]');
}

// ── 3. Engine Configuration Summary ───────────────────────────────────────
console.log('\n⚙️  ENGINE CONFIGURATION\n');

const config = {
  exit: 'trail@6%/distance12%/stop-8%',
  tps: 'partial@4%/40%ratio',
  scores: 'minScore65/sniper80/mg40/hwr40',
  liquidity: 'sniper20k/mg8k/hwr5k',
  sizing: 'min0.003/max0.012',
  compoud: 'ENABLED(ref0.3SOL/power1.5)',
  rugcheck: 'score200/maxNorm60',
  regime: 'runners1/pct10',
  frequency: 'scan5s/price400ms',
};

console.log(`  Exit:         ${config.exit}`);
console.log(`  TP:           ${config.tps}`);
console.log(`  Scores:       ${config.scores}`);
console.log(`  Liquidity:    ${config.liquidity}`);
console.log(`  Sizing:       ${config.sizing}`);
console.log(`  Compound:     ${config.compoud}`);
console.log(`  RugCheck:     ${config.rugcheck}`);
console.log(`  Regime Gate:  ${config.regime}`);
console.log(`  Frequency:    ${config.frequency}`);

// ── 4. Overall Assessment ─────────────────────────────────────────────────
console.log('\n🎯  OVERALL ASSESSMENT\n');

const n = shadow.totalTrades || 0;
const avgShadow = n ? shadow.sumShadowPnl / n : 0;
const avgPaper = n ? shadow.sumPaperPnl / n : 0;
const avgInfl = n ? shadow.sumInflation / n : 0;
const winRate = n ? (shadow.wins / n) * 100 : 0;
const growth = n ? (shadow.compoundedMult - 1) * 100 : 0;

console.log('  Performance Metrics:');
console.log(`  • Trade Volume: ${n} trades`);
console.log(`  • Win Rate: ${winRate.toFixed(1)}% ${winRate >= 50 ? '✅' : '⚠️'}`);
console.log(`  • Avg Shadow PnL: ${avgShadow.toFixed(2)}%/trade ${avgShadow > 0 ? '✅' : avgShadow === 0 ? '⏸️' : '❌'}`);
console.log(`  • Compounded Growth: ${growth.toFixed(2)}% ${growth > 0 ? '✅' : growth === 0 ? '⏸️' : '❌'}`);
console.log(`  • Paper Inflation: ${avgInfl.toFixed(2)}%/trade ${avgInfl < 5 ? '✅' : avgInfl < 10 ? '⚠️' : '❌'}`);
console.log(`  • Best/Worst: +${(shadow.bestPct || 0).toFixed(2)}% / ${(shadow.worstPct || 0).toFixed(2)}%`);

console.log('\n  Verdict:');
if (n < 20) {
  console.log(`  ⏳ Need ${20 - n} more trades before the edge is statistically meaningful.`);
  console.log(`  Current sample: ${n}/20 trades. Keep running.`);
} else if (avgShadow > 0 && growth > 0) {
  console.log('  ✅ GENUINE POSITIVE EDGE confirmed across meaningful sample.');
  console.log(`  Avg +${avgShadow.toFixed(2)}%/trade net of real execution costs.`);
  console.log(`  Compounded growth: +${growth.toFixed(2)}% across ${n} trades.`);
  console.log('  Consider: increasing position sizes or exploring live mode.');
} else if (avgShadow > 0) {
  console.log('  ⚠️ Positive average PnL but compounded growth is negative.');
  console.log('  This indicates high variance — check for large outlier losses.');
} else {
  console.log('  ❌ No positive edge detected in the shadow ledger yet.');
  console.log('  Tune the strategy further. Do NOT add capital.');
  console.log(`  Run ${n < 20 ? `more trades (${20 - n} remaining)` : 'a full tuning pass'} before considering live.`);
}

console.log(`\n📁  Full shadow ledger: shadow-stats.json`);
console.log(`📁  Trade history:      shadow-trades.jsonl`);
console.log('');
