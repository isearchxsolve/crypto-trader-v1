const { Pool } = require('pg');

const pool = new Pool({
  connectionString: 'postgres://postgres:postgres@localhost:5432/crypto_db'
});

async function run() {
  try {
    const res = await pool.query(`
      SELECT 
        SPLIT_PART(exit_reason, ' ', 1) as reason_type,
        COUNT(*) as trade_count,
        AVG(CAST(pnl AS numeric)) as avg_pnl
      FROM trades 
      WHERE status = 'CLOSED' 
        AND timestamp > NOW() - INTERVAL '1 day'
      GROUP BY SPLIT_PART(exit_reason, ' ', 1)
      ORDER BY trade_count DESC;
    `);
    
    console.log("=== TRADES LAST 24 HOURS ===");
    let totalTrades = 0;
    let totalPnl = 0;
    res.rows.forEach(r => {
      console.log(`${r.reason_type.padEnd(20)} | Count: ${r.trade_count.toString().padEnd(5)} | Avg PNL: ${parseFloat(r.avg_pnl).toFixed(2)}%`);
      totalTrades += parseInt(r.trade_count);
      totalPnl += parseFloat(r.avg_pnl) * parseInt(r.trade_count);
    });
    console.log(`-----------------------------------`);
    console.log(`TOTAL TRADES: ${totalTrades} | NET AVG PNL: ${(totalPnl/totalTrades).toFixed(2)}%`);
    
  } catch (err) {
    console.error(err);
  } finally {
    await pool.end();
  }
}

run();
