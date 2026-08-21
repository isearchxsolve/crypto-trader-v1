import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "@shared/schema";
import { eq, desc } from "drizzle-orm";

const { Pool } = pg;

const { botStatus, trades, candidates } = schema;

export interface IStorage {
  getBotStatus(): Promise<any>;
  getTrades(): Promise<any[]>;
  getOpenTrades(): Promise<any[]>;
  getCandidates(): Promise<any[]>;
  addTrade(trade: any): Promise<any>;
  closeTrade(id: number, exitPrice: string, pnl: string, exitReason?: string): Promise<void>;
  updateTradeCurrentPrice(id: number, currentPrice: string, pnl: string): Promise<void>;
  updateTradePeakPrice(id: number, peakPrice: string, peakPnl: string): Promise<void>;
  updateTradeAmount(id: number, amount: string): Promise<void>;
  updateTradingMode(mode: string): Promise<any>;
  updateBotRunning(isRunning: boolean): Promise<any>;
  updateStrategyMode(mode: string): Promise<any>;
  updateBotStats(stats: { walletBalance?: string; totalPnl?: string; winRate?: string; totalTrades?: number; openPositions?: number; lastSignal?: string; peakBalance?: string; dailyStartBalance?: string; lastLossCooldownEnd?: number }): Promise<void>;
  seedInitialData(): Promise<void>;
}

/** In-memory storage for when PostgreSQL is not available */
export class MemStorage implements IStorage {
  private botStatusData: any = {
    id: 1, mode: "AUTO", tradingMode: "paper", isRunning: true,
    walletBalance: "10.00", totalPnl: "0", winRate: "0",
    totalTrades: 0, openPositions: 0, lastSignal: null, lastUpdate: new Date(),
  };
  private tradesData: any[] = [];
  private candidatesData: any[] = [];
  private tradeSeq = 0;
  private candidateSeq = 0;

  async getBotStatus(): Promise<any> {
    return { ...this.botStatusData };
  }

  async getTrades(): Promise<any[]> {
    return [...this.tradesData].sort((a, b) => 
      new Date(b.timestamp || 0).getTime() - new Date(a.timestamp || 0).getTime()
    ).slice(0, 1000);
  }

  async getOpenTrades(): Promise<any[]> {
    return this.tradesData
      .filter(t => t.status === "OPEN")
      .sort((a, b) => new Date(b.timestamp || 0).getTime() - new Date(a.timestamp || 0).getTime());
  }

  async getCandidates(): Promise<any[]> {
    return [...this.candidatesData]
      .sort((a, b) => new Date(b.timestamp || 0).getTime() - new Date(a.timestamp || 0).getTime())
      .slice(0, 50);
  }

  async addTrade(trade: any): Promise<any> {
    const t = { ...trade, id: ++this.tradeSeq, timestamp: new Date() };
    this.tradesData.push(t);
    return t;
  }

  async closeTrade(id: number, exitPrice: string, pnl: string, exitReason?: string): Promise<void> {
    const t = this.tradesData.find(t => t.id === id);
    if (t) {
      t.status = "CLOSED";
      t.type = "SELL";
      t.exitPrice = exitPrice;
      t.pnl = pnl;
      t.exitReason = exitReason || "MANUAL";
      t.closedAt = new Date();
    }
  }

  async updateTradeCurrentPrice(id: number, currentPrice: string, pnl: string): Promise<void> {
    const t = this.tradesData.find(t => t.id === id);
    if (t) { t.currentPrice = currentPrice; t.pnl = pnl; }
  }

  async updateTradePeakPrice(id: number, peakPrice: string, peakPnl: string): Promise<void> {
    const t = this.tradesData.find(t => t.id === id);
    if (t) { t.peakPrice = peakPrice; t.peakPnl = peakPnl; }
  }

  async updateTradeAmount(id: number, amount: string): Promise<void> {
    const t = this.tradesData.find(t => t.id === id);
    if (t) { t.amount = amount; }
  }

  async updateTradingMode(mode: string): Promise<any> {
    this.botStatusData.tradingMode = mode;
    this.botStatusData.lastUpdate = new Date();
    return this.getBotStatus();
  }

  async updateBotRunning(isRunning: boolean): Promise<any> {
    this.botStatusData.isRunning = isRunning;
    this.botStatusData.lastUpdate = new Date();
    return this.getBotStatus();
  }

  async updateStrategyMode(mode: string): Promise<any> {
    this.botStatusData.mode = mode;
    this.botStatusData.lastUpdate = new Date();
    return this.getBotStatus();
  }

  async updateBotStats(stats: any): Promise<void> {
    Object.assign(this.botStatusData, stats);
    this.botStatusData.lastUpdate = new Date();
  }

  async seedInitialData(): Promise<void> {
    // Already initialized in constructor
  }

  // Boardcast mock for compatibility
  onTradeUpdate() {}
}

// Try PostgreSQL, fall back to MemStorage if unavailable

