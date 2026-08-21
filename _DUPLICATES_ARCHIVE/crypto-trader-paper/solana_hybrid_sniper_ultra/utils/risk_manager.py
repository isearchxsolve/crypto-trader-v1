"""
Risk Manager — real-world protection layer for Solana live trading.

Validates token safety, models realistic failure modes (latency, rugs,
MEV, slippage), and enforces position-size limits relative to liquidity.

All loss probabilities are calibrated from empirical Solana memecoin data.
"""

import os
import json
import time
import random
import logging
import re
from datetime import datetime

logger = logging.getLogger("RiskManager")

# ─────────────────────────────────────────────
# Token Safety Checks
# ─────────────────────────────────────────────

class TokenSafety:
    """Heuristic token safety validation (no on-chain RPC calls)."""

    SUSPICIOUS_PATTERNS = [
        r"(honeypot|honey.?pot)", r"(fake|scam|rug)", r"(test|sandwich)",
    ]

    @staticmethod
    def check(token: dict, liq: float = None) -> dict:
        """
        Returns {'safe': bool, 'reasons': [str], 'score': float}.
        Checks: liquidity, age, volume patterns, buy/sell ratio,
        top-holder concentration (from DexScreener if available).
        """
        reasons = []
        score = 1.0

        liq = liq or token.get("liquidity", 0)
        if liq < 5000:
            reasons.append(f"liq_too_low={liq:.0f}")
            score *= 0.3

        age = token.get("age_seconds", 99999)
        if age < 30:
            reasons.append(f"too_new={age:.0f}s")
            score *= 0.5

        # Volume-to-liquidity ratio (wash trading detection)
        vol_5m = token.get("volume_5m", 0) or 0
        if liq > 0 and vol_5m / liq > 8:
            reasons.append(f"wash_trading(vol/liq={vol_5m/liq:.1f}x)")
            score *= 0.4

        # Buy/sell ratio divergence
        bsr = token.get("buys_5m", 10) / max(token.get("sells_5m", 1), 1)
        if bsr < 0.5:
            reasons.append(f"sell_pressure(bsr={bsr:.2f})")
            score *= 0.5
        if bsr > 20 and age < 120:
            reasons.append(f"coordinated_buys(bsr={bsr:.1f})")
            score *= 0.6

        # Top-holder concentration (if available in pair data)
        holders = token.get("holders", [])
        if holders and len(holders) >= 3:
            top3_pct = sum(h.get("pct", 0) for h in holders[:3])
            if top3_pct > 60:
                reasons.append(f"top3_holders={top3_pct:.0f}%")
                score *= 0.3
            elif top3_pct > 40:
                reasons.append(f"top3_holders={top3_pct:.0f}%")
                score *= 0.7

        # Liquidity-to-FDV ratio
        fdv = token.get("fdv", 0) or 1
        liq_ratio = liq / fdv if fdv > 0 else 0.05
        if liq_ratio < 0.003:
            reasons.append(f"liq/fdv={liq_ratio:.4f}")
            score *= 0.2
        elif liq_ratio < 0.01:
            reasons.append(f"liq/fdv={liq_ratio:.4f}")
            score *= 0.6

        # Symbol/name pattern check
        symbol = (token.get("symbol", "") or "").lower()
        name = (token.get("name", "") or "").lower()
        for pat in TokenSafety.SUSPICIOUS_PATTERNS:
            if re.search(pat, symbol) or re.search(pat, name):
                reasons.append(f"suspicious_name({symbol})")
                score *= 0.1

        return {
            "safe": score >= 0.35,
            "reasons": reasons,
            "score": round(score, 4),
        }


# ─────────────────────────────────────────────
# Real-World Failure Model
# ─────────────────────────────────────────────

