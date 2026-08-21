import { db } from "./server/storage.js";
import { trades } from "./shared/schema.js";
import { desc } from "drizzle-orm";

async function run() {
  try {
    const recentTrades = await db.select().from(trades).orderBy(desc(trades.id)).limit(10);
    console.log(JSON.stringify(recentTrades, null, 2));
    process.exit(0);
  } catch (e) {
    console.error(e);
    process.exit(1);
  }
}
run();
