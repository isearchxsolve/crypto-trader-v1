const { Client } = require('pg');
require('dotenv').config();

const client = new Client({
  connectionString: process.env.DATABASE_URL
});

async function check() {
  await client.connect();
  const res = await client.query(`SELECT id, token_symbol, mode, liquidity FROM trades WHERE id = 9334`);
  console.log(res.rows[0]);
  process.exit(0);
}

check();
