#!/usr/bin/env python3
"""
ML Model Validation on Real DexScreener Data.

Fetches real Solana memecoin tokens from DexScreener, runs the ML predictor
and heuristic fallback on each, and saves results to data/ml_validation.json
for analysis.

Usage:
    py validate_ml_real.py [--tokens N] [--timeout SEC]

Requires: aiohttp, solders (for keypair), dotenv
"""

import sys
import os
import json
import asyncio
import time
import logging
from datetime import datetime

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, SCRIPT_DIR)
sys.path.insert(0, os.path.join(SCRIPT_DIR, "solana_hybrid_sniper_ultra"))

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
)
logger = logging.getLogger("MLValidate")

# Silence noisy loggers
logging.getLogger("Predictor").setLevel(logging.WARNING)
logging.getLogger("DataFetcher").setLevel(logging.WARNING)


async def validate():
    from solana_hybrid_sniper_ultra.utils.data_fetcher import DataFetcher
    from solana_hybrid_sniper_ultra.ml.predict import Predictor
    from solana_hybrid_sniper_ultra.strategy import HybridStrategy

    # Parse args
    max_tokens = 50
    timeout_sec = 300
    for arg in sys.argv[1:]:
        if arg.startswith("--tokens="):
            max_tokens = int(arg.split("=")[1])
        elif arg.startswith("--timeout="):
            timeout_sec = int(arg.split("=")[1])

    fetcher = DataFetcher()
    predictor = Predictor()
    strategy = HybridStrategy()

    results = []
    scanned = 0
    signals = 0
    start_time = time.time()
    deadline = start_time + timeout_sec

    print(f"ML Validation on Real DexScreener Data")
    print(f"  Max tokens: {max_tokens}")
    print(f"  Timeout: {timeout_sec}s")
    print(f"  Model: {predictor.version}")
    print(f"  {'='*60}")
    print()

    while len(results) < max_tokens and time.time() < deadline:
        try:
            tokens = await fetcher.get_new_listings()
            if not tokens:
                logger.info("No new tokens, waiting 5s...")
                await asyncio.sleep(5)
                continue

            for token in tokens:
                if len(results) >= max_tokens:
                    break
                if time.time() >= deadline:
                    break

                scanned += 1
                address = token.get("address", "")
                symbol = token.get("symbol", "???")
                liq = token.get("liquidity", 0) or 0
                age = token.get("age_seconds", 99999)

                features = fetcher.process_features(token, {
                    "bids": token.get("buys_1h", 0),
                    "asks": token.get("sells_1h", 0),
                    "volume_24h": token.get("volume_24h", 0),
                    "liquidity_usd": liq,
                })

                # ML model prediction
                ml_result = predictor.predict(features)

                # Strategy analysis
                signal = strategy.analyze(features, ml_result)
                mode = strategy.current_mode if signal else "NONE"

                result = {
                    "scanned_index": scanned,
                    "timestamp": datetime.utcnow().isoformat(),
                    "symbol": symbol,
                    "address": address[:12] + "...",
                    "liquidity_usd": round(liq, 2),
                    "age_seconds": round(age, 1),
                    "price_change_5m": features.get("price_change_5m", 0),
                    "buy_pressure_5m": round(features.get("buy_pressure_5m", 0), 4),
                    "buy_sell_ratio": round(features.get("buy_sell_ratio", 0), 2),
                    "volume_momentum": round(features.get("volume_change_1m", 0), 2),
                    "predictions": {
                        "pump_probability": round(ml_result.get("pump_probability", 0), 4),
                        "dump_risk": round(ml_result.get("dump_risk", 0), 4),
                        "raw_probability": round(ml_result.get("raw_probability", 0), 4),
                        "model_version": ml_result.get("model_version", "unknown"),
                        "penalties": ml_result.get("penalties", []),
                    },
                    "signal": {
                        "action": signal["action"] if signal else "NONE",
                        "mode": mode,
                        "size_sol": signal.get("size_sol", 0) if signal else 0,
                    },
                }

                results.append(result)

                if signal:
                    signals += 1
                    flag = "*** SIGNAL ***"
                else:
                    flag = ""

                prob = ml_result.get("pump_probability", 0)
                print(f"  [{len(results):2d}/{max_tokens}] ${symbol:<8} liq=${liq:<8,.0f} "
                      f"age={age:<5.0f}s prob={prob:.3f} {flag}")

                await asyncio.sleep(0.5)  # Rate limit

        except Exception as e:
            logger.error(f"Scan error: {e}")
            await asyncio.sleep(5)

    elapsed = time.time() - start_time
    print()
    print(f"  {'='*60}")
    print(f"  RESULTS")
    print(f"  {'='*60}")
    print(f"  Scanned: {scanned} tokens")
    print(f"  Validated: {len(results)} tokens")
    print(f"  Signals: {signals} ({signals/max(len(results),1)*100:.1f}%)")
    print(f"  Time: {elapsed:.0f}s")

    # Compute statistics
    probs = [r["predictions"]["pump_probability"] for r in results]
    signal_probs = [r["predictions"]["pump_probability"] for r in results if r["signal"]["action"] == "BUY"]
    print(f"  Avg pump probability: {sum(probs)/len(probs):.4f}" if probs else "  No predictions")
    if signal_probs:
        print(f"  Avg signal probability: {sum(signal_probs)/len(signal_probs):.4f}")
    print(f"  Model: {predictor.version}")

    # Save
    output = {
        "timestamp": datetime.utcnow().isoformat(),
        "config": {"max_tokens": max_tokens, "timeout_sec": timeout_sec},
        "statistics": {
            "scanned": scanned,
            "validated": len(results),
            "signals": signals,
            "signal_rate": round(signals / max(len(results), 1) * 100, 1),
            "elapsed_seconds": round(elapsed, 1),
            "avg_pump_prob": round(sum(probs) / len(probs), 4) if probs else 0,
            "avg_signal_prob": round(sum(signal_probs) / len(signal_probs), 4) if signal_probs else 0,
        },
        "results": results,
    }

    save_path = os.path.join(SCRIPT_DIR, "data", "ml_validation.json")
    os.makedirs(os.path.dirname(save_path), exist_ok=True)
    with open(save_path, "w") as f:
        json.dump(output, f, indent=2)
    print(f"  Saved: {save_path}")
    print()

    # Summary verdict
    if signals > 0:
        avg_sp = sum(signal_probs) / len(signal_probs)
        print(f"  VERDICT: Model generates {signals} signals from {len(results)} tokens ({signals/len(results)*100:.1f}% hit rate)")
        print(f"           Avg signal probability: {avg_sp:.3f}")
        if avg_sp > 0.85:
            print(f"           Signal confidence is HIGH (>.85) — signals likely meaningful")
        elif avg_sp > 0.70:
            print(f"           Signal confidence is MODERATE (.70-.85) — needs further validation")
        else:
            print(f"           Signal confidence is LOW (<.70) — model may not work on real data")
        print(f"           Compare against actual price action to confirm edge")
    else:
        print(f"  VERDICT: No signals generated — strategy thresholds may be too strict for real data")
        print(f"           Or: ML model probabilities are too low to trigger entries")
        print(f"           Check heuristic fallback vs model predictions in saved data")

    await fetcher.close()


if __name__ == "__main__":
    asyncio.run(validate())
