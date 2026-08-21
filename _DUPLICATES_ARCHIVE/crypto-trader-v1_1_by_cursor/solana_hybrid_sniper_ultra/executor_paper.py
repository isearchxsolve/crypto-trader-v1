import json
import os
from datetime import datetime

class PaperExecutor:
    def __init__(self, db_path="solana_hybrid_sniper_ultra/data/paper_trades.json"):
        self.db_path = db_path
        os.makedirs(os.path.dirname(self.db_path), exist_ok=True)
        if not os.path.exists(self.db_path):
            with open(self.db_path, 'w') as f:
                json.dump([], f)

    async def execute_trade(self, token, mode, signal):
        trade = {
            "timestamp": datetime.now().isoformat(),
            "symbol": token.get('symbol'),
            "mint": token.get('address'),
            "mode": mode,
            "entry_price": token.get('price', 0),
            "size_sol": signal['size_sol'],
            "status": "OPEN"
        }
        
        with open(self.db_path, 'r+') as f:
            trades = json.load(f)
            trades.append(trade)
            f.seek(0)
            json.dump(trades, f, indent=2)
            
        print(f"DEBUG: Executed Paper {mode} Buy on {token['symbol']} @ {trade['entry_price']}")
        return True
