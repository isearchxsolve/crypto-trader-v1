import asyncio
import os
import logging
import json
import time
from datetime import datetime
from dotenv import load_dotenv
from strategy import HybridStrategy
from utils.data_fetcher import DataFetcher
from ml.predict import Predictor
from executor_paper import PaperExecutor
from executor_live import LiveExecutor

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
    handlers=[
        logging.FileHandler("solana_hybrid_sniper_ultra/logs/bot.log"),
        logging.StreamHandler(),
    ],
)
logger = logging.getLogger("SniperBot")

load_dotenv()


class SolanaSniperBot:
    def __init__(self):
        self.fetcher = DataFetcher()
        self.strategy = HybridStrategy()
        self.predictor = Predictor()
        self.paper_executor = PaperExecutor()
        self.live_executor = LiveExecutor()
        self.is_running = False
        self.trading_mode = os.getenv("MODE", "paper")
        self.scan_interval = float(os.getenv("SCAN_INTERVAL", "5"))
        self.stats = {"scanned": 0, "signals": 0, "errors": 0}

    def set_trading_mode(self, mode):
        if mode in ("paper", "live"):
            self.trading_mode = mode
            logger.info(f"Trading mode switched to: {mode.upper()}")

    async def start(self):
        logger.info(f"Starting Solana Hybrid Sniper Ultra [Trading: {self.trading_mode.upper()}]")
        logger.info(f"Model version: {self.predictor.version}")
        logger.info(f"Scan interval: {self.scan_interval}s")
        self.is_running = True

        try:
            while self.is_running:
                try:
                    tokens = await self.fetcher.get_new_listings()
                    self.stats["scanned"] += len(tokens)

                    for token in tokens:
                        address = token.get("address")
                        if not address:
                            continue

                        features = self.fetcher.process_features(token, {
                            "bids": token.get("buys_1h", 0),
                            "asks": token.get("sells_1h", 0),
                            "volume_24h": token.get("volume_24h", 0),
                            "liquidity_usd": token.get("liquidity", 0),
                        })

                        predictions = self.predictor.predict(features)
                        signal = self.strategy.analyze(features, predictions)

                        if signal and signal["action"] == "BUY":
                            mode = self.strategy.current_mode
                            prob = predictions["pump_probability"]
                            self.stats["signals"] += 1

                            logger.info(
                                f"SIGNAL #{self.stats['signals']}: "
                                f"${token['symbol']} | "
                                f"Strategy: {mode} | "
                                f"Prob: {prob:.2f} | "
                                f"Liq: ${token.get('liquidity', 0):,.0f} | "
                                f"Age: {token.get('age_seconds', 0):.0f}s | "
                                f"Trading: {self.trading_mode.upper()}"
                            )

                            if self.trading_mode == "live":
                                await self.live_executor.execute_buy(token, mode, signal)
                            else:
                                await self.paper_executor.execute_trade(token, mode, signal)

                    if self.stats["scanned"] % 50 == 0 and self.stats["scanned"] > 0:
                        logger.info(
                            f"Stats: Scanned={self.stats['scanned']} | "
                            f"Signals={self.stats['signals']} | "
                            f"Errors={self.stats['errors']} | "
                            f"Mode={self.strategy.current_mode}"
                        )

                    await asyncio.sleep(self.scan_interval)

                except Exception as e:
                    self.stats["errors"] += 1
                    logger.error(f"Error in main loop: {str(e)}")
                    await asyncio.sleep(10)
        finally:
            await self.fetcher.close()
            logger.info("Bot shutdown complete.")

    def stop(self):
        self.is_running = False
        logger.info("Stopping bot...")


if __name__ == "__main__":
    bot = SolanaSniperBot()
    try:
        asyncio.run(bot.start())
    except KeyboardInterrupt:
        bot.stop()