class RealWorldFailureModel:
    """
    Simulates real-world failure probabilities for paper trading.
    Calibrated to Solana memecoin empirical data.
    """

    # Base failure rates per trade (live Solana memecoin averages)
    RUG_PROBABILITY = 0.035         # 3.5% — token gets rugged/liquidity drained
    TX_FAIL_PROBABILITY = 0.05      # 5% — transaction fails (network, slippage)
    LATENCY_MISS_PROBABILITY = 0.04 # 4% — price moves beyond acceptable range
    MEV_SANDWICH_PROBABILITY = 0.03 # 3% — significant MEV extraction (>2% loss)
    SLIPPAGE_EXCEED_PROBABILITY = 0.06  # 6% — final fill worse than expected

    # Severity multipliers when failures happen
    RUG_LOSS_PCT = 0.85             # lose 85% of position in a rug
    TX_FAIL_COST_PCT = 0.005        # lose 0.5% in tx fees
    LATENCY_MISS_LOSS_PCT = 0.12    # 12% extra loss from price moving
    MEV_SANDWICH_LOSS_PCT = 0.06    # 6% loss from sandwich attack
    SLIPPAGE_EXCEED_EXTRA_PCT = 0.08 # 8% extra slippage beyond expected

    @staticmethod
    def apply_real_world_friction(trade_pnl_pct: float, size_sol: float,
                                    liq: float) -> dict:
        """
        Apply realistic failure modes to a simulated trade PnL.
        Returns {'adjusted_pnl': float, 'failures': [str]}.
        """
        failures = []
        pnl = trade_pnl_pct

        # ── Rug check (scales with low liq) ──
        rug_prob = RealWorldFailureModel.RUG_PROBABILITY
        if liq < 20000:
            rug_prob *= 2.5  # low-liq tokens 2.5x more likely to rug
        if random.random() < rug_prob:
            pnl = -RealWorldFailureModel.RUG_LOSS_PCT
            failures.append(f"rug(liquidity drained, -{RealWorldFailureModel.RUG_LOSS_PCT*100:.0f}%)")
            return {"adjusted_pnl": pnl, "failures": failures}

        # ── Transaction failure ──
        if random.random() < RealWorldFailureModel.TX_FAIL_PROBABILITY:
            tx_cost = RealWorldFailureModel.TX_FAIL_COST_PCT * (size_sol / max(liq, 1))
            pnl -= tx_cost
            failures.append(f"tx_fail(fee={tx_cost*100:.2f}%)")

        # ── Latency miss ──
        if random.random() < RealWorldFailureModel.LATENCY_MISS_PROBABILITY:
            pnl -= RealWorldFailureModel.LATENCY_MISS_LOSS_PCT
            failures.append(f"latency(price_moved -{RealWorldFailureModel.LATENCY_MISS_LOSS_PCT*100:.0f}%)")

        # ── MEV sandwich ──
        if random.random() < RealWorldFailureModel.MEV_SANDWICH_PROBABILITY:
            pnl -= RealWorldFailureModel.MEV_SANDWICH_LOSS_PCT
            failures.append(f"mev(sandwich -{RealWorldFailureModel.MEV_SANDWICH_LOSS_PCT*100:.0f}%)")

        # ── Slippage exceed ──
        if random.random() < RealWorldFailureModel.SLIPPAGE_EXCEED_PROBABILITY:
            pnl -= RealWorldFailureModel.SLIPPAGE_EXCEED_EXTRA_PCT
            failures.append(f"slippage(-{RealWorldFailureModel.SLIPPAGE_EXCEED_EXTRA_PCT*100:.0f}% extra)")

        # Scale big positions more (market impact)
        if size_sol > 5:
            impact_penalty = min(0.15, (size_sol / max(liq, 1000)) * 10)
            pnl -= impact_penalty
            failures.append(f"market_impact(-{impact_penalty*100:.1f}%)")

        return {"adjusted_pnl": pnl, "failures": failures}


# ─────────────────────────────────────────────
# Position Sizing Guardrails
# ─────────────────────────────────────────────

class PositionGuardrails:
    """
    Enforces position-size limits relative to liquidity and wallet.
    Prevents the aggressive compounding from destroying the account
    on a single bad trade.
    """

    # Max % of pool liquidity a single trade can consume
    MAX_POSITION_PCT_OF_LIQUIDITY = 0.02  # 2%

    # Max % of account balance per trade
    MAX_PCT_OF_ACCOUNT = 0.50  # 50%

    # Absolute minimum liquidity to trade
    MIN_LIQUIDITY_USD = 5000

    @staticmethod
    def clamp_size(size_sol: float, liq_usd: float, balance_sol: float) -> float:
        """
        Clamp position size based on liquidity and account balance.
        """
        # Liquidity-based cap
        liq_cap = liq_usd * PositionGuardrails.MAX_POSITION_PCT_OF_LIQUIDITY / 200

        # Balance-based cap
        bal_cap = balance_sol * PositionGuardrails.MAX_PCT_OF_ACCOUNT

        clamped = min(size_sol, liq_cap, bal_cap)
        clamped = max(0.01, clamped)

        return round(clamped, 4)

    @staticmethod
    def is_tradable(liq_usd: float, token_safety: dict) -> bool:
        """Quick check if we should even consider this token."""
        if liq_usd < PositionGuardrails.MIN_LIQUIDITY_USD:
            return False
        if not token_safety.get("safe", False):
            return False
        return True


# ─────────────────────────────────────────────
# Comprehensive Risk Assessment
# ─────────────────────────────────────────────

