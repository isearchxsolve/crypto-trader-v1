const { Client } = require('pg');
require('dotenv').config();

const client = new Client({
  connectionString: process.env.DATABASE_URL
});

async function alter() {
  await client.connect();
  try {
    await client.query(`ALTER TABLE trades ADD COLUMN liquidity numeric;`);
    console.log("Added liquidity column.");
  } catch (e) {
    console.log("Error or already exists:", e.message);
  }
  process.exit(0);
}

alter();
