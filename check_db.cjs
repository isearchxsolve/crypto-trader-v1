const { Pool } = require("pg");
const pool = new Pool({ connectionString: "postgres://postgres:postgres@localhost:5432/crypto_db" });

async function check() {
  const active = await pool.query("SELECT COUNT(*) FROM active_trades");
  const past = await pool.query("SELECT COUNT(*) FROM past_trades");
  console.log("Active trades:", active.rows[0].count);
  console.log("Past trades:", past.rows[0].count);
  process.exit(0);
}
check();
