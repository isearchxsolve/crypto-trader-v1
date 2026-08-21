const { Client } = require('pg');
const { spawn } = require('child_process');
const net = require('net');
const fs = require('fs');

const DATABASE_URL = 'postgres://postgres:postgres@localhost:5432/crypto_db';
const env = {
  ...process.env,
  BIRDEYE_API_KEY: "05f10e59e3824f438c6446d195f49c56",
  SOLANA_RPC_URL: "https://mainnet.helius-rpc.com/?api-key=85a848b0-d314-4477-a123-1a294ac0908b",
  SOLANA_RPC_BACKUP_URL: "https://twilight-old-diamond.solana-mainnet.quiknode.pro/1653af2ba52ff5de6fdcf42ab06867d797df8399/",
  SOLANA_RPC_TERTIARY_URL: "https://api.mainnet-beta.solana.com",
  JITO_ENGINE_URL: "https://tokyo.mainnet.block-engine.jito.wtf/api/v1/transactions",
  JITO_TIP_LAMPORTS: "100000",
  WALLET_PRIVATE_KEY: "DHt9ipNNB5KmqDv87etG3kfvCU9dsVQcyo13t2U33RHDc7ik3Frex5FuoD5K4veqRJ58zVNaPQm3Kd5EcCcCDzx",
  PRIORITY_FEE_LAMPORTS: "100000",
  DATABASE_URL: DATABASE_URL
};

let botProcess = null;

function isPortOpen(port) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    const onError = () => {
      socket.destroy();
      resolve(false);
    };
    socket.setTimeout(1500);
    socket.once('error', onError);
    socket.once('timeout', onError);
    socket.connect(port, '127.0.0.1', () => {
      socket.end();
      resolve(true);
    });
  });
}

function startBot() {
  console.log('[MONITOR] Spawning trading engine...');
  const logStream = fs.createWriteStream('logs/app.log', { flags: 'a' });
  botProcess = spawn('npm', ['run', 'start'], { env, shell: true });
  
  botProcess.stdout.pipe(logStream);
  botProcess.stderr.pipe(logStream);
  
  botProcess.on('exit', (code) => {
    console.log(`[MONITOR] Bot exited with code ${code}`);
    botProcess = null;
  });
}

async function checkAndKeepAlive() {
  const open = await isPortOpen(5000);
  if (!open) {
    console.log('[MONITOR] Port 5000 is closed. Restarting bot...');
    startBot();
  }
}

async function getStats() {
  const client = new Client({ connectionString: DATABASE_URL });
  try {
    await client.connect();
    const allRes = await client.query('SELECT COUNT(*) as total FROM trades');
    const closedRes = await client.query("SELECT COUNT(*) as closed, COUNT(CASE WHEN CAST(pnl AS DECIMAL) > 0 THEN 1 END) as wins, AVG(CAST(pnl AS DECIMAL)) as avg_pnl FROM trades WHERE status = 'CLOSED'");
    const openRes = await client.query("SELECT COUNT(*) as open_count FROM trades WHERE status = 'OPEN'");
    
    const total = parseInt(allRes.rows[0].total);
    const closed = parseInt(closedRes.rows[0].closed);
    const wins = parseInt(closedRes.rows[0].wins);
    const avgPnl = parseFloat(closedRes.rows[0].avg_pnl || 0);
    const openCount = parseInt(openRes.rows[0].open_count);
    
    const winRate = closed > 0 ? (wins / closed * 100).toFixed(2) : '0.00';
    
    console.log(`[DASHBOARD] Time: ${new Date().toLocaleTimeString()} | Total Trades: ${total} | Closed: ${closed} | Open: ${openCount} | WinRate: ${winRate}% | AvgPnL: ${avgPnl.toFixed(2)}%`);
    
    return { total, closed, openCount, winRate, avgPnl, client };
  } catch (err) {
    console.error('[MONITOR] Database query error:', err.message);
    try { await client.end(); } catch {}
    return null;
  }
}

async function main() {
  console.log('[MONITOR] Starting trade loop monitor...');
  
  // Initial check
  await checkAndKeepAlive();
  
  const interval = setInterval(async () => {
    await checkAndKeepAlive();
    const stats = await getStats();
    if (stats) {
      const { closed, winRate, avgPnl, client } = stats;
      if (closed >= 100) {
        clearInterval(interval);
        console.log('\n==================================================');
        console.log('            FINAL METRICS (100+ TRADES)           ');
        console.log('==================================================');
        console.log(`Total Closed Trades: ${closed}`);
        console.log(`Win Rate:            ${winRate}%`);
        console.log(`Average PnL:         ${avgPnl.toFixed(2)}%`);
        
        // Detailed exit reasons
        try {
          const reasonsRes = await client.query("SELECT exit_reason, COUNT(*) as count, AVG(CAST(pnl AS DECIMAL)) as avg_pnl FROM trades WHERE status = 'CLOSED' GROUP BY exit_reason ORDER BY count DESC");
          console.log('\nBreakdown of Exit Reasons:');
          reasonsRes.rows.forEach(r => {
            console.log(`- ${r.exit_reason || 'Unknown'}: ${r.count} trades | Avg PnL: ${parseFloat(r.avg_pnl).toFixed(2)}%`);
          });
        } catch (e) {
          console.error('[MONITOR] Failed to query detailed reasons:', e.message);
        }
        
        // Total ROI Calculation
        try {
          const statusRes = await client.query('SELECT wallet_balance, total_pnl FROM bot_status LIMIT 1');
          if (statusRes.rows[0]) {
            console.log(`\nFinal Wallet Balance: ${statusRes.rows[0].wallet_balance} SOL`);
            console.log(`Total PnL Reported:   ${statusRes.rows[0].total_pnl} SOL`);
          }
        } catch (e) {}
        
        console.log('==================================================\n');
        
        await client.end();
        if (botProcess) {
          botProcess.kill('SIGINT');
        }
        process.exit(0);
      } else {
        await client.end();
      }
    }
  }, 10000);
}

main().catch(console.error);
