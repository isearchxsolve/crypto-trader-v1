# Run from project root:  python ml_diag.py
# Self-locates the 'ml' package (it lives under solana_hybrid_sniper_ultra/, not project root).
import os, sys, glob

def find_ml_parent():
    cwd = os.getcwd()
    # 1) explicit likely locations (fast path)
    for cand in [
        os.path.join(cwd, "ml", "predict.py"),
        os.path.join(cwd, "solana_hybrid_sniper_ultra", "ml", "predict.py"),
        os.path.join(cwd, "server", "ml", "predict.py"),
    ]:
        if os.path.exists(cand):
            return os.path.dirname(os.path.dirname(cand))
    # 2) bounded search (skip node_modules/.git/dist)
    skip = ("node_modules", ".git", "dist", ".venv", "venv", "__pycache__")
    for root, dirs, files in os.walk(cwd):
        dirs[:] = [d for d in dirs if d not in skip]
        if os.path.basename(root) == "ml" and "predict.py" in files:
            return os.path.dirname(root)
    return None

parent = find_ml_parent()
if not parent:
    print("COULD NOT FIND ml/predict.py under", os.getcwd())
    print("Run me from the folder that contains 'solana_hybrid_sniper_ultra', or tell me where ml/ is.")
    sys.exit(1)
print("found ml package under:", parent)
if parent not in sys.path:
    sys.path.insert(0, parent)

import numpy as np
from ml.predict import Predictor

p = Predictor()
print("\n=== MODEL LOAD ===")
print("model_path        :", getattr(p, "model_path", "?"))
print("model.pkl exists  :", os.path.exists(getattr(p, "model_path", "")))
print("version           :", p.version)
print("model loaded      :", p.model is not None)
print("model type        :", type(p.model))
print("feature_columns   :", p.feature_columns)
try:
    print("named_steps(pipe) :", getattr(p.model, "named_steps", None))
except Exception as e:
    print("named_steps err   :", e)

feat = {
  "age_seconds": 90, "liquidity_usd": 28000, "volume_5m": 15000, "volume_1h": 40000,
  "volume_change_1m": 2.5, "price_change_5m": 32.0, "price_change_1h": 10.0,
  "buy_pressure_5m": 0.70, "buy_pressure_1h": 0.60, "buy_sell_ratio": 1.6,
  "tx_velocity_per_hour": 500, "fdv": 120000, "liq_to_mcap": 0.2,
}
print("\n=== RAW MODEL OUTPUT ON A STRONG FRESH POOL ===")
if p.model and p.feature_columns:
    missing = [c for c in p.feature_columns if c not in feat]
    print("cols model wants but engine may NOT send:", missing)
    vals = [float(feat.get(c, 0)) for c in p.feature_columns]
    print("vector fed to model:", list(zip(p.feature_columns, vals)))
    try:
        print("raw predict_proba   :", p.model.predict_proba(np.array([vals]))[0].tolist())
    except Exception as e:
        print("predict_proba ERROR :", e)
else:
    print("(no model loaded -> pure heuristic)")
print("\n=== FINAL predict() (what the engine receives) ===")
print(p.predict(feat))
