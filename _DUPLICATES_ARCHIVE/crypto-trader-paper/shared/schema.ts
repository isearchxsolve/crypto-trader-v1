import { pgTable, text, serial, integer, boolean, timestamp, numeric } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

export const botStatus = pgTable("bot_status", {
  id: serial("id").primaryKey(),
  mode: text("mode").notNull(),
  tradingMode: text("trading_mode").default("paper").notNull(),
  isRunning: boolean("is_running").default(false),
  walletBalance: numeric("wallet_balance").default("0"),
  totalPnl: numeric("total_pnl").default("0"),
  winRate: numeric("win_rate").default("0"),
  totalTrades: integer("total_trades").default(0),
  openPositions: integer("open_positions").default(0),
  lastSignal: text("last_signal"),
  lastUpdate: timestamp("last_update").defaultNow(),
});

export const trades = pgTable("trades", {
  id: serial("id").primaryKey(),
  tokenAddress: text("token_address").notNull(),
  tokenSymbol: text("token_symbol").notNull(),
  type: text("type").notNull(),
  mode: text("mode").notNull(),
  tradingMode: text("trading_mode").default("paper").notNull(),
  status: text("status").default("OPEN").notNull(),
  amount: numeric("amount").notNull(),
  price: numeric("price").notNull(),
  currentPrice: numeric("current_price"),
  peakPrice: numeric("peak_price"),
  pnl: numeric("pnl"),
  peakPnl: numeric("peak_pnl"),
  exitPrice: numeric("exit_price"),
  exitReason: text("exit_reason"),
  score: numeric("score"),
  txHash: text("tx_hash"),
  liquidity: numeric("liquidity"),
  timestamp: timestamp("timestamp").defaultNow(),
  closedAt: timestamp("closed_at"),
});

export const candidates = pgTable("candidates", {
  id: serial("id").primaryKey(),
  tokenAddress: text("token_address").notNull(),
  tokenSymbol: text("token_symbol").notNull(),
  liquidity: numeric("liquidity").notNull(),
  pumpProbability: numeric("pump_probability").notNull(),
  dumpRisk: numeric("dump_risk").default("0"),
  ageSeconds: integer("age_seconds").notNull(),
  qualifiedMode: text("qualified_mode"),
  timestamp: timestamp("timestamp").defaultNow(),
});

export const insertBotStatusSchema = createInsertSchema(botStatus);
export const insertTradeSchema = createInsertSchema(trades).omit({ id: true, timestamp: true, closedAt: true });
export const insertCandidateSchema = createInsertSchema(candidates).omit({ id: true, timestamp: true });

export type BotStatus = typeof botStatus.$inferSelect;
export type Trade = typeof trades.$inferSelect;
export type Candidate = typeof candidates.$inferSelect;
