import asyncio
import os
import logging
import json
import random
from datetime import datetime
from dotenv import load_dotenv
from strategy import HybridStrategy
from utils.data_fetcher import DataFetcher
from ml.predict import Predictor
from executor_paper import PaperExecutor

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
LOG_PATH = os.path.join(SCRIPT_DIR, "logs", "bot.log")
os.makedirs(os.path.dirname(LOG_PATH), exist_ok=True)
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
    handlers=[
        logging.FileHandler(LOG_PATH),
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
        paper_db_path = os.path.join(SCRIPT_DIR, "data", "paper_trades.json")
        self.paper_executor = PaperExecutor(db_path=paper_db_path)
        self.live_executor = None
        self.is_running = False
        self.trading_mode = os.getenv("MODE", "paper")
        self.scan_interval = float(os.getenv("SCAN_INTERVAL", "0"))
        self.stats = {"scanned": 0, "signals": 0, "errors": 0}
        self.simulation_mode = True
        self.max_trades_target = int(os.getenv("MAX_TRADES_TARGET", "100"))

    def set_trading_mode(self, mode):
        if mode in ("paper", "live"):
            self.trading_mode = mode
            logger.info(f"Trading mode switched to: {mode.upper()}")

    async def _simulated_market(self):
        """Yield synthetic token listings with embedded signal for strategy edge."""
        base_names = ["MEME", "DOGE", "PEPE", "SHIB", "FROG", "CAT", "BONK", "WIF", "POP"]
        while self.is_running:
            name = random.choice(base_names) + str(random.randint(100, 9999))
            price = round(random.uniform(0.000001, 0.01), 8)
            liquidity = random.uniform(2000, 400000)
            volume_24h = liquidity * random.uniform(0.5, 6)
            age_seconds = random.uniform(5, 300)

            # Latent pump_score determines token quality (hidden from strategy)
            # ~40% good tokens (will pump), ~60% bad tokens (will dump)
            pump_score = random.random()
            is_good = pump_score > 0.55

            # Generate features that CORRELATE with pump_score
            # Good tokens: high buy pressure, high volume momentum, high buy/sell ratio
            # Bad tokens: low buys, high sells, low momentum
            if is_good:
                buys_5m = random.randint(40, 200)
                sells_5m = random.randint(1, int(buys_5m * 0.4))
                buy_pressure_5m = buys_5m / (buys_5m + sells_5m + 1)
                # High vol momentum
                vol_momentum = random.uniform(1.5, 5.0)
                price_change_5m = random.uniform(3, 40)
                bsr = random.uniform(1.5, 4.0)
            else:
                buys_5m = random.randint(5, 50)
                sells_5m = random.randint(int(buys_5m * 0.6), int(buys_5m * 1.8))
                buy_pressure_5m = buys_5m / (buys_5m + sells_5m + 1)
                vol_momentum = random.uniform(0.2, 1.2)
                price_change_5m = random.uniform(-15, 5)
                bsr = random.uniform(0.3, 1.2)

            buys_1h = buys_5m * random.randint(8, 15)
            sells_1h = sells_5m * random.randint(8, 15)
            volume_5m = volume_24h * random.uniform(0.05, 0.2)
            volume_1h = volume_5m * random.uniform(8, 15)
            price_change_1h = random.uniform(-20, 100)
            fdv = liquidity * random.uniform(5, 50)

            token_data = {
                "address": name,
                "symbol": name,
                "liquidity": liquidity,
                "volume_5m": volume_5m,
                "volume_1h": volume_1h,
                "volume_24h": volume_24h,
                "price_change_5m": price_change_5m,
                "price_change_1h": price_change_1h,
                "price_change_24h": random.uniform(-30, 200),
                "buys_5m": buys_5m,
                "sells_5m": sells_5m,
                "buys_1h": buys_1h,
                "sells_1h": sells_1h,
                "buys_24h": buys_1h * random.randint(10, 24),
                "sells_24h": sells_1h * random.randint(10, 24),
                "fdv": fdv,
                "market_cap": fdv * random.uniform(0.1, 0.5),
                "age_seconds": age_seconds,
            }

            market_data = {
                "bids": buys_1h,
                "asks": sells_1h,
                "volume_24h": volume_24h,
                "liquidity_usd": liquidity,
            }

            features = self.fetcher.process_features(token_data, market_data)
            features["price"] = price
            features["_pump_score"] = pump_score  # hidden ground truth for step()
            self.stats["scanned"] += 1
            yield {
                "address": name,
                "symbol": name,
                "liquidity": liquidity,
                "volume_24h": volume_24h,
                "price": price,
                "age_seconds": age_seconds,
                "features": features,
                "_pump_score": pump_score,  # hidden for executor
            }

    async def start(self):
        logger.info(f"Starting Solana Hybrid Sniper Ultra [Trading: {self.trading_mode.upper()}]")
        logger.info(f"Model version: {self.predictor.version}")
        logger.info(f"Mode: PAPER+MOONBAG SIMULATION, target trades={self.max_trades_target}")
        self.is_running = True
        try:
            if self.simulation_mode:
                await self._run_simulation()
            else:
                await self._run_live()
        finally:
            if self.trading_mode == "paper":
                pass
            else:
                if self.live_executor:
                    await self.live_executor.close()
            await self.fetcher.close()
            logger.info("Bot shutdown complete.")

    async def _run_simulation(self):
        while self.is_running:
            async for token in self._simulated_market():
                features = token["features"]
                predictions = self.predictor.predict(features)
                signal = self.strategy.analyze(features, predictions)
                if signal and signal["action"] == "BUY":
                    self.stats["signals"] += 1
                    mode = self.strategy.current_mode
                    prob = predictions.get("pump_probability", 0.0)
                    logger.info(
                        f"SIGNAL #{self.stats['signals']}: "
                        f"${token['symbol']} | Strategy: {mode} | Prob: {prob:.2f} | "
                        f"Liq: ${token.get('liquidity', 0):,.0f} | Age: {token.get('age_seconds', 0):.0f}s"
                    )
                    await self.paper_executor.execute_trade(token, mode, signal)
                closed = self.paper_executor.step()
                if closed:
                    for t in closed:
                        logger.info(
                            f"CLOSE #{t.get('id')}: {t.get('symbol')} reason={t.get('close_reason')} "
                            f"pnl={t.get('pnl_pct', 0):.2%}"
                        )
                stats = self.paper_executor.summary()
                if stats["closed"] > 0 and stats["closed"] % 25 == 0:
                    logger.info(f"SimStats: {stats}")
                if stats["closed"] >= self.max_trades_target:
                    logger.info(f"Target reached: {stats['closed']} trades. Stopping simulation.")
                    logger.info(f"Final summary: {stats}")
                    self.is_running = False
                    break

    async def _run_live(self):
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
                        prob = predictions.get("pump_probability", 0.0)
                        self.stats["signals"] += 1
                        logger.info(
                            f"SIGNAL #{self.stats['signals']}: "
                            f"${token['symbol']} | Strategy: {mode} | Prob: {prob:.2f} | "
                            f"Liq: ${token.get('liquidity', 0):,.0f} | Age: {token.get('age_seconds', 0):.0f}s"
                        )
                        if self.trading_mode == "live":
                            await self.live_executor.execute_buy(token, mode, signal)
                        else:
                            await self.paper_executor.execute_trade(token, mode, signal)
                if self.stats["scanned"] % 50 == 0 and self.stats["scanned"] > 0:
                    logger.info(
                        f"Stats: Scanned={self.stats['scanned']} | "
                        f"Signals={self.stats['signals']} | "
                        f"Errors={self.stats['errors']} | Mode={self.strategy.current_mode}"
                    )
                await asyncio.sleep(self.scan_interval)
            except Exception as e:
                self.stats["errors"] += 1
                logger.error(f"Error in main loop: {str(e)}")
                await asyncio.sleep(10)

    def stop(self):
        self.is_running = False
        logger.info("Stopping bot...")


if __name__ == "__main__":
    bot = SolanaSniperBot()
    try:
        asyncio.run(bot.start())
    except KeyboardInterrupt:
        bot.stop()
