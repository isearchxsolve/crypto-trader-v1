// DR inspector: reads connection string from existing script at runtime (never prints secret).
const { Client } = require("pg");
const fs = require("fs");
const path = require("path");

function getConnStr() {
  for (const f of ["check_trades.cjs", "set_paper.cjs", "cleanup_db.cjs", "alter_db.cjs"]) {
    try {
      const src = fs.readFileSync(path.join(__dirname, f), "utf8");
      const m = src.match(/connectionString:\s*(?:"([^"]*)"|'([^']*)')/);
      if (m && (m[1] || m[2])) return m[1] || m[2];
    } catch {}
  }
  return process.env.DATABASE_URL || null;
}

async function run() {
  const cs = getConnStr();
  if (!cs) { console.error("Could not locate DB connection string"); process.exit(2); }
  const client = new Client({ connectionString: cs, statement_timeout: 8000 });
  await client.connect();

  const cols = (await client.query("SELECT column_name FROM information_schema.columns WHERE table_name='trades' ORDER BY ordinal_position")).rows.map(r => r.column_name);
  console.log("TRADES COLUMNS:", cols.join(", "));

  const status = (await client.query("SELECT * FROM bot_status")).rows[0];
  console.log("\n=== BOT_STATUS ===");
  console.log("trading_mode:", status.trading_mode);
  console.log("is_running:", status.is_running);
  console.log("wallet_balance:", status.wallet_balance);

  const tsCol = cols.includes("timestamp") ? "timestamp" : (cols.includes("created_at") ? "created_at" : "id");
  const open = (await client.query(`SELECT * FROM trades WHERE status = 'OPEN' ORDER BY ${tsCol} DESC`)).rows;
  console.log("\n=== OPEN TRADES: " + open.length + " ===");
  for (const t of open) {
    console.log(`  #${t.id} ${t.token_symbol} | mode=${t.trading_mode} | size=${t.amount} | price=${t.price} | ${tsCol}=${t[tsCol]}`);
  }
  const liveOpen = open.filter(t => t.trading_mode === "live");
  console.log("\n>>> OPEN LIVE POSITIONS:", liveOpen.length, liveOpen.length > 0 ? "*** SOL AT RISK IF BOT HUNG ***" : "(none - safe)");

  const closed = (await client.query("SELECT COUNT(*)::int AS n FROM trades WHERE status='CLOSED'")).rows[0].n;
  console.log("closed trades:", closed);
  await client.end();
}
run().catch(e => { console.error("DR_INSPECT_ERROR:", e.message); process.exit(1); });
