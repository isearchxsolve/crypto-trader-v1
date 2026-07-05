import os
import sys
import math
sys.path.insert(0, os.path.dirname(__file__))

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel, field_validator
from ml.predict import Predictor
from typing import Optional
import uvicorn

app = FastAPI(title="Sniper ML Service")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

predictor = Predictor()

def safe_float(v, default=0.0):
    if v is None:
        return default
    try:
        f = float(v)
        if math.isnan(f) or math.isinf(f):
            return default
        return f
    except (ValueError, TypeError):
        return default

class TokenFeatures(BaseModel):
    age_seconds: Optional[float] = 99999
    liquidity_usd: Optional[float] = 0
    volume_5m: Optional[float] = 0
    volume_1h: Optional[float] = 0
    volume_change_1m: Optional[float] = 0
    price_change_5m: Optional[float] = 0
    price_change_1h: Optional[float] = 0
    buy_pressure_5m: Optional[float] = 0.5
    buy_pressure_1h: Optional[float] = 0.5
    buy_sell_ratio: Optional[float] = 1.0
    tx_velocity_per_hour: Optional[float] = 0
    fdv: Optional[float] = 0
    liq_to_mcap: Optional[float] = 0

    def sanitized_dict(self):
        return {
            "age_seconds": safe_float(self.age_seconds, 99999),
            "liquidity_usd": safe_float(self.liquidity_usd),
            "volume_5m": safe_float(self.volume_5m),
            "volume_1h": safe_float(self.volume_1h),
            "volume_change_1m": safe_float(self.volume_change_1m),
            "price_change_5m": safe_float(self.price_change_5m),
            "price_change_1h": safe_float(self.price_change_1h),
            "buy_pressure_5m": safe_float(self.buy_pressure_5m, 0.5),
            "buy_pressure_1h": safe_float(self.buy_pressure_1h, 0.5),
            "buy_sell_ratio": safe_float(self.buy_sell_ratio, 1.0),
            "tx_velocity_per_hour": safe_float(self.tx_velocity_per_hour),
            "fdv": safe_float(self.fdv),
            "liq_to_mcap": safe_float(self.liq_to_mcap),
        }

class BatchRequest(BaseModel):
    tokens: list[TokenFeatures]

@app.get("/health")
def health():
    return {"status": "ok", "model_version": predictor.version, "features": predictor.feature_columns}

@app.post("/predict")
async def predict_single(request: Request):
    try:
        body = await request.json()
        features = TokenFeatures(**{k: v for k, v in body.items() if v is not None})
        result = predictor.predict(features.sanitized_dict())
        return result
    except Exception as e:
        return JSONResponse(status_code=200, content={
            "pump_probability": 0.0,
            "dump_risk": 1.0,
            "model_version": predictor.version,
            "error": str(e)
        })

@app.post("/predict/batch")
async def predict_batch(request: Request):
    try:
        body = await request.json()
        results = []
        for token_data in body.get("tokens", []):
            try:
                features = TokenFeatures(**{k: v for k, v in token_data.items() if v is not None})
                result = predictor.predict(features.sanitized_dict())
                results.append(result)
            except Exception:
                results.append({"pump_probability": 0.0, "dump_risk": 1.0, "model_version": predictor.version})
        return {"predictions": results}
    except Exception as e:
        return JSONResponse(status_code=200, content={"predictions": [], "error": str(e)})

if __name__ == "__main__":
    port = int(os.getenv("ML_PORT", "5001"))
    print(f"[ML] Starting XGBoost ML service on port {port}")
    print(f"[ML] Model version: {predictor.version}")
    print(f"[ML] Features: {predictor.feature_columns}")
    uvicorn.run(app, host="0.0.0.0", port=port, log_level="info")
