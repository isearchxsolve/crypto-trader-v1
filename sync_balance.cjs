/**
 * sync_balance.cjs — Writes the real on-chain wallet balance into the database.
 * Called by live-runner.js supervisor every 60 seconds.
 *
 * Usage: node sync_balance.cjs <balance_sol>
 *   <balance_sol> — the real on-chain SOL balance (e.g. "0.0029")
 *
 * This ensures that the trading engine and UI always see the real wallet
 * balance regardless of what paper accounting says. Every buy reduces SOL
 * and every sell increases it — this sync captures ALL trade effects.
 */
const { Client } = require('pg');
const balanceSol = parseFloat(process.argv[2]);
if (isNaN(balanceSol) || balanceSol <= 0) {
  console.error(`Invalid balance: "${process.argv[2]}"`);
  process.exit(1);
}
const client = new Client({ connectionString: process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/crypto_db' });
client.connect()
  .then(() => client.query(
    "UPDATE bot_status SET wallet_balance = $1, last_update = NOW() WHERE id = 1",
    [balanceSol.toFixed(4)]
  ))
  .then(() => { console.log(`BALANCE SYNCED: ${balanceSol.toFixed(4)} SOL`); process.exit(0); })
  .catch(e => { console.error(e.message); process.exit(1); });
