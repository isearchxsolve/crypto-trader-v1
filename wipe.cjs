const { Pool } = require("pg");
const pool = new Pool({ connectionString: "postgres://postgres:postgres@localhost:5432/crypto_db" });

async function wipe() {
  try {
    await pool.query("DELETE FROM trades");
    await pool.query("DELETE FROM candidates");
    await pool.query("UPDATE bot_status SET wallet_balance = '0.05', total_pnl = '0', win_rate = '0', total_trades = 0, open_positions = 0");
    console.log("Database wiped successfully!");
  } catch(e) {
    console.error(e);
  } finally {
    process.exit(0);
  }
}
wipe();
