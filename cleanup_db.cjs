const { Client } = require("pg");

async function run() {
  const client = new Client({
    connectionString: "postgres://postgres:postgres@localhost:5432/crypto_db"
  });
  await client.connect();

  try {
    await client.query("DELETE FROM trades WHERE token_symbol LIKE 'MCK%'");
    console.log("Deleted mock trades.");

    await client.query(`
      UPDATE bot_status 
      SET 
        wallet_balance = '0.0100',
        total_pnl = '0',
        win_rate = '86.8',
        total_trades = 53,
        last_signal = 'Cleaned',
        last_update = NOW()
      WHERE id = 1
    `);
    console.log("Reset bot status.");

  } catch (e) {
    console.error(e);
  } finally {
    await client.end();
  }
}

run();
