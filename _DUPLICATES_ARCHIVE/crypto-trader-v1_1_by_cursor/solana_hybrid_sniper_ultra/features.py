import numpy as np

class FeatureExtractor:
    @staticmethod
    def calculate_rsi(prices, period=14):
        if len(prices) < period + 1:
            return 50
        deltas = np.diff(prices)
        seed = deltas[:period + 1]
        up = seed[seed >= 0].sum() / period
        down = -seed[seed < 0].sum() / period
        rs = up / down if down != 0 else 100
        return 100.0 - 100.0 / (1.0 + rs)

    @staticmethod
    def calculate_vov(volumes):
        if len(volumes) < 5:
            return 0
        return np.std(volumes[-5:]) / (np.mean(volumes[-5:]) + 1e-9)

    @staticmethod
    def calculate_buy_pressure(buys, sells):
        total = buys + sells
        if total == 0:
            return 0.5
        return buys / total

    @staticmethod
    def calculate_volume_momentum(vol_5m, vol_1h):
        avg_5m_rate = vol_1h / 12 if vol_1h > 0 else 1e-9
        return vol_5m / avg_5m_rate

    @staticmethod
    def calculate_liquidity_score(liquidity, fdv):
        if fdv <= 0:
            return 0
        return liquidity / fdv
