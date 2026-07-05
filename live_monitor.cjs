/**
 * live_monitor.cjs — continuous trades + errors monitor (read-only, never exits)
 *
 * Usage:
 *   node live_monitor.cjs
 *
 * Config via environment (all optional — sensible local defaults):
 *   DATABASE_URL   postgres connection string
 *   LOG_FILE       path to engine log to tail (default: logs/app.log)
 *   POLL_MS        dashboard refresh interval ms (default: 10000)
 *
 * SECURITY: no secrets are hardcoded here. Put DATABASE_URL etc. in a .env
 * file or your shell environment. (dotenv is loaded if present.)
 */
try { require('dotenv').config(); } catch { /* dotenv optional */ }

const { Client } = require('pg');
const fs = require('fs');
const path = require('path');

const DATABASE_URL = process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/crypto_db';
const LOG_FILE = process.env.LOG_FILE || path.join('logs', 'app.log');
const POLL_MS = parseInt(process.env.POLL_MS || '10000', 10);

// Lines in the log we treat as noteworthy errors/events.
const ERROR_RE = /(ERROR|FAILED|HALT|BLOCKED|reverted|timeout|double-spend|DESYNC|Excessive price impact|No route|Quote failed|Swap failed)/i;

// Track how far we've read the log so each cycle only shows NEW lines.
let logOffset = -1; // -1 = first run, jump to current end (don't replay history)

function tailNewErrorLines() {
  let stat;
  try { stat = fs.statSync(LOG_FILE); }
  catch { return; } // log not created yet

  if (logOffset === -1) { logOffset = stat.size; return; } // start at end on first pass
  if (stat.size < logOffset) logOffset = 0;                // file rotated/truncated
  if (stat.size === logOffset) return;                     // nothing new

  let chunk = '';
  try {
    const fd = fs.openSync(LOG_FILE, 'r');
    const buf = Buffer.alloc(stat.size - logOffset);
    fs.readSync(fd, buf, 0, buf.length, logOffset);
    fs.closeSync(fd);
    chunk = buf.toString('utf8');
  } catch (e) {
    console.error('[MONITOR] log read error:', e.message);
    return;
  }
  logOffset = stat.size;

  const hits = chunk.split(/\r?\n/).filter(l => l && ERROR_RE.test(l));
  if (hits.length) {
    console.log(`\n  !! ${hits.length} error/event line(s):`);
    for (const l of hits.slice(-15)) console.log('     ' + l.trim());
  }
}

async function dashboard() {
  const client = new Client({ connectionString: DATABASE_URL, statement_timeout: 8000 });
  try {
    await client.connect();

    const status = (await client.query('SELECT * FROM bot_status LIMIT 1')).rows[0] || {};
    const closedAgg = (await client.query(
      "SELECT COUNT(*)::int AS closed, " +
      "COUNT(CASE WHEN CAST(pnl AS DECIMAL) > 0 THEN 1 END)::int AS wins, " +
      "COALESCE(AVG(CAST(pnl AS DECIMAL)),0) AS avg_pnl " +
      "FROM trades WHERE status = 'CLOSED'"
    )).rows[0];
    const open = (await client.query("SELECT * FROM trades WHERE status = 'OPEN' ORDER BY id DESC")).rows;

    const closed = closedAgg.closed || 0;
    const wins = closedAgg.wins || 0;
    const winRate = closed > 0 ? (wins / closed * 100).toFixed(1) : '0.0';
    const avgPnl = parseFloat(closedAgg.avg_pnl || 0).toFixed(2);
    const liveOpen = open.filter(t => t.trading_mode === 'live');

    const ts = new Date().toLocaleTimeString();
    console.log(
      `[${ts}] mode=${status.trading_mode ?? '?'} running=${status.is_running ?? '?'} ` +
      `bal=${status.wallet_balance ?? '?'} SOL | closed=${closed} winRate=${winRate}% ` +
      `avgPnL=${avgPnl}% | open=${open.length} live=${liveOpen.length}` +
      (liveOpen.length ? '  *** SOL AT RISK ***' : '')
    );
    for (const t of open) {
      console.log(`     #${t.id} ${t.token_symbol} mode=${t.trading_mode} size=${t.amount} entry=${t.price}`);
    }

    // Show the most recent closed trades so wins/losses are visible as they happen.
    const recent = (await client.query(
      "SELECT id, token_symbol, pnl, exit_reason FROM trades WHERE status='CLOSED' ORDER BY id DESC LIMIT 3"
    )).rows;
    for (const t of recent) {
      const p = parseFloat(t.pnl);
      const tag = isNaN(p) ? '' : (p >= 0 ? '+' : '');
      console.log(`     closed #${t.id} ${t.token_symbol} ${tag}${t.pnl}% (${t.exit_reason || '?'})`);
    }
  } catch (e) {
    console.error(`[MONITOR] DB error: ${e.message}`);
  } finally {
    try { await client.end(); } catch {}
  }
}

async function loop() {
  console.log(`[MONITOR] live_monitor started | db=${DATABASE_URL.replace(/:[^:@/]*@/, ':****@')} | log=${LOG_FILE} | every ${POLL_MS}ms`);
  console.log('[MONITOR] read-only — does NOT start/stop/kill the engine. Ctrl+C to quit.\n');
  // eslint-disable-next-line no-constant-condition
  while (true) {
    await dashboard();
    tailNewErrorLines();
    await new Promise(r => setTimeout(r, POLL_MS));
  }
}

loop().catch(e => { console.error('[MONITOR] fatal:', e.message); process.exit(1); });
