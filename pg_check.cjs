const { Client } = require('pg');
const client = new Client({ connectionString: 'postgres://postgres:postgres@localhost:5432/crypto_db' });
client.connect().then(() => {
  return client.query("SELECT token_symbol, pnl_pct, close_reason FROM trades WHERE status='CLOSED' ORDER BY closed_at DESC LIMIT 10");
}).then(res => {
  console.log(res.rows);
  client.end();
}).catch(console.error);
