import asyncio
import json
import os
import logging
from datetime import datetime
from utils.swap_executor import JupiterSwap
from utils.risk_manager import TokenSafety, PositionGuardrails, LiveTransactionGuard, RiskAssessor

logger = logging.getLogger("LiveExecutor")

SOL_MINT = "So11111111111111111111111111111111111111112"
LAMPORTS_PER_SOL = 1_000_000_000

class LiveExecutor:
    """
    Live trading executor with explosive compounding position sizing.
    Mirrors the PaperExecutor's aggressive Kelly sizing for live execution.
    """

    def __init__(self):
        self.jupiter = JupiterSwap()
        self.private_key = os.getenv("PRIVATE_KEY", "")
        self.rpc_url = os.getenv("RPC_URL", "https://api.mainnet-beta.solana.com")
        self.max_position_sol = float(os.getenv("MAX_POSITION_SOL", "100.0"))
        self.default_slippage_bps = int(os.getenv("DEFAULT_SLIPPAGE_BPS", "500"))
        self.trade_log_path = "solana_hybrid_sniper_ultra/data/live_trades.json"
        self.consecutive_wins = 0
        self.consecutive_losses = 0
        self.kelly_fraction = 0.50
        self.compound_power = 2.0
        self.max_account_risk_pct = 0.40
        self.max_concurrent = 5

        if not os.path.exists("solana_hybrid_sniper_ultra/data"):
            os.makedirs("solana_hybrid_sniper_ultra/data")
        if not os.path.exists(self.trade_log_path):
            with open(self.trade_log_path, 'w') as f:
                json.dump([], f)

    def _compute_size_sol(self, signal, balance_estimate=1.0):
        """
        Live position sizing: aggressive Kelly with streak boost.
        Uses balance_estimate from wallet or a default.
        """
        mode = signal.get("mode", "HWR")
        mode_mult = {"HWR": 1.0, "MG": 1.3, "SNIPER": 1.8}.get(mode, 1.0)

        base = signal.get("size_sol", 0.05)
        position = balance_estimate * self.kelly_fraction * base * self.compound_power * mode_mult

        if self.consecutive_wins > 0:
            streak_mult = 1.0 + (self.consecutive_wins * 0.15)
            position *= streak_mult

        position = max(0.01, min(position, balance_estimate * self.max_account_risk_pct * mode_mult))
        position = min(position, self.max_position_sol)
        return round(position, 4)

    async def execute_buy(self, token, mode, signal):
        address = token.get('address')
        symbol = token.get('symbol', 'UNKNOWN')
        liq = token.get('liquidity', 0) or 0
        bal_est = float(os.getenv("WALLET_BALANCE_SOL", "1.0"))
        signal["mode"] = mode

        # ── Token safety check ──
        safety = TokenSafety.check(token, liq)
        if not safety["safe"]:
            logger.warning(f"TOKEN REJECTED: {symbol} ({address}) reasons={safety['reasons']}")
            return False

        # ── Clamp position size by liquidity and balance ──
        raw_size = self._compute_size_sol(signal, bal_est)
        size_sol = PositionGuardrails.clamp_size(raw_size, liq, bal_est)

        # ── Dynamic slippage by mode/liquidity ──
        slippage_bps = LiveTransactionGuard.compute_safe_slippage(liq, size_sol, mode)
        amount_lamports = int(size_sol * LAMPORTS_PER_SOL)

        logger.info(f"LIVE BUY: {symbol} ({address}) | Size: {size_sol} SOL ({size_sol/bal_est*100:.1f}% of {bal_est:.1f}) | Slippage: {slippage_bps}bps | Mode: {mode} | Liq: ${liq:,.0f} | Safety: {safety['score']:.2f}")

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

            # ── Price impact rejection by mode ──
            max_impact = {"HWR": 3.0, "MG": 5.0, "SNIPER": 8.0}.get(mode, 5.0)
            if not LiveTransactionGuard.check_price_impact(quote, max_impact):
                logger.warning(f"Price impact too high for {symbol}: {price_impact}% (max {max_impact}%) — skipping")
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
                "slippage_bps": slippage_bps,
                "liquidity_usd": liq,
                "safety_score": safety["score"],
                "safety_reasons": safety["reasons"],
                "tx_hash": swap_result.get("txid", ""),
                "status": "CONFIRMED" if swap_result.get("success") else "FAILED"
            }

            if swap_result.get("success"):
                self.consecutive_wins += 1
                self.consecutive_losses = 0
            else:
                self.consecutive_wins = 0
                self.consecutive_losses += 1

            self._log_trade(trade)
            logger.info(f"LIVE TRADE CONFIRMED: {symbol} | TX: {trade['tx_hash']}")
            return swap_result.get("success", False)

        except Exception as e:
            logger.error(f"Live execution failed for {symbol}: {str(e)}")
            self.consecutive_wins = 0
            self.consecutive_losses += 1
            self._log_trade({
                "timestamp": datetime.now().isoformat(),
                "symbol": symbol,
                "mint": address,
                "mode": mode,
                "trading_mode": "live",
                "action": "BUY",
                "size_sol": size_sol,
                "liquidity_usd": liq,
                "safety_score": safety.get("score", 0),
                "status": "ERROR",
                "error": str(e)
            })
            return False

    async def execute_sell(self, token, mode, amount):
        address = token.get('address')
        symbol = token.get('symbol', 'UNKNOWN')
        liq = token.get('liquidity', 0) or 0

        logger.info(f"LIVE SELL: {symbol} ({address}) | Amount: {amount} | Mode: {mode} | Liq: ${liq:,.0f}")

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