async function initStorage(): Promise<IStorage> {
  if (!process.env.DATABASE_URL) {
    console.log("[STORAGE] DATABASE_URL not set, using in-memory storage");
    return new MemStorage();
  }

  try {
    const pool = new Pool({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 5000, query_timeout: 10000, statement_timeout: 10000 });
    // Test connection
    const client = await pool.connect();
    client.release();

    const db = drizzle(pool, { schema });

    class DatabaseStorage implements IStorage {
      async getBotStatus(): Promise<any> {
        const status = await db.select().from(botStatus).limit(1);
        if (!status[0]) {
          return { mode: "STOPPED", tradingMode: "paper", isRunning: false, walletBalance: "0", totalPnl: "0", winRate: "0", totalTrades: 0, openPositions: 0, lastSignal: null };
        }
        const row = status[0];
        return {
          id: row.id,
          mode: row.mode,
          tradingMode: row.tradingMode || (row as any).trading_mode,
          isRunning: row.isRunning !== undefined ? row.isRunning : (row as any).is_running,
          walletBalance: row.walletBalance || (row as any).wallet_balance,
          totalPnl: row.totalPnl || (row as any).total_pnl,
          winRate: row.winRate || (row as any).win_rate,
          totalTrades: row.totalTrades || (row as any).total_trades,
          openPositions: row.openPositions || (row as any).open_positions,
          lastSignal: row.lastSignal || (row as any).last_signal,
          lastUpdate: row.lastUpdate || (row as any).last_update
        };
      }

      private mapTradeTimezones(trade: any) {
        if (!trade || !trade.timestamp) return trade;
        let dateStr = trade.timestamp instanceof Date 
            ? trade.timestamp.toISOString() 
            : String(trade.timestamp);
        if (!dateStr.endsWith('Z') && !dateStr.includes('+') && !dateStr.includes('-')) {
            dateStr = `${dateStr}Z`;
        }
        return { ...trade, timestamp: new Date(dateStr) };
      }

      async getTrades(): Promise<any[]> {
        const allTrades = await db.select().from(trades).orderBy(desc(trades.timestamp)).limit(1000);
        return allTrades.map(this.mapTradeTimezones);
      }

      async getOpenTrades(): Promise<any[]> {
        const openTrades = await db.select().from(trades).where(eq(trades.status, "OPEN")).orderBy(desc(trades.timestamp));
        return openTrades.map(this.mapTradeTimezones);
      }

      async getCandidates(): Promise<any[]> {
        return await db.select().from(candidates).orderBy(desc(candidates.timestamp)).limit(50);
      }

      async addTrade(trade: any): Promise<any> {
        const [inserted] = await db.insert(trades).values({
          ...trade,
          timestamp: new Date(),
        }).returning();
        return inserted;
      }

      async closeTrade(id: number, exitPrice: string, pnl: string, exitReason?: string): Promise<void> {
        await db.update(trades).set({
          status: "CLOSED",
          type: "SELL",
          exitPrice,
          pnl,
          exitReason: exitReason || "MANUAL",
          closedAt: new Date(),
        }).where(eq(trades.id, id));
      }

      async updateTradeCurrentPrice(id: number, currentPrice: string, pnl: string): Promise<void> {
        await db.update(trades).set({ currentPrice, pnl }).where(eq(trades.id, id));
      }

      async updateTradePeakPrice(id: number, peakPrice: string, peakPnl: string): Promise<void> {
        await db.update(trades).set({ peakPrice, peakPnl }).where(eq(trades.id, id));
      }

      async updateTradeAmount(id: number, amount: string): Promise<void> {
        await db.update(trades).set({ amount }).where(eq(trades.id, id));
      }

      async updateTradingMode(mode: string): Promise<any> {
        const existing = await db.select().from(botStatus).limit(1);
        if (existing.length > 0) {
          await db.update(botStatus).set({ tradingMode: mode, lastUpdate: new Date() }).where(eq(botStatus.id, existing[0].id));
        }
        return this.getBotStatus();
      }

      async updateBotRunning(isRunning: boolean): Promise<any> {
        const existing = await db.select().from(botStatus).limit(1);
        if (existing.length > 0) {
          await db.update(botStatus).set({ isRunning, lastUpdate: new Date() }).where(eq(botStatus.id, existing[0].id));
        }
        return this.getBotStatus();
      }

      async updateStrategyMode(mode: string): Promise<any> {
        const existing = await db.select().from(botStatus).limit(1);
        if (existing.length > 0) {
          await db.update(botStatus).set({ mode, lastUpdate: new Date() }).where(eq(botStatus.id, existing[0].id));
        }
        return this.getBotStatus();
      }

      async updateBotStats(stats: any): Promise<void> {
        const existing = await db.select().from(botStatus).limit(1);
        if (existing.length > 0) {
          await db.update(botStatus).set({ ...stats, lastUpdate: new Date() }).where(eq(botStatus.id, existing[0].id));
        }
      }

      async seedInitialData(): Promise<void> {
        const existingStatus = await db.select().from(botStatus).limit(1);
        if (existingStatus.length === 0) {
          await db.insert(botStatus).values({
            mode: "AUTO",
            tradingMode: "paper",
            isRunning: true,
            walletBalance: "10.00",
            totalPnl: "0",
            winRate: "0",
            totalTrades: 0,
            openPositions: 0,
          });
        }
      }
    }

    return new DatabaseStorage();
  } catch (err: any) {
    console.log(`[STORAGE] PostgreSQL unavailable (${err.message}), using in-memory storage`);
    return new MemStorage();
  }
}

let storageInitPromise: Promise<IStorage> | null = null;
let storageInstance: IStorage | null = null;

function getStorageInstance(): IStorage {
  if (!storageInstance) {
    throw new Error("Storage not initialized. Call initStorageWrapper() first.");
  }
  return storageInstance;
}

export async function initStorageWrapper(): Promise<IStorage> {
  if (!storageInitPromise) {
    storageInitPromise = initStorage().then(s => {
      storageInstance = s;
      return s;
    });
  }
  return storageInitPromise;
}

const handler: ProxyHandler<IStorage> = {
  get(_target, prop: string | symbol) {
    const instance = getStorageInstance();
    const value = (instance as any)[prop];
    if (typeof value === "function") {
      return (...args: any[]) => value.apply(instance, args);
    }
    return value;
  }
};

export const storage: IStorage = new Proxy({} as IStorage, handler);
export const pool = null;
export const db = null;
