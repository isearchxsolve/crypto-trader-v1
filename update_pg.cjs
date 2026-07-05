const { Client } = require("pg");

async function run() {
  const client = new Client({
    connectionString: "postgres://postgres:postgres@localhost:5432/crypto_db"
  });
  await client.connect();
  const res = await client.query("SELECT * FROM bot_settings");
  let config = res.rows[0].config;
  console.log("OLD:", config);
  
  config = typeof config === "string" ? JSON.parse(config) : config;
  config.scanIntervalMs = 5000;
  config.priceCheckIntervalMs = 500;
  config.maxHoldSeconds = 30;
  config.maxOpenPositions = 5;
  config.minScoreToTrade = 20;
  config.sniperMinScore = 20;
  config.mgMinScore = 20;
  
  await client.query("UPDATE bot_settings SET config = $1", [config]);
  console.log("UPDATED SUCCESSFULLY");
  await client.end();
}
run().catch(console.error);
