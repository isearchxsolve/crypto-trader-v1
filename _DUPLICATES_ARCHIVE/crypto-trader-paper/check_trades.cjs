const { Client } = require("pg");

async function run() {
  const client = new Client({
    connectionString: "postgres://postgres:postgres@localhost:5432/crypto_db"
  });
  await client.connect();
  const res = await client.query("SELECT COUNT(*) FROM trades WHERE status = 'CLOSED'");
  console.log("COMPLETED TRADES:", res.rows[0].count);
  
  const res2 = await client.query("SELECT * FROM bot_status");
  console.log("BOT STATUS:", JSON.stringify(res2.rows, null, 2));
  await client.end();
}
run().catch(console.error);
