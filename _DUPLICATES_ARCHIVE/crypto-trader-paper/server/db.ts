// DB module - storage.ts handles fallback; this file only used if PG is explicitly needed
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "@shared/schema";

const { Pool } = pg;

let dbInstance: any = null;
let poolInstance: any = null;

if (process.env.DATABASE_URL) {
  try {
    poolInstance = new Pool({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 3000 });
    dbInstance = drizzle(poolInstance, { schema });
  } catch (e) {
    console.warn("[DB] PostgreSQL not available, some features may be limited");
  }
}

export const pool = poolInstance;
export const db = dbInstance;
