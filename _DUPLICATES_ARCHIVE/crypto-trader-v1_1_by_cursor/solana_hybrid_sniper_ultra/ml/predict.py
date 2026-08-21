import pickle
import os
import numpy as np
import logging

logger = logging.getLogger("Predictor")

class Predictor:
    def __init__(self):
        self.model_path = "solana_hybrid_sniper_ultra/ml/model.pkl"
        self.model = None
        self.feature_columns = None
        self.version = "1.0"
        self._load_model()

    def _load_model(self):
        if not os.path.exists(self.model_path):
            logger.warning("No trained model found. Using heuristic fallback.")
            return

        try:
            with open(self.model_path, "rb") as f:
                payload = pickle.load(f)

            if isinstance(payload, dict):
                self.model = payload["model"]
                self.feature_columns = payload["features"]
                self.version = payload.get("version", "2.0")
                logger.info(f"Loaded model v{self.version} with {len(self.feature_columns)} features")
            else:
                self.model = payload
                self.feature_columns = ["age_seconds", "liquidity_usd", "volume_change_1m"]
                self.version = "1.0"
                logger.info("Loaded legacy model v1.0")
        except Exception as e:
            logger.error(f"Failed to load model: {e}")

    def _apply_sanity_penalties(self, raw_prob, features):
        prob = raw_prob
        penalties = []

        liq = features.get("liquidity_usd", 0)
        if liq < 2000:
            penalty = 0.30
            prob *= (1 - penalty)
            penalties.append(f"low_liq({liq:.0f})")

        bp_5m = features.get("buy_pressure_5m", 0.5)
        bp_1h = features.get("buy_pressure_1h", 0.5)
        if bp_5m > 0.6 and bp_1h < 0.40:
            penalty = 0.25
            prob *= (1 - penalty)
            penalties.append(f"bp_divergence(5m:{bp_5m:.2f},1h:{bp_1h:.2f})")

        pc_5m = features.get("price_change_5m", 0)
        pc_1h = features.get("price_change_1h", 0)
        if pc_5m > 20 and pc_1h < -10:
            penalty = 0.20
            prob *= (1 - penalty)
            penalties.append(f"dead_cat(5m:{pc_5m:.1f}%,1h:{pc_1h:.1f}%)")

        vol_5m = features.get("volume_5m", 0)
        if liq > 0 and vol_5m / (liq + 1e-9) > 5:
            penalty = 0.15
            prob *= (1 - penalty)
            penalties.append(f"vol_liq_ratio({vol_5m/liq:.1f}x)")

        age = features.get("age_seconds", 99999)
        if age < 15:
            penalty = 0.20
            prob *= (1 - penalty)
            penalties.append(f"too_new({age:.0f}s)")

        bsr = features.get("buy_sell_ratio", 1.0)
        if bsr < 0.7:
            penalty = 0.15
            prob *= (1 - penalty)
            penalties.append(f"sell_pressure(bsr:{bsr:.2f})")

        fdv = features.get("fdv", 0)
        if fdv > 0 and liq / (fdv + 1e-9) < 0.005:
            penalty = 0.10
            prob *= (1 - penalty)
            penalties.append(f"low_liq_ratio({liq/fdv:.4f})")

        prob = max(0.02, min(0.95, prob))

        return prob, penalties

    def predict(self, features):
        if not self.model:
            return self._heuristic_predict(features)

        try:
            feature_values = []
            for col in self.feature_columns:
                val = features.get(col, 0)
                if val is None:
                    val = 0
                feature_values.append(float(val))

            data = np.array([feature_values])
            raw_prob = float(self.model.predict_proba(data)[0][1])

            adjusted_prob, penalties = self._apply_sanity_penalties(raw_prob, features)

            return {
                "pump_probability": adjusted_prob,
                "dump_risk": 1.0 - adjusted_prob,
                "raw_probability": raw_prob,
                "penalties": penalties,
                "model_version": self.version,
            }
        except Exception as e:
            logger.error(f"Prediction error: {e}")
            return self._heuristic_predict(features)

    def _heuristic_predict(self, features):
        age = features.get("age_seconds", 99999)
        liq = features.get("liquidity_usd", 0)
        buy_pressure = features.get("buy_pressure_5m", 0.5)
        bp_1h = features.get("buy_pressure_1h", 0.5)
        price_change_5m = features.get("price_change_5m", 0)
        vol_momentum = features.get("volume_change_1m", 0)
        bsr = features.get("buy_sell_ratio", 1.0)

        score = 0.25

        if age < 120:
            score += 0.12
        elif age < 600:
            score += 0.05

        if 5000 < liq < 200000:
            score += 0.10
        elif liq < 2000:
            score -= 0.15

        if buy_pressure > 0.65:
            score += 0.12
        elif buy_pressure > 0.55:
            score += 0.05

        if bp_1h > 0.55:
            score += 0.08
        elif bp_1h < 0.40:
            score -= 0.10

        if buy_pressure > 0.60 and bp_1h > 0.55:
            score += 0.05

        if price_change_5m > 10:
            score += 0.08
        elif price_change_5m > 3:
            score += 0.04

        if vol_momentum > 2:
            score += 0.08

        if bsr > 1.5:
            score += 0.06
        elif bsr < 0.7:
            score -= 0.10

        score = max(0.05, min(0.90, score))

        return {
            "pump_probability": score,
            "dump_risk": 1.0 - score,
            "raw_probability": score,
            "penalties": [],
            "model_version": "heuristic",
        }
