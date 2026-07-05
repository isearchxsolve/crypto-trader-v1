const { Pool } = require('pg');
require('dotenv').config({ override: true });

async function clear() {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/crypto_db',
  });
  console.log("Clearing trades and resetting stats...");
  await pool.query('TRUNCATE TABLE trades CASCADE;');
  await pool.query('UPDATE bot_status SET total_trades=0, total_pnl=0, win_rate=0, open_positions=0, wallet_balance=0.05;');
  console.log("Done.");
  await pool.end();
}

clear().catch(console.error);
