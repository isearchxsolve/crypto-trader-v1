// ecosystem.config.cjs — PM2 headless configuration for Crypto Trader
//
// ARCHITECTURE NOTE:
//   crypto-engine: PM2 manages live-runner.js directly.
//     live-runner.js is itself a supervisor that spawns server/index.ts as a
//     child process and auto-restarts it on crash. PM2 watches live-runner.js
//     itself, so if the supervisor dies, PM2 restarts it.
//
//   crypto-ml: PM2 manages the Python FastAPI ML microservice directly.
//
// USAGE:
//   pm2 start ecosystem.config.cjs    → start everything
//   pm2 status                        → process dashboard
//   pm2 logs                          → tail all logs
//   pm2 logs crypto-engine            → tail engine logs only
//   pm2 restart all                   → rolling restart
//   pm2 stop all                      → pause (keeps registered)
//   pm2 delete all                    → remove from PM2
//   pm2 save                          → persist list across reboots
//   pm2 startup                       → generate boot script (run as Admin)

const path = require('path');
const ROOT = __dirname;

// Load .env so DATABASE_URL etc. are inherited by child processes
require('dotenv').config({ path: path.join(ROOT, '.env') });

module.exports = {
  apps: [
    // ── 1. Engine Supervisor (live-runner.js → server/index.ts) ──────────
    {
      name: 'crypto-engine',
      script: path.join(ROOT, 'live-runner.js'),
      cwd: ROOT,
      interpreter: 'node',

      env: {
        ...process.env,
        NODE_ENV: 'production',
        PORT: '5000',
        SKIP_VITE: 'true',
      },

      // Restart policy — live-runner handles internal crashes itself;
      // PM2 only restarts if the supervisor itself dies.
      autorestart: true,
      watch: false,
      max_restarts: 5,
      min_uptime: '30s',
      restart_delay: 5000,

      // Logging
      out_file: path.join(ROOT, 'logs', 'pm2-engine-out.log'),
      error_file: path.join(ROOT, 'logs', 'pm2-engine-err.log'),
      merge_logs: true,
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',

      instances: 1,
      exec_mode: 'fork',
    },

    // ── 2. Python ML Microservice ─────────────────────────────────────────
    {
      name: 'crypto-ml',
      script: path.join(ROOT, 'solana_hybrid_sniper_ultra', 'ml_server.py'),
      cwd: path.join(ROOT, 'solana_hybrid_sniper_ultra'),
      interpreter: 'python',

      env: {
        ML_PORT: '5001',
      },

      // Restart policy
      autorestart: true,
      watch: false,
      max_restarts: 10,
      min_uptime: '15s',
      restart_delay: 5000,

      // Logging
      out_file: path.join(ROOT, 'logs', 'pm2-ml-out.log'),
      error_file: path.join(ROOT, 'logs', 'pm2-ml-err.log'),
      merge_logs: true,
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',

      instances: 1,
      exec_mode: 'fork',
    },

    // "?"? 3. Wallet Reconciliation Watchdog "?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?
    {
      name: 'crypto-watchdog',
      script: path.join(ROOT, 'wallet_watchdog.cjs'),
      cwd: ROOT,
      interpreter: 'node',

      env: {
        DATABASE_URL:       process.env.DATABASE_URL,
        SOLANA_RPC_URL:     process.env.SOLANA_RPC_URL,
        WALLET_PRIVATE_KEY: process.env.WALLET_PRIVATE_KEY,
      },

      autorestart: true,
      watch: false,
      max_restarts: 10,
      min_uptime: '15s',
      restart_delay: 5000,

      out_file: path.join(ROOT, 'logs', 'pm2-watchdog-out.log'),
      error_file: path.join(ROOT, 'logs', 'pm2-watchdog-err.log'),
      merge_logs: true,
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',

      instances: 1,
      exec_mode: 'fork',
    },
  ],
};,


  // Fast Scanner - candidate discovery feed (Phase 4: PM2-managed resilience)
  {
    name: "fast-scanner",
    script: "fast_scanner.cjs",
    interpreter: "node",
    max_restarts: 10,
    min_uptime: 5000,
    restart_delay: 3000,
    error_file: "logs/fast-scanner-error.log",
    out_file: "logs/fast-scanner-out.log",
    merge_logs: true,
  },
];