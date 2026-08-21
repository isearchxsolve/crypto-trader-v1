from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
import json
import os

app = FastAPI()
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

@app.get("/api/status")
async def get_status():
    return {"bot_running": True, "mode": "SNIPER", "last_scan": "2026-03-03T10:00:00Z", "performance_24h": "+12.5%"}

@app.get("/api/trades")
async def get_trades():
    path = "solana_hybrid_sniper_ultra/data/paper_trades.json"
    if os.path.exists(path):
        with open(path, 'r') as f: return json.load(f)
    return []

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
