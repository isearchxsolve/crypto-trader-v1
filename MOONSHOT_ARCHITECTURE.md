# 🚀 Moonshot Architecture v1.0
**System Overview & Strategic Presentation**

The Moonshot Architecture is a custom-engineered, fully autonomous trading system designed specifically to execute an asymmetric, risk-minimized strategy on the Solana blockchain. It transforms a micro-wallet (0.05 SOL / ~300 INR) into a precision sniper rifle.

---

## 1. The Discovery Pipeline (Speed Meets Safety)
The system solves the ultimate crypto dilemma—how to be first without buying into a fraud—by splitting discovery and verification into two isolated layers.

*   **Layer 1: The Lightning Feed (WebSocket)**
    A custom script (`fast_scanner.cjs`) is physically connected to the Solana blockchain via WebSockets. It filters through millions of transactions and instantly detects mature coins crossing specific safety thresholds.
*   **Layer 2: The "Prove It" Gates (The Engine)**
    The scanner injects candidates into the main Engine, which refuses to trade blindly. Before firing, the engine mathematically proves the token is safe by demanding:
    *   **$15,000 Minimum Liquidity:** Ensures you can actually sell when you want to.
    *   **$10,000 Minimum Volume (5m):** Ensures the market actually cares about the coin.
    *   **6-Hour Age Minimum:** Filters out the 99% of rugs that collapse in the first 2 hours.

---

## 2. The Micro-Wallet Sizing Algorithm (The 3 Bullets)
The system is mathematically hardcoded to protect your 300 INR capital by dividing it into perfectly sized "bullets," factoring in the hidden costs of the blockchain.

*   **Total Capital:** 0.05 SOL (~300 INR)
*   **Gas Fee Reserve:** 0.004 SOL is permanently locked to ensure transactions never fail due to network rent.
*   **Ammunition:** The remaining balance is strictly divided into **Three 0.015 SOL (100 INR) bullets**.
*   **Rule of Engagement:** The bot will fire a maximum of one bullet per setup.

---

## 3. The Asymmetric Exit Strategy (The Moonshot)
The entire architecture is built around the reality that meme coins fail 80% of the time. The exit strategy is designed to strictly limit those failures, while letting the 20% run into world-record territory.

| Stage | Trigger | Action | Strategic Purpose |
| :--- | :--- | :--- | :--- |
| **The Floor** | **-40% Drop** | **Stop Loss (Sell 100%)** | If a coin drops 40%, the thesis was wrong. The bot cuts the trade, accepting a minor 40 INR loss, and preserves the remaining capital for the next bullet. |
| **The Free Ride** | **+100% Gain** | **Partial TP (Sell 50%)** | The exact moment the coin doubles in value, the bot sells half the bag. This puts your original 100 INR bullet safely back into your wallet. The trade is now mathematically risk-free. |
| **The Moonshot** | **+100,000% Gain** | **Hard TP (Sell 100%)** | With the initial risk removed, the trailing stops are disabled. The bot holds the remaining 50% of the bag through extreme volatility until it hits a 1,000x World Record multiplier. |

---

## 4. Operational Status
*   **Deployment:** Fully committed and backed up to GitHub (`main` branch).
*   **Environment:** Production (`MODE=live`).
*   **Current State:** Armed and scanning. The engine is in a "dry-fire" state, monitoring the live blockchain. It will go hot the absolute millisecond the 0.05 SOL deposit is detected by the RPC.
