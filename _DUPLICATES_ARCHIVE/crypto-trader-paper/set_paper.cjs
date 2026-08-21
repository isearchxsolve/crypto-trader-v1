const { Client } = require('pg');
const client = new Client({connectionString: 'postgres://postgres:postgres@localhost:5432/crypto_db'});
client.connect()
  .then(() => client.query("UPDATE bot_status SET trading_mode = 'paper'"))
  .then(() => { console.log('Updated to paper mode'); process.exit(0); })
  .catch(e => { console.error(e); process.exit(1); });
