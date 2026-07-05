const { Pool } = require('pg');
const pool = new Pool({ 
  connectionString: 'postgres://postgres:postgres@localhost:5432/crypto_db', 
  connectionTimeoutMillis: 5000 
});

async function main() {
  try {
    await pool.query("UPDATE bot_status SET trading_mode = 'live'");
    const r = await pool.query('SELECT id, trading_mode, is_running, wallet_balance FROM bot_status');
    console.log('DB STATE AFTER FIX:', JSON.stringify(r.rows, null, 2));
  } catch(e) {
    console.error('DB ERROR:', e.message);
  } finally {
    await pool.end();
  }
}
main();
