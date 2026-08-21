import asyncio
import json
import os
import logging
from datetime import datetime
from utils.swap_executor import JupiterSwap

logger = logging.getLogger("LiveExecutor")

SOL_MINT = "So11111111111111111111111111111111111111112"
LAMPORTS_PER_SOL = 1_000_000_000

class LiveExecutor:
    def __init__(self):
        self.jupiter = JupiterSwap()
        self.private_key = os.getenv("PRIVATE_KEY", "")
        self.rpc_url = os.getenv("RPC_URL", "https://api.mainnet-beta.solana.com")
        self.max_position_sol = float(os.getenv("MAX_POSITION_SOL", "1.0"))
        self.default_slippage_bps = int(os.getenv("DEFAULT_SLIPPAGE_BPS", "500"))
        self.trade_log_path = "solana_hybrid_sniper_ultra/data/live_trades.json"

        if not os.path.exists("solana_hybrid_sniper_ultra/data"):
            os.makedirs("solana_hybrid_sniper_ultra/data")
        if not os.path.exists(self.trade_log_path):
            with open(self.trade_log_path, 'w') as f:
                json.dump([], f)

    async def execute_buy(self, token, mode, signal):
        address = token.get('address')
        symbol = token.get('symbol', 'UNKNOWN')
        size_sol = min(signal.get('size_sol', 0.1), self.max_position_sol)
        slippage_bps = int(signal.get('slippage', 5) * 100)
        amount_lamports = int(size_sol * LAMPORTS_PER_SOL)

        logger.info(f"LIVE BUY: {symbol} ({address}) | Size: {size_sol} SOL | Slippage: {slippage_bps}bps | Mode: {mode}")

        try:
            quote = await self.jupiter.get_quote(
                input_mint=SOL_MINT,
                output_mint=address,
                amount=amount_lamports,
                slippage=slippage_bps
            )

            if "error" in quote:
                logger.error(f"Jupiter quote error for {symbol}: {quote['error']}")
                return False

            out_amount = int(quote.get("outAmount", 0))
            price_impact = float(quote.get("priceImpactPct", 0))

            if price_impact > 10.0:
                logger.warning(f"Price impact too high for {symbol}: {price_impact}% — skipping")
                return False

            swap_result = await self.jupiter.execute_swap(quote, self.private_key)

            trade = {
                "timestamp": datetime.now().isoformat(),
                "symbol": symbol,
                "mint": address,
                "mode": mode,
                "trading_mode": "live",
                "action": "BUY",
                "size_sol": size_sol,
                "out_amount": out_amount,
                "price_impact": price_impact,
                "tx_hash": swap_result.get("txid", ""),
                "status": "CONFIRMED" if swap_result.get("success") else "FAILED"
            }

            self._log_trade(trade)
            logger.info(f"LIVE TRADE CONFIRMED: {symbol} | TX: {trade['tx_hash']}")
            return swap_result.get("success", False)

        except Exception as e:
            logger.error(f"Live execution failed for {symbol}: {str(e)}")
            self._log_trade({
                "timestamp": datetime.now().isoformat(),
                "symbol": symbol,
                "mint": address,
                "mode": mode,
                "trading_mode": "live",
                "action": "BUY",
                "size_sol": size_sol,
                "status": "ERROR",
                "error": str(e)
            })
            return False

    async def execute_sell(self, token, mode, amount):
        address = token.get('address')
        symbol = token.get('symbol', 'UNKNOWN')

        logger.info(f"LIVE SELL: {symbol} ({address}) | Amount: {amount} | Mode: {mode}")

        try:
            quote = await self.jupiter.get_quote(
                input_mint=address,
                output_mint=SOL_MINT,
                amount=amount,
                slippage=self.default_slippage_bps
            )

            if "error" in quote:
                logger.error(f"Jupiter quote error for sell {symbol}: {quote['error']}")
                return False

            swap_result = await self.jupiter.execute_swap(quote, self.private_key)

            trade = {
                "timestamp": datetime.now().isoformat(),
                "symbol": symbol,
                "mint": address,
                "mode": mode,
                "trading_mode": "live",
                "action": "SELL",
                "amount": amount,
                "sol_received": int(quote.get("outAmount", 0)) / LAMPORTS_PER_SOL,
                "tx_hash": swap_result.get("txid", ""),
                "status": "CONFIRMED" if swap_result.get("success") else "FAILED"
            }

            self._log_trade(trade)
            return swap_result.get("success", False)

        except Exception as e:
            logger.error(f"Live sell failed for {symbol}: {str(e)}")
            return False

    def _log_trade(self, trade):
        try:
            with open(self.trade_log_path, 'r+') as f:
                trades = json.load(f)
                trades.append(trade)
                f.seek(0)
                json.dump(trades, f, indent=2)
        except Exception as e:
            logger.error(f"Failed to log trade: {e}")
