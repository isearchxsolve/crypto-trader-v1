from fastapi import FastAPI
from pydantic import BaseModel
from typing import List, Optional
import pickle
import numpy as np
import os
import logging

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("MLService")

app = FastAPI()

MODEL_PATH = os.path.join(os.path.dirname(__file__), "model.pkl")

class PredictRequest(BaseModel):
    age_seconds: float
    liquidity_usd: float
    volume_5m: float
    volume_1h: float
    volume_change_1m: float
    price_change_5m: float
    price_change_1h: float
    buy_pressure_5m: float
    buy_pressure_1h: float
    buy_sell_ratio: float
    tx_velocity_per_hour: float
    fdv: float
    liq_to_mcap: float

class PredictBatchRequest(BaseModel):
    tokens: List[PredictRequest]

class PredictResponse(BaseModel):
    pump_probability: float
    dump_risk: float
    model_version: str

class BatchPredictResponse(BaseModel):
    predictions: List[PredictResponse]

# Load model on startup
model = None
feature_columns = None
model_version = "1.0"

def load_model():
    global model, feature_columns, model_version
    if not os.path.exists(MODEL_PATH):
        logger.warning("No trained model found. Using heuristic fallback.")
        return
    
    try:
        with open(MODEL_PATH, "rb") as f:
            payload = pickle.load(f)
        
        if isinstance(payload, dict):
            model = payload["model"]
            feature_columns = payload["features"]
            model_version = payload.get("version", "2.0")
            logger.info(f"Loaded model v{model_version} with {len(feature_columns)} features")
        else:
            model = payload
            feature_columns = ["age_seconds", "liquidity_usd", "volume_change_1m"]
            model_version = "1.0"
            logger.info("Loaded legacy model v1.0")
    except Exception as e:
        logger.error(f"Failed to load model: {e}")

def apply_sanity_penalties(raw_prob, features):
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

def predict_single(features_dict):
    if model is None:
        return heuristic_predict(features_dict)
    
    try:
        feature_values = []
        for col in feature_columns:
            val = features_dict.get(col, 0)
            if val is None:
                val = 0
            feature_values.append(float(val))
        
        data = np.array([feature_values])
        raw_prob = float(model.predict_proba(data)[0][1])
        adjusted_prob, penalties = apply_sanity_penalties(raw_prob, features_dict)
        
        return {
            "pump_probability": adjusted_prob,
            "dump_risk": 1.0 - adjusted_prob,
            "raw_probability": raw_prob,
            "penalties": penalties,
            "model_version": model_version,
        }
    except Exception as e:
        logger.error(f"Prediction error: {e}")
        return heuristic_predict(features_dict)

def heuristic_predict(features):
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

@app.on_event("startup")
async def startup_event():
    load_model()

@app.get("/health")
async def health():
    return {"status": "ok", "model_loaded": model is not None, "version": model_version}

@app.post("/predict", response_model=PredictResponse)
async def predict(request: PredictRequest):
    features = request.dict()
    result = predict_single(features)
    return PredictResponse(
        pump_probability=result["pump_probability"],
        dump_risk=result["dump_risk"],
        model_version=result["model_version"],
    )

@app.post("/predict/batch", response_model=BatchPredictResponse)
async def predict_batch(request: PredictBatchRequest):
    results = []
    for token in request.tokens:
        features = token.dict()
        result = predict_single(features)
        results.append(PredictResponse(
            pump_probability=result["pump_probability"],
            dump_risk=result["dump_risk"],
            model_version=result["model_version"],
        ))
    return BatchPredictResponse(predictions=results)