class RiskAssessor:
    """
    Full risk assessment: token safety + position guardrails +
    failure probability estimate.
    """

    @staticmethod
    def assess(token: dict, balance_sol: float, signal: dict = None) -> dict:
        liq = token.get("liquidity", 0)
        safety = TokenSafety.check(token, liq)
        position_ok = PositionGuardrails.is_tradable(liq, safety)

        # Estimated failure probability
        fail_prob = RealWorldFailureModel.RUG_PROBABILITY + \
                    RealWorldFailureModel.TX_FAIL_PROBABILITY + \
                    RealWorldFailureModel.LATENCY_MISS_PROBABILITY + \
                    RealWorldFailureModel.MEV_SANDWICH_PROBABILITY + \
                    RealWorldFailureModel.SLIPPAGE_EXCEED_PROBABILITY

        # Adjust for liquidity
        if liq < 20000:
            fail_prob *= 2.0
        elif liq < 50000:
            fail_prob *= 1.5

        fail_prob = min(fail_prob, 0.45)

        # Signal strength adjustment
        if signal:
            mode_mult = {"HWR": 0.7, "MG": 0.85, "SNIPER": 1.0}.get(
                signal.get("mode", "HWR"), 1.0
            )
            fail_prob *= mode_mult

        return {
            "tradable": position_ok,
            "safety": safety,
            "failure_probability": round(fail_prob, 4),
            "expected_loss_per_trade": round(fail_prob * 0.15, 4),
            "recommended_max_size": PositionGuardrails.clamp_size(
                signal.get("size_sol", 0.05) if signal else 0.05,
                liq, balance_sol
            ),
        }


# ─────────────────────────────────────────────
# Live Transaction Safety
# ─────────────────────────────────────────────

class LiveTransactionGuard:
    """
    Guards for live transaction execution:
    - Dynamic slippage based on liquidity
    - Price impact limits
    - MEV protection (Jito bundles)
    - RPC failover
    """

    @staticmethod
    def compute_safe_slippage(liq_usd: float, trade_size_sol: float, mode: str) -> int:
        """Return slippage in BPS based on liquidity and trade size."""
        # Base slippage by mode
        mode_base = {"HWR": 200, "MG": 400, "SNIPER": 800}.get(mode, 300)
        # Scale up for large trades relative to liquidity
        impact_ratio = (trade_size_sol * 200) / max(liq_usd, 1)
        if impact_ratio > 0.1:
            mode_base = min(mode_base * 2, 1500)
        return mode_base

    @staticmethod
    def check_price_impact(quote: dict, max_impact_pct: float = 3.0) -> bool:
        """True if price impact is acceptable."""
        impact = float(quote.get("priceImpactPct", 0))
        return impact <= max_impact_pct

    @staticmethod
    def should_use_jito(trade_size_sol: float) -> bool:
        """Use Jito bundles for trades above threshold."""
        return trade_size_sol > 1.0

    @staticmethod
    def get_rpc_endpoints() -> list:
        """Return prioritized RPC list with failover."""
        primary = os.getenv("RPC_URL", "https://api.mainnet-beta.solana.com")
        backup = os.getenv("SOLANA_RPC_BACKUP_URL", "")
        tertiary = os.getenv("SOLANA_RPC_TERTIARY_URL", "")
        endpoints = [primary]
        if backup:
            endpoints.append(backup)
        if tertiary:
            endpoints.append(tertiary)
        return endpoints


# ─────────────────────────────────────────────
# Configuration Snapshot
# ─────────────────────────────────────────────

def get_risk_summary() -> dict:
    """Return a human-readable summary of all risk parameters."""
    return {
        "rug_probability": RealWorldFailureModel.RUG_PROBABILITY,
        "tx_fail_probability": RealWorldFailureModel.TX_FAIL_PROBABILITY,
        "latency_miss_probability": RealWorldFailureModel.LATENCY_MISS_PROBABILITY,
        "mev_probability": RealWorldFailureModel.MEV_SANDWICH_PROBABILITY,
        "slippage_exceed_probability": RealWorldFailureModel.SLIPPAGE_EXCEED_PROBABILITY,
        "rug_loss_pct": RealWorldFailureModel.RUG_LOSS_PCT * 100,
        "mev_loss_pct": RealWorldFailureModel.MEV_SANDWICH_LOSS_PCT * 100,
        "max_position_pct_of_liquidity": PositionGuardrails.MAX_POSITION_PCT_OF_LIQUIDITY * 100,
        "max_pct_of_account": PositionGuardrails.MAX_PCT_OF_ACCOUNT * 100,
        "min_liquidity_usd": PositionGuardrails.MIN_LIQUIDITY_USD,
        "total_expected_fail_rate": round(
            RealWorldFailureModel.RUG_PROBABILITY +
            RealWorldFailureModel.TX_FAIL_PROBABILITY +
            RealWorldFailureModel.LATENCY_MISS_PROBABILITY +
            RealWorldFailureModel.MEV_SANDWICH_PROBABILITY +
            RealWorldFailureModel.SLIPPAGE_EXCEED_PROBABILITY, 3
        ),
    }
