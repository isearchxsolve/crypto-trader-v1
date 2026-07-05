#!/usr/bin/env node
/*
 * analyze-shadow.cjs — segment your shadow-trade ledger to find a positive-expectancy pocket.
 *
 * USAGE:
 *   node analyze-shadow.cjs                       # reads ./shadow-trades.jsonl
 *   node analyze-shadow.cjs path/to/shadow-trades.jsonl
 *
 * It reads the JSONL your engine writes (one closed shadow trade per line):
 *   { id, ts, token, mode, score, sizeSol, paperPnlPct, shadowPnlPct, gapPct, exitReason }
 *
 * The TRUTH metric is shadowPnlPct (real Jupiter execution). paperPnlPct is the
 * optimistic paper number. A segment only matters if it has positive avg shadow
 * expectancy across a meaningful sample (>= MIN_N trades).
 */

const fs = require("fs");
const path = require("path");

const MIN_N = 8; // minimum trades for a segment verdict to be trusted

function fmt(n, d = 2) { return (n >= 0 ? "+" : "") + n.toFixed(d); }
function pad(s, w) { s = String(s); return s.length >= w ? s : s + " ".repeat(w - s.length); }
function padL(s, w) { s = String(s); return s.length >= w ? s : " ".repeat(w - s.length) + s; }

function scoreBand(score) {
  if (typeof score !== "number" || isNaN(score)) return "score:?";
  if (score >= 90) return "score:90+";
  if (score >= 85) return "score:85-89";
  if (score >= 80) return "score:80-84";
  if (score >= 70) return "score:70-79";
  return "score:<70";
}

function stats(trades) {
  const n = trades.length;
  if (!n) return null;
  let wins = 0, sumS = 0, sumP = 0, comp = 1, best = -Infinity, worst = Infinity;
  for (const t of trades) {
    const s = Number(t.shadowPnlPct) || 0;
    const p = Number(t.paperPnlPct) || 0;
    if (s > 0) wins++;
    sumS += s; sumP += p;
    comp *= (1 + s / 100);
    if (s > best) best = s;
    if (s < worst) worst = s;
  }
  return {
    n,
    winPct: (wins / n) * 100,
    avgShadow: sumS / n,
    avgPaper: sumP / n,
    sumShadow: sumS,
    growthPct: (comp - 1) * 100,
    best, worst,
  };
}

function printTable(title, groups) {
  console.log("\n" + title);
  console.log("  " + pad("segment", 16) + padL("n", 5) + padL("win%", 8) + padL("avgShadow", 12) + padL("avgPaper", 11) + padL("growth%", 11) + padL("verdict", 12));
  const rows = Object.entries(groups).map(([k, arr]) => [k, stats(arr)]).filter(([, s]) => s);
  // sort by avgShadow desc
  rows.sort((a, b) => b[1].avgShadow - a[1].avgShadow);
  for (const [k, s] of rows) {
    let verdict;
    if (s.n < MIN_N) verdict = "low-n";
    else if (s.avgShadow > 0) verdict = "POSITIVE";
    else verdict = "negative";
    console.log("  " + pad(k, 16) + padL(s.n, 5) + padL(s.winPct.toFixed(1), 8) + padL(fmt(s.avgShadow), 12) + padL(fmt(s.avgPaper), 11) + padL(fmt(s.growthPct), 11) + padL(verdict, 12));
  }
  return rows;
}

function main() {
  const file = process.argv[2] || path.join(process.cwd(), "shadow-trades.jsonl");
  if (!fs.existsSync(file)) {
    console.error(`\nFile not found: ${file}\nRun this from your bot folder (where shadow-trades.jsonl lives), or pass the path as an argument.\n`);
    process.exit(1);
  }
  const raw = fs.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean);
  const trades = [];
  let bad = 0;
  for (const line of raw) {
    try { const o = JSON.parse(line); if (o && typeof o === "object") trades.push(o); }
    catch { bad++; }
  }

  console.log("=".repeat(78));
  console.log(`SHADOW-LEDGER SEGMENTATION  —  ${trades.length} trades parsed${bad ? ` (${bad} malformed lines skipped)` : ""}`);
  console.log(`Source: ${file}`);
  console.log(`Truth metric = avgShadow (real Jupiter execution). Segment trusted only if n >= ${MIN_N}.`);
  console.log("=".repeat(78));

  const overall = stats(trades);
  if (!overall) { console.log("No trades to analyze."); return; }
  console.log(`\nOVERALL: n=${overall.n} | win ${overall.winPct.toFixed(1)}% | avgShadow ${fmt(overall.avgShadow)}% | avgPaper ${fmt(overall.avgPaper)}% | growth ${fmt(overall.growthPct)}%`);

  const byMode = {}, byScore = {}, byExit = {}, byModeScore = {};
  for (const t of trades) {
    const m = t.mode || "?";
    const sb = scoreBand(t.score);
    const ex = t.exitReason ? String(t.exitReason).split(" ")[0].split("(")[0] : "?";
    (byMode[m] = byMode[m] || []).push(t);
    (byScore[sb] = byScore[sb] || []).push(t);
    (byExit[ex] = byExit[ex] || []).push(t);
    const key = `${m}/${sb.replace("score:", "")}`;
    (byModeScore[key] = byModeScore[key] || []).push(t);
  }

  printTable("BY MODE", byMode);
  printTable("BY SCORE BAND", byScore);
  const msRows = printTable("BY MODE x SCORE", byModeScore);
  printTable("BY EXIT REASON", byExit);

  // ---- Edge hunt: which segments are positive with enough sample ----
  console.log("\n" + "=".repeat(78));
  console.log("EDGE HUNT");
  console.log("=".repeat(78));
  const positivePockets = msRows.filter(([, s]) => s.n >= MIN_N && s.avgShadow > 0);
  if (!positivePockets.length) {
    console.log("\nNo mode x score segment is positive at n >= " + MIN_N + ".");
    console.log("=> On this data, there is NO tradeable positive-expectancy pocket.");
    console.log("   Honest conclusion: the strategy has no edge in this market regime.");
    console.log("   Do NOT add capital. The fix is better candidate sourcing, not exit tuning.");
  } else {
    console.log("\nPositive-expectancy pockets (n >= " + MIN_N + ", ranked by avgShadow):");
    for (const [k, s] of positivePockets) {
      console.log(`  - ${pad(k, 14)} n=${padL(s.n,3)} | win ${s.winPct.toFixed(1)}% | avgShadow ${fmt(s.avgShadow)}% | growth ${fmt(s.growthPct)}%`);
    }
    // what-if: trade ONLY the positive pockets
    const keep = new Set(positivePockets.map(([k]) => k));
    const filtered = trades.filter(t => keep.has(`${t.mode || "?"}/${scoreBand(t.score).replace("score:", "")}`));
    const f = stats(filtered);
    console.log(`\nWHAT-IF you traded ONLY those pockets:`);
    console.log(`  n=${f.n} (of ${trades.length}) | win ${f.winPct.toFixed(1)}% | avgShadow ${fmt(f.avgShadow)}% | growth ${fmt(f.growthPct)}%`);
    console.log(`  vs overall avgShadow ${fmt(overall.avgShadow)}%  ->  delta ${fmt(f.avgShadow - overall.avgShadow)}%/trade`);
    console.log("\n  NOTE: this is in-sample. Confirm it holds on the NEXT 100+ paper trades before trusting it.");
  }
  console.log("");
}

main();
