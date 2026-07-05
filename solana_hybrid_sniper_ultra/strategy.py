import logging

logger = logging.getLogger("Strategy")

class HybridStrategy:
    """
    Multi-mode strategy for explosive compounding.
    
    Modes (increasing confidence/aggressiveness):
      SCANNING -> HWR -> MG -> SNIPER
    
    SNIPER mode gets the biggest position size (1.8x) and widest TP (25%).
    """

    def __init__(self):
        self.current_mode = "SCANNING"

    def analyze(self, features, predictions):
        age = features.get("age_seconds", 99999)
        liq = features.get("liquidity_usd", 0)
        pump_prob = predictions.get("pump_probability", 0)
        dump_risk = predictions.get("dump_risk", 1)
        vol_momentum = features.get("volume_change_1m", 0)
        buy_pressure = features.get("buy_pressure_5m", 0.5)
        price_change_5m = features.get("price_change_5m", 0)
        tx_velocity = features.get("tx_velocity_per_hour", 0)
        liq_to_mcap = features.get("liq_to_mcap", 0)
        bsr = features.get("buy_sell_ratio", 1.0)

        # ── HARD FILTERS: skip any token failing these ──
        if liq < 5000:
            self.current_mode = "SCANNING"
            return None

        if liq_to_mcap < 0.005 and liq < 15000:
            self.current_mode = "SCANNING"
            return None

        if bsr < 0.85:
            self.current_mode = "SCANNING"
            return None

        # ── SNIPER: ultra-early, higher feature confidence ──
        # Fresh token with strong buy pressure and volume momentum
        if (age < 120 and pump_prob > 0.50 and
            buy_pressure > 0.60 and bsr > 1.5 and
            vol_momentum > 1.5 and liq > 10000):
            self.current_mode = "SNIPER"
            size = min(0.12, max(0.03, liq / 50000))
            return self._generate_signal("BUY", size, 8.0, 0.06, 0.25)

        # ── MG (Momentum Growth): mid-stage momentum ──
        if (pump_prob > 0.55 and vol_momentum > 2.0 and
            price_change_5m > 5 and tx_velocity > 100 and
            buy_pressure > 0.55 and bsr > 1.3):
            self.current_mode = "MG"
            size = min(0.10, liq / 100000)
            return self._generate_signal("BUY", size, 4.0, 0.06, 0.18)

        # ── HWR (High Win Rate): highest probability, lowest risk ──
        if (pump_prob > 0.60 and dump_risk < 0.40 and
            buy_pressure > 0.60 and liq > 10000 and
            bsr > 1.6 and vol_momentum > 1.2):
            self.current_mode = "HWR"
            size = min(0.08, liq / 150000)
            return self._generate_signal("BUY", size, 2.0, 0.06, 0.15)

        self.current_mode = "SCANNING"
        return None

    def _generate_signal(self, action, size, slippage, stop_loss_pct=0.06, take_profit_pct=0.35):
        size = max(0.01, round(size, 3))
        return {
            "action": action,
            "size_sol": size,
            "slippage": slippage,
            "stop_loss_pct": stop_loss_pct,
            "take_profit_pct": take_profit_pct,
            "timestamp": "now",
        }
