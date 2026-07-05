const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const { Connection, PublicKey, Keypair } = require('@solana/web3.js');
const { getAssociatedTokenAddress, getAccount, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } = require('@solana/spl-token');
const bs58 = require('bs58');
require('dotenv').config();

const HALT_FILE = path.join(__dirname, '.HALT');

// 1. Setup DB
const pool = new Pool({ 
  connectionString: process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/crypto_db' 
});

// 2. Setup Solana Connection
const rpcUrl = process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';
const connection = new Connection(rpcUrl, 'confirmed');

const privateKeyBase58 = process.env.WALLET_PRIVATE_KEY;
if (!privateKeyBase58) {
  console.error('[WATCHDOG] WALLET_PRIVATE_KEY is missing. Watchdog disabled.');
  process.exit(1);
}
let keypair;
try {
  keypair = Keypair.fromSecretKey(bs58.default ? bs58.default.decode(privateKeyBase58) : bs58.decode(privateKeyBase58));
} catch (e) {
  keypair = Keypair.fromSecretKey(bs58.decode(privateKeyBase58));
}

function panic(reason) {
  console.error(`\n[WATCHDOG PANIC] ${reason}`);
  console.error(`[WATCHDOG] Halting engine immediately!`);
  fs.writeFileSync(HALT_FILE, `WATCHDOG HALT: ${reason}\nTS: ${Date.now()}`);
  process.exit(1);
}

async function getTokenBalance(mintStr) {
  const mintPubkey = new PublicKey(mintStr);
  
  // Check Standard
  const ataStandard = await getAssociatedTokenAddress(mintPubkey, keypair.publicKey, false, TOKEN_PROGRAM_ID);
  try {
    const acc = await getAccount(connection, ataStandard, 'confirmed', TOKEN_PROGRAM_ID);
    return acc.amount;
  } catch (err) {
    if (err.name !== "TokenAccountNotFoundError" && !err.message.includes("could not find")) throw err;
  }

  // Check 2022
  const ata2022 = await getAssociatedTokenAddress(mintPubkey, keypair.publicKey, false, TOKEN_2022_PROGRAM_ID);
  try {
    const acc2022 = await getAccount(connection, ata2022, 'confirmed', TOKEN_2022_PROGRAM_ID);
    return acc2022.amount;
  } catch (err) {
    if (err.name !== "TokenAccountNotFoundError" && !err.message.includes("could not find")) throw err;
  }

  return BigInt(0);
}

async function runReconciliation() {
  console.log(`[WATCHDOG] Running reconciliation cycle...`);
  
  if (fs.existsSync(HALT_FILE)) {
    console.log(`[WATCHDOG] Engine is currently HALTED. Waiting...`);
    return;
  }

  try {
    // 1. Fetch OPEN live trades
    const res = await pool.query("SELECT * FROM trades WHERE status = 'OPEN' AND trading_mode = 'live'");
    const openTrades = res.rows;
    
    if (openTrades.length === 0) {
      console.log(`[WATCHDOG] No open live trades to reconcile.`);
      return;
    }

    // 2. Check each trade's on-chain balance
    for (const trade of openTrades) {
      // Allow a 60-second grace period for newly opened trades to settle on-chain
      const ageMs = Date.now() - new Date(trade.timestamp).getTime();
      if (ageMs < 60_000) {
        console.log(`[WATCHDOG] Skipping ${trade.token_symbol} (Too new: ${Math.round(ageMs/1000)}s)`);
        continue;
      }

      console.log(`[WATCHDOG] Checking ${trade.token_symbol} (${trade.token_address})...`);
      try {
        const balance = await getTokenBalance(trade.token_address);
        if (balance === BigInt(0)) {
          panic(`GHOST TRADE DETECTED: DB says we hold ${trade.token_symbol} but on-chain balance is 0! (Trade ID: ${trade.id})`);
        } else {
          console.log(`[WATCHDOG] ${trade.token_symbol} OK. (Balance: ${balance.toString()})`);
        }
      } catch (e) {
        console.error(`[WATCHDOG] RPC error checking ${trade.token_symbol}: ${e.message}`);
      }
    }
  } catch (e) {
    console.error(`[WATCHDOG] Database error: ${e.message}`);
  }
}

console.log(`[WATCHDOG] Started. Monitoring wallet: ${keypair.publicKey.toBase58()}`);
setInterval(runReconciliation, 30_000);
runReconciliation();
