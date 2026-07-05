// Runs every 20 min, checks shadow & paper status, logs summary
const http = require("http");

function fetch(path) {
  return new Promise((resolve, reject) => {
    const opts = { hostname: "localhost", port: 5000, path, method: "GET", timeout: 10000, headers: { Accept: "application/json" } };
    http.get(opts, (r) => { let d = ""; r.on("data", (c) => (d += c)); r.on("end", () => { try { resolve(JSON.parse(d)); } catch { resolve(null); } }); }).on("error", reject);
  });
}

async function check() {
  const now = new Date().toLocaleString();
  try {
    const [status, shadow] = await Promise.all([fetch("/api/bot/status"), fetch("/api/shadow/trades")]);
    if (!status && !shadow) { console.log(`[${now}] Server unreachable`); return; }
    const bal = status?.walletBalance || "?";
    const open = status?.openPositions ?? "?";
    const last = (status?.lastSignal || "").slice(0, 80);
    const closed = shadow?.closed || [];
    const openS = shadow?.open || [];
    const wins = closed.filter((t) => t.shadowPnlPct > 0).length;
    const losses = closed.filter((t) => t.shadowPnlPct <= 0).length;
    const wr = closed.length > 0 ? ((wins / closed.length) * 100).toFixed(1) : "?";
    const avgPaper = closed.length > 0 ? (closed.reduce((s, t) => s + t.paperPnlPct, 0) / closed.length).toFixed(2) : "?";
    const avgShadow = closed.length > 0 ? (closed.reduce((s, t) => s + t.shadowPnlPct, 0) / closed.length).toFixed(2) : "?";
    const avgGap = closed.length > 0 ? (closed.reduce((s, t) => s + (t.pnlGapPct || 0), 0) / closed.length).toFixed(2) : "?";
    console.log(`[${now}] BAL:${bal} OPEN:${open} SHADOW:${closed.length}cl/${openS.length}op WR:${wr}% paperAvg:${avgPaper}% shadowAvg:${avgShadow}% gap:${avgGap}% last:${last}`);
    if (closed.length >= 3) {
      const last3 = closed.slice(-3);
      last3.forEach((t) => console.log(`  ${t.tokenSymbol} paper:${t.paperPnlPct.toFixed(2)}% shadow:${t.shadowPnlPct.toFixed(2)}% gap:${(t.pnlGapPct || 0).toFixed(2)}%`));
    }
  } catch (e) {
    console.log(`[${now}] Error: ${e.message}`);
  }
}

console.log("=== Shadow Monitor started (checking every 20 minutes) ===");
check();
setInterval(check, 20 * 60 * 1000);
