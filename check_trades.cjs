const { Pool } = require('pg');
const pool = new Pool({ connectionString: 'postgres://postgres:postgres@localhost:5432/crypto_db', connectionTimeoutMillis: 5000 });

async function main() {
  try {
    // Get column names
    const cols = await pool.query("SELECT column_name FROM information_schema.columns WHERE table_name = 'trades' ORDER BY ordinal_position");
    console.log('TRADES COLUMNS:', cols.rows.map(r => r.column_name).join(', '));

    // Get open trades
    const open = await pool.query("SELECT * FROM trades WHERE status = 'open' LIMIT 20");
    console.log('\nOPEN TRADES:', open.rows.length);
    open.rows.forEach(r => console.log(' -', JSON.stringify(r)));

    // Get recent trades
    const recent = await pool.query('SELECT * FROM trades ORDER BY id DESC LIMIT 5');
    console.log('\nLAST 5 TRADES:');
    recent.rows.forEach(r => console.log(' -', JSON.stringify(r)));

    // Bot status
    const bs = await pool.query('SELECT * FROM bot_status');
    console.log('\nBOT STATUS:', JSON.stringify(bs.rows[0], null, 2));
  } catch(e) {
    console.error('DB ERROR:', e.message);
  } finally {
    await pool.end();
  }
}
main();
