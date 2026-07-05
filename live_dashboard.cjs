const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({ 
  connectionString: process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/crypto_db' 
});

async function monitor() {
  console.clear();
  console.log("==================================================");
  console.log("             🔴 LIVE TRADING DASHBOARD            ");
  console.log("==================================================\n");

  try {
    const bs = await pool.query('SELECT * FROM bot_status');
    if (bs.rows.length > 0) {
      const status = bs.rows[0];
      console.log(`Status: ${status.is_running ? '🟢 RUNNING' : '🔴 HALTED'} | Mode: ${status.trading_mode.toUpperCase()}`);
      console.log(`Wallet: ${status.wallet_balance} SOL | Total PnL: ${status.total_pnl}%`);
      console.log(`Win Rate: ${status.win_rate}% | Total Trades: ${status.total_trades}\n`);
    }

    const open = await pool.query("SELECT * FROM trades WHERE status = 'OPEN' ORDER BY id DESC");
    console.log(`--- OPEN POSITIONS (${open.rows.length}) ---`);
    if (open.rows.length === 0) {
      console.log("  No active trades at the moment. Hunting for setups...");
    } else {
      open.rows.forEach(r => {
        const pnlColor = parseFloat(r.pnl) >= 0 ? '🟢' : '🔴';
        console.log(`  ${pnlColor} $${r.token_symbol.padEnd(8)} | Score: ${r.score} | PnL: ${r.pnl}% (Peak: ${r.peak_pnl}%) | Entry: ${r.price}`);
      });
    }

    console.log(`\n--- LAST 5 CLOSED TRADES ---`);
    const closed = await pool.query("SELECT * FROM trades WHERE status = 'CLOSED' ORDER BY id DESC LIMIT 5");
    if (closed.rows.length === 0) {
      console.log("  No closed trades yet.");
    } else {
      closed.rows.forEach(r => {
        const pnlColor = parseFloat(r.pnl) > 0 ? '🟢' : (parseFloat(r.pnl) === 0 ? '⚪' : '🔴');
        console.log(`  ${pnlColor} $${r.token_symbol.padEnd(8)} | PnL: ${r.pnl}% | Exit: ${r.exit_reason}`);
      });
    }
    
    console.log("\n--- LAST SCAN DIAGNOSTICS ---");
    try {
      const fs = require('fs');
      if (fs.existsSync('last_scan.json')) {
        const scanData = JSON.parse(fs.readFileSync('last_scan.json', 'utf8'));
        console.log(`  Last Update: ${new Date(scanData.timestamp).toLocaleTimeString()}`);
        if (scanData.topCoins && scanData.topCoins.length > 0) {
          scanData.topCoins.forEach((c, i) => {
             console.log(`  #${i+1} $${c.symbol.padEnd(8)} | Score: ${c.score.toString().padEnd(3)} | Reason: ${c.reason}`);
          });
        } else {
          console.log("  No tokens survived the funnel this scan.");
        }
      } else {
        console.log("  Waiting for next engine scan...");
      }
    } catch(e) {
      console.log("  Loading scan diagnostics...");
    }

    console.log("\n==================================================");
    console.log("Refreshing every 2 seconds... (Press Ctrl+C to exit)");
  } catch (e) {
    console.error("Database Connection Error:", e.message);
  }
}

// Run immediately, then loop every 2 seconds
monitor();
setInterval(monitor, 2000);
