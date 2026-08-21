const { Client } = require('pg');
require('dotenv').config();

const client = new Client({
  connectionString: process.env.DATABASE_URL
});

async function monitor() {
  await client.connect();
  const maxRes = await client.query(`SELECT MAX(id) as max_id FROM trades`);
  const startId = parseInt(maxRes.rows[0].max_id) || 0;
  console.log(`Connected to DB. Starting monitor from Trade ID > ${startId}...`);
  
  while (true) {
    try {
      const res = await client.query(`
        SELECT 
          COUNT(*) as total_new,
          SUM(CASE WHEN status = 'CLOSED' THEN 1 ELSE 0 END) as closed_new,
          SUM(CASE WHEN status = 'CLOSED' AND pnl::numeric > 0 THEN 1 ELSE 0 END) as wins_new
        FROM trades 
        WHERE id > $1
      `, [startId]);
      
      const row = res.rows[0];
      const total = parseInt(row.total_new) || 0;
      const closed = parseInt(row.closed_new) || 0;
      const wins = parseInt(row.wins_new) || 0;
      
      console.log(`New trades completed: ${closed}/100 | Wins: ${wins} | Open: ${total - closed}`);
      
      if (closed >= 100) {
        console.log("Successfully completed 100 new trades!");
        process.exit(0);
      }
    } catch (e) {
      console.error(e);
    }
    await new Promise(r => setTimeout(r, 10000));
  }
}

monitor();
