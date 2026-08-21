import logging

logger = logging.getLogger("Strategy")

class HybridStrategy:
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

        if liq < 500:
            self.current_mode = "SCANNING"
            return None

        if liq_to_mcap < 0.01 and liq < 5000:
            self.current_mode = "SCANNING"
            return None

        if age < 120 and liq < 100000 and pump_prob > 0.6 and buy_pressure > 0.55:
            self.current_mode = "SNIPER"
            size = min(1.0, liq / 50000)
            slippage = 15.0 if liq < 20000 else 10.0
            return self._generate_signal("BUY", size, slippage)

        if pump_prob > 0.7 and vol_momentum > 1.5 and price_change_5m > 3 and tx_velocity > 50:
            self.current_mode = "MG"
            size = min(0.5, liq / 100000)
            return self._generate_signal("BUY", size, 5.0)

        if pump_prob > 0.8 and dump_risk < 0.25 and buy_pressure > 0.6 and liq > 10000:
            self.current_mode = "HWR"
            size = min(0.3, liq / 200000)
            return self._generate_signal("BUY", size, 2.0)

        self.current_mode = "SCANNING"
        return None

    def _generate_signal(self, action, size, slippage):
        size = max(0.01, round(size, 3))
        return {
            "action": action,
            "size_sol": size,
            "slippage": slippage,
            "timestamp": "now",
        }
