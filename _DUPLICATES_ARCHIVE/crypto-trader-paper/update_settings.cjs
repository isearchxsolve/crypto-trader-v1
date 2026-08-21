const { db } = require("./dist/storage.cjs");

async function run() {
  const storage = require("./dist/storage.cjs").storage;
  const settings = await storage.getBotSettings();
  console.log("OLD SETTINGS:", settings.config);
  
  const config = JSON.parse(settings.config);
  config.scanIntervalMs = 5000;
  config.priceCheckIntervalMs = 500;
  config.maxHoldSeconds = 30;
  config.maxOpenPositions = 5;
  config.minScoreToTrade = 20;
  config.sniperMinScore = 20;
  config.mgMinScore = 20;
  
  await storage.updateBotSettings(config);
  const newSettings = await storage.getBotSettings();
  console.log("NEW SETTINGS:", newSettings.config);
}
run().catch(console.error);
