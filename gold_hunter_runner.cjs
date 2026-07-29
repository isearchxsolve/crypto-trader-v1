#!/usr/bin/env node
/**
 * gold_hunter_runner.cjs — Standalone Gold Hunter Process
 *
 * Runs the Gold Standard Hunter (gold_standard_hunter.ts) as a dedicated
 * independent process with its own aggressive polling loops.
 *
 * The hunter scans:
 *   1. GMGN Signal Feed (smart money buys — every 5s)
 *   2. Smart Money Cluster Detection (every 10s)
 *   3. GMGN Trending Batch Filter (every 30s)
 *   4. GMGN Trenches Near-Completion Sniper (every 20s)
 *   5. DexScreener Feeds — Profiles, CTOs, Boosts (every 15s)
 *
 * Uses TypeScript's tsx to transpile on the fly.
 *
 * Usage: npx tsx gold_hunter_runner.cjs
 */

// Use dynamic import so this works regardless of .cjs / .mjs extension
let runHunter: Function;

async function loadHunter() {
  const mod = await import('./server/gold_standard_hunter.js');
  runHunter = mod.runHunter;
  console.log('[GOLD-HUNTER] gold_standard_hunter loaded');
}

// ── CONFIG ──────────────────────────────────────────────────────────────────
const HUNTER_INTERVAL_MS = Number(process.env.HUNTER_INTERVAL_MS) || 30_000; // 30s between full runs

// ── DEDUP CACHE ─────────────────────────────────────────────────────────────
const seenMints = new Map(); // mint → last seen ms
const SEEN_TTL_MS = 30_000;   // Re-report same mint after 30s
const MAX_CACHE = 5_000;       // Max entries before pruning

// ── LOGGING ─────────────────────────────────────────────────────────────────
function log(level: string, msg: string) {
  const ts = new Date().toISOString().replace('T', ' ').slice(0, 23);
  console.log(`[${ts}] [GOLD-HUNTER] ${level}: ${msg}`);
}

// ── MAIN LOOP ───────────────────────────────────────────────────────────────
let cycleCount = 0;

async function runCycle() {
  cycleCount++;
  const start = Date.now();
  const cycleTag = `cycle#${cycleCount}`;

  if (typeof runHunter !== 'function') {
    log('WARN', `${cycleTag}: hunter not loaded yet, skipping`);
    setTimeout(runCycle, 5000);
    return;
  }

  try {
    log('RUN', `${cycleTag} starting...`);

    // runHunter() runs all 5 feeds in parallel and deduplicates
    const signals: any[] = await runHunter();
    const legendary = signals.filter(s => s.tier === 'LEGENDARY');
    const high = signals.filter(s => s.tier === 'HIGH');
    const medium = signals.filter(s => s.tier === 'MEDIUM');

    const elapsedMs = Date.now() - start;
    log('RESULT', `${cycleTag} | ${signals.length} signals in ${elapsedMs}ms | ` +
      `🏆${legendary.length} 🔥${high.length} 📊${medium.length}`);

    // Log top-10 signals
    const top10 = signals.slice(0, 10);
    for (const s of top10) {
      const tierEmoji = s.tier === 'LEGENDARY' ? '🏆' : s.tier === 'HIGH' ? '🔥' : '📊';
      // Dedup check
      const lastSeen = seenMints.get(s.mintAddress) ?? 0;
      const isNew = (Date.now() - lastSeen) > SEEN_TTL_MS;
      if (isNew) seenMints.set(s.mintAddress, Date.now());

      const newFlag = isNew ? '🆕' : '🔄';
      console.log(`  ${newFlag}${tierEmoji} #${s.mintAddress.slice(0, 8).toUpperCase()} | ` +
        `score:${s.score} | tier:${s.tier} | src:${s.source} | ` +
        `signals:${s.signals?.length || 0}`);
    }

    // Prune old cache entries
    if (seenMints.size > MAX_CACHE) {
      const cutoff = Date.now() - 300_000; // 5 min
      for (const [mint, ts] of seenMints) {
        if (ts < cutoff) seenMints.delete(mint);
      }
    }

  } catch (err: any) {
    log('ERROR', `${cycleTag} failed: ${err.message || err}`);
  }

  // Schedule next cycle (compute delay from cycle start to maintain consistent interval)
  const cycleDuration = Date.now() - start;
  const delay = Math.max(1000, HUNTER_INTERVAL_MS - cycleDuration);
  setTimeout(runCycle, delay);
}

// ── STARTUP ─────────────────────────────────────────────────────────────────
console.log('');
console.log('╔═══════════════════════════════════════════════════════════════╗');
console.log('║   🔱 GOLD STANDARD HUNTER — Standalone Process              ║');
console.log('║   Scanning GMGN signals + trending + trenches + DexScreener ║');
console.log('║   Interval: ' + String(HUNTER_INTERVAL_MS).padEnd(39) + '║');
console.log('╚═══════════════════════════════════════════════════════════════╝');
console.log('');

// Async startup — load hunter module then start
(async () => {
  await loadHunter();
  log('INIT', 'Starting first cycle...');
  runCycle();
})().catch(err => {
  console.error(`[GOLD-HUNTER] [FATAL] Startup failed: ${err.message}`);
  setTimeout(() => process.exit(1), 500);
});

// ── GRACEFUL SHUTDOWN ──────────────────────────────────────────────────────
function shutdown(signal: string) {
  const msg = `[GOLD-HUNTER] SHUTDOWN: Received ${signal} — stopping`;
  process.stdout.write(msg + '\n');
  setTimeout(() => process.exit(0), 200);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
