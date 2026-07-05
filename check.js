import db from 'better-sqlite3';
const database = db('db.sqlite');
console.log(database.prepare("SELECT tokenSymbol, pnlPct, closeReason FROM trades WHERE status='CLOSED' ORDER BY closedAt DESC LIMIT 10").all());
