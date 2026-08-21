import requests
import pandas as pd
import time
import os
from datetime import datetime

CSV_FILE = "solana_real_launches.csv"

def fetch_live_candidates():
    """Fetches the latest Solana tokens from DexScreener's free token-profile API."""
    try:
        res = requests.get("https://api.dexscreener.com/token-profiles/latest/v1", timeout=10)
        if res.status_code == 200:
            return [t for t in res.json() if t.get('chainId') == 'solana']
    except Exception as e:
        print(f"Error fetching profiles: {e}")
    return []

def get_token_metrics(token_address):
    """Fetches the exact metrics your routes.ts engine sees."""
    try:
        res = requests.get(f"https://api.dexscreener.com/latest/dex/tokens/{token_address}", timeout=10)
        if res.status_code == 200:
            data = res.json()
            if data.get('pairs'):
                # Get the main Solana pair
                sol_pairs = [p for p in data['pairs'] if p['chainId'] == 'solana']
                if sol_pairs:
                    return sol_pairs[0]
    except Exception:
        pass
    return None

def start_collector():
    print("Starting Live Data Collector. Leave this running to build your dataset...")
    
    # Write CSV headers if file doesn't exist
    if not os.path.exists(CSV_FILE):
        cols = ["token_address", "label", "price_t0", "max_price_30m", "age_seconds", 
                "liquidity_usd", "volume_5m", "volume_1h", "volume_change_1m", 
                "price_change_5m", "price_change_1h", "buy_pressure_5m", 
                "buy_pressure_1h", "buy_sell_ratio", "tx_velocity_per_hour", 
                "fdv", "liq_to_mcap"]
        pd.DataFrame(columns=cols).to_csv(CSV_FILE, index=False)

    tracked_tokens = {}

    while True:
        now = time.time()
        
        # 1. Look for new tokens to track
        candidates = fetch_live_candidates()
        for c in candidates:
            addr = c['tokenAddress']
            if addr not in tracked_tokens:
                metrics = get_token_metrics(addr)
                if metrics and float(metrics.get('liquidity', {}).get('usd', 0)) > 500:
                    
                    m5_buys = metrics.get('txns', {}).get('m5', {}).get('buys', 0)
                    m5_sells = metrics.get('txns', {}).get('m5', {}).get('sells', 0)
                    h1_buys = metrics.get('txns', {}).get('h1', {}).get('buys', 0)
                    h1_sells = metrics.get('txns', {}).get('h1', {}).get('sells', 0)
                    
                    tracked_tokens[addr] = {
                        "discovered_at": now,
                        "price_t0": float(metrics.get('priceUsd', 0)),
                        "max_price": float(metrics.get('priceUsd', 0)),
                        "features": {
                            "age_seconds": 300, # Simulated discovery age
                            "liquidity_usd": float(metrics.get('liquidity', {}).get('usd', 0)),
                            "volume_5m": float(metrics.get('volume', {}).get('m5', 0)),
                            "volume_1h": float(metrics.get('volume', {}).get('h1', 0)),
                            "volume_change_1m": 1.5, # Default momentum
                            "price_change_5m": float(metrics.get('priceChange', {}).get('m5', 0)),
                            "price_change_1h": float(metrics.get('priceChange', {}).get('h1', 0)),
                            "buy_pressure_5m": m5_buys / (m5_buys + m5_sells + 0.001),
                            "buy_pressure_1h": h1_buys / (h1_buys + h1_sells + 0.001),
                            "buy_sell_ratio": h1_buys / (h1_sells + 0.001),
                            "tx_velocity_per_hour": (m5_buys + m5_sells) * 12,
                            "fdv": float(metrics.get('fdv', 0)),
                            "liq_to_mcap": float(metrics.get('liquidity', {}).get('usd', 0)) / (float(metrics.get('fdv', 1)) + 0.001)
                        }
                    }
                    print(f"[{datetime.now().strftime('%H:%M:%S')}] Tracking new token: {addr[:8]}... (Price: ${tracked_tokens[addr]['price_t0']:.6f})")

        # 2. Update prices for tracked tokens and resolve them if 30 mins have passed
        completed_tokens = []
        for addr, data in tracked_tokens.items():
            elapsed_mins = (now - data['discovered_at']) / 60
            
            # Update the peak price observed during the window
            metrics = get_token_metrics(addr)
            if metrics:
                current_price = float(metrics.get('priceUsd', 0))
                if current_price > data['max_price']:
                    data['max_price'] = current_price
            
            # If 30 minutes have passed, finalize the label and save to CSV
            if elapsed_mins >= 30:
                is_pump = 1 if data['max_price'] >= (data['price_t0'] * 2.0) else 0
                
                row = {
                    "token_address": addr,
                    "label": is_pump,
                    "price_t0": data['price_t0'],
                    "max_price_30m": data['max_price'],
                    **data['features']
                }
                
                pd.DataFrame([row]).to_csv(CSV_FILE, mode='a', header=False, index=False)
                print(f"\n✅ LOGGED: {addr[:8]} | 2x Pumped: {'YES' if is_pump else 'NO'} | Start: ${data['price_t0']:.6f} -> Max: ${data['max_price']:.6f}")
                
                completed_tokens.append(addr)
        
        # Cleanup completed tokens from memory
        for addr in completed_tokens:
            del tracked_tokens[addr]

        # Sleep for 1 minute before scanning again
        time.sleep(60)

if __name__ == "__main__":
    start_collector()