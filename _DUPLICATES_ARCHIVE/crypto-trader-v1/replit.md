# Solana Hybrid Sniper Ultra

## Overview
A Solana meme token trading bot combining SNIPER, MG (Mega Growth), and HWR (High Win Rate) strategies, with an XGBoost ML prediction engine and a cyberpunk-themed React web dashboard. Features Ultra Sniper Engine v4.0+ML with blended composite scoring (60% rule + 40% ML), trailing stop loss, momentum fade detection, institutional-grade risk management, and dynamic position sizing. Cross-platform compatible (Windows/Linux) via cross-env.

## Architecture

### Web Dashboard (Node.js / React)
- **Backend**: Express server on port 5000 serving API + Vite frontend
- **Frontend**: React with Shadcn UI, cyberpunk neon dark theme (green #26d962 primary)
- **Database**: PostgreSQL via Drizzle ORM
- **Trading Engine**: Ultra Sniper Engine v4.0+ML — background scanner + position manager
- **API Routes**:
  - `GET /api/bot/status` - Bot status (balance, PNL, win rate, open positions, last signal)
  - `GET /api/bot/trades` - All trades with live P&L for open positions
  - `GET /api/trades/open` - Currently open positions only
  - `GET /api/bot/candidates` - DB candidates
  - `GET /api/candidates/live` - Real-time DexScreener token scanning (6s cache)
  - `GET /api/engine/stats` - Detailed engine stats (W/L, avg win/loss, best/worst trade, SOL profit, streak, ML status, SOL/hour, uptime, daily PnL, drawdown, peak balance, circuit breaker)
  - `GET /api/engine/risk-status` - Circuit breaker status, daily loss remaining, drawdown, cooldown
  - `GET /api/settings` - Current engine configuration
  - `POST /api/settings` - Update engine parameters at runtime (with value clamping/validation)
  - `POST /api/bot/trading-mode` - Toggle paper/live trading
  - `POST /api/bot/toggle` - Start/stop bot
  - `POST /api/bot/strategy-mode` - Switch strategy (SNIPER/MG/HWR/AUTO)
  - `POST /api/bot/force-sell-all` - Close all open positions immediately
  - `POST /api/bot/reset-balance` - Reset paper balance to starting amount

### ML Service (Python FastAPI)
- **Port**: 5001 (separate workflow "ML Service")
- **Model**: XGBoost v4.0, 13 features, 25k samples across 12 realistic scenarios (real_pump, fake_pump_dump, organic_growth, dump, flat, rug_pull, whale_exit, borderline_up, borderline_down, dead_cat_bounce, low_liq_trap, high_vol_bleed)
- **Training**: Heavy regularization (max_depth=5, gamma=0.5, min_child_weight=8, reg_alpha=0.3, reg_lambda=2.0, subsample=0.75, early stopping at 40 rounds, stratified 5-fold CV). 98.9% accuracy, 0.65% train/test gap
- **Sanity Penalties**: Post-prediction checks that penalize raw probability for red flags:
  - Low liquidity (<$2000): -30%
  - Buy pressure divergence (5m high, 1h low): -25%
  - Dead cat bounce (5m up, 1h down): -20%
  - Extreme volume/liquidity ratio (>5x): -15%
  - Too new (<15s): -20%
  - Sell pressure (buy/sell ratio <0.7): -15%
  - Low liquidity/FDV ratio (<0.5%): -10%
- **Endpoints**: `GET /health`, `POST /predict`, `POST /predict/batch`
- **Integration**: Node.js engine calls ML at scan time; batch for DexScreener pairs, individual for profiles
- **Blending**: Combined score = 70% rule-based + 30% ML prediction (pump probability × 100)
- **ML Boost**: score≥90 & ML≥90 → +15, score≥50 & ML≥80 → +10, score≥45 & ML≥70 → +5; ML<25 → penalty -12
- **Fallback**: Gracefully falls back to pure rule-based if ML service unavailable
- **Health Check**: Every 30s, engine pings ML `/health` endpoint

### Ultra Sniper Engine v4.0+ML (server/routes.ts)
- **Scanner**: Every 5s, fetches tokens from DexScreener (8 search queries + token profiles + boosted tokens)
- **Composite Scoring**: 7-factor scoring system (0-100 scale):
  - Buy Pressure (0-20), Volume Momentum (0-20), Trend (0-15), TX Velocity (0-15), Liquidity (0-10), Freshness (0-10), Multi-Timeframe Alignment (0-10)
- **ML Enhancement**: XGBoost pump probability blended at 40% weight; skips tokens with <$800 liquidity
- **Strategies**: SNIPER (new <5min, score≥52), MG (score≥55, momentum), HWR (score≥62, high confidence)
- **Position Manager**: Every 3s, checks current prices for open trades
  - Trailing Stop: Activates at +5%, trails 2% from peak
  - Dynamic Take Profit: +80% default, +100% (score≥90), +80% (score≥80), +65% (score≥70)
  - Stop Loss: -5% (capped — paper trade losses never exceed this)
  - Partial Take Profit: Sell 50% at +20%, let rest ride (persisted to DB)
  - Momentum Fade Detection: Exits if buy pressure drops <35% and price falling >3%
  - Early Cut: Exits losing positions faster (>50% hold time, <-4% PNL)
  - Fast Cut: Exits at -6% after 120s
  - Max Hold Time: 360s (6 min) unless in profit ≥5%
  - Max Open Positions: 12
  - Max Trades/Cycle: 6
- **Dynamic Position Sizing**: Score-based (1.4x at 80+, 1.8x at 85+, 2.2x at 90+), streak-adjusted, hard cap 5.0 SOL
  - SNIPER: 2.5 SOL base | MG: 2.0 SOL base | HWR: 1.5 SOL base
- **Re-entry Control**: Time-based Map with 60s cooldown after trade close (not permanent block); periodic cleanup prevents memory leak
- **Institutional Risk Management**:
  - Daily Loss Limit: 20% of balance per day (pauses trading)
  - Max Drawdown Circuit Breaker: 45% from peak (stops bot)
  - Consecutive Loss Cooldown: 20s pause after 3 losses in a row
  - Peak Balance Tracking: Continuously tracks all-time high
  - Daily PnL Reset: Tracks daily profit/loss separately
- **Settings**: All engine parameters configurable at runtime via GET/POST /api/settings with value validation/clamping
- **Wallet Tracking**: Paper balance starts at 10 SOL, persists to DB, restores on restart

### Python Trading Bot (`solana_hybrid_sniper_ultra/`)
- **bot.py**: Standalone async bot with same logic (for CLI use)
- **strategy.py**: Hybrid strategy with rug-pull/liquidity filters
- **ml_server.py**: FastAPI ML microservice with robust input sanitization (Optional fields, safe_float, raw JSON parsing)
- **ml/train.py**: XGBoost model training (15000 samples, 13 features, regularized with early stopping + stratified CV)
- **ml/predict.py**: ML predictions with heuristic fallback
- **executor_paper.py / executor_live.py**: Paper/live execution

## Database Schema
- `bot_status`: mode, tradingMode, isRunning, walletBalance, totalPnl, winRate, totalTrades, openPositions, lastSignal
- `trades`: tokenAddress, tokenSymbol, type (BUY/SELL), mode, tradingMode, status (OPEN/CLOSED), amount, price, currentPrice, peakPrice, pnl, peakPnl, exitPrice, exitReason, score, txHash, closedAt
- `candidates`: tokenAddress, tokenSymbol, liquidity, pumpProbability, dumpRisk, ageSeconds, qualifiedMode

## Key Files
- `shared/schema.ts` - Database schema with peak/score/exitReason tracking
- `server/routes.ts` - Ultra Sniper Engine v4.0+ML + DexScreener integration + risk management + runtime settings + API routes
- `server/storage.ts` - Database CRUD with trade management, peak price tracking, and amount persistence
- `client/src/pages/dashboard.tsx` - Dashboard with 8-stat grid, risk status, circuit breaker banner, best/worst trades, 3 tabs (Live Scanner default), Force Sell All + Reset buttons
- `client/src/pages/settings.tsx` - Full settings page with all engine parameters: exit strategy, position sizing, scanner timing, ML weights, risk management, strategy thresholds (SNIPER/MG/HWR)
- `client/src/components/live-feed-table.tsx` - Trade table with score, peak PNL, exit reason columns
- `client/src/hooks/use-bot-data.ts` - React Query hooks including engine stats
- `solana_hybrid_sniper_ultra/ml_server.py` - FastAPI ML microservice with NaN/Infinity sanitization
- `solana_hybrid_sniper_ultra/ml/predict.py` - XGBoost predictor with heuristic fallback

## Running
- Web dashboard: `cross-env NODE_ENV=development tsx server/index.ts` (auto-started via "Start application" workflow)
- ML Service: `python3 solana_hybrid_sniper_ultra/ml_server.py` (auto-started via "ML Service" workflow)
- Python bot: `cd solana_hybrid_sniper_ultra && python3 bot.py`
- Train ML model: `python3 solana_hybrid_sniper_ultra/ml/train.py`

## Dependencies
- Node.js packages managed via package.json (includes cross-env for Windows compatibility)
- Python 3.11 with: pandas, xgboost, numpy, scikit-learn, aiohttp, fastapi, uvicorn, python-dotenv, base58, solders
