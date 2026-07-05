// ecosystem.config.js
module.exports = {
  apps: [
    {
      name: "trading-engine",
      script: "dist/index.cjs",
      autorestart: true,
      max_restarts: 10,
      restart_delay: 5000,
      env: { NODE_ENV: "production" },
    },
    {
      name: "trading-failsafe",
      script: "failsafe.cjs",
      autorestart: true,      // watchdog must always be up
      restart_delay: 3000,
      // IMPORTANT: failsafe stops ONLY "trading-engine" by name, never itself
      env: { ENGINE_PM2_NAME: "trading-engine" },
    },
  ],
};
