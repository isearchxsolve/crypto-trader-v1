#!/usr/bin/env python3
"""
Stress test targeting 1000x ROI with aggressive parameters.
Runs the exact same simulation as real_world_stress_test.py but with tunable params.
"""
import sys, os, json, random
from datetime import datetime
sys.path.insert(0, os.path.dirname(__file__))
from utils.risk_manager import TokenSafety, RealWorldFailureModel, PositionGuardrails

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))

class RealWorldPaperExecutor:
    def __init__(self, kelly=0.50, compound_power=2.0, max_risk=0.40, concurrent=5, tp_pct=0.15, sl_pct=0.06):
        self.trades = []
        self.consecutive_wins = 0
        self.consecutive_losses = 0
        self.kelly_fraction = kelly
        self.compound_power = compound_power
        self.max_account_risk_pct = max_risk
        self.max_concurrent = concurrent
        self.tp_pct = tp_pct
        self.sl_pct = sl_pct

    def _balance(self, mark_open=False):
        closed_pnl = sum(t.get("pnl_sol", 0) for t in self.trades if t.get("status") == "CLOSED")
        open_mark = sum(t.get("pnl_sol", 0) for t in self.trades if t.get("status") == "OPEN") if mark_open else 0
        return max(0.001, 1.0 + closed_pnl + open_mark)

    def execute_trade(self, token, mode, signal):
        bal = self._balance(mark_open=True)
        liq = token.get("liquidity", 0)
        pump_score = token.get("_pump_score", 0.5)
        safety = TokenSafety.check(token, liq)
        if not safety["safe"]: return None
        raw_size = signal.get("size_sol", 0.05)
        mode_mult = {"HWR": 1.0, "MG": 1.3, "SNIPER": 1.8}.get(mode, 1.0)
        base_size = bal * self.kelly_fraction * raw_size * self.compound_power * mode_mult
        if self.consecutive_wins > 0:
            base_size *= (1.0 + self.consecutive_wins * 0.15)
        size = PositionGuardrails.clamp_size(base_size, liq, bal)
        open_count = sum(1 for t in self.trades if t.get("status") == "OPEN")
        if open_count >= self.max_concurrent: return None
        current_exposure = sum(t.get("size_sol", 0) for t in self.trades if t.get("status") == "OPEN")
        if current_exposure >= bal * 0.75: return None
        now = datetime.utcnow().isoformat()
        entry_price = token.get("price", 0) or 0
        trade = {
            "id": len(self.trades) + 1, "timestamp": now, "symbol": token.get("symbol"),
            "mode": mode, "entry_price": entry_price, "size_sol": size,
            "liquidity_at_entry": liq, "stop_loss_pct": self.sl_pct,
            "take_profit_pct": self.tp_pct, "status": "OPEN", "pnl_pct": 0.0, "pnl_sol": 0.0,
            "closed_at": None, "close_reason": None, "_pump_score": pump_score,
            "_safety_score": safety["score"], "_failures": [],
        }
        self.trades.append(trade)
        return trade

    def step(self):
        updates = []
        now_dt = datetime.utcnow().timestamp()
        for trade in self.trades:
            if trade.get("status") != "OPEN": continue
            pump = trade.get("_pump_score", 0.5)
            liq = trade.get("liquidity_at_entry", 10000)
            sl = trade.get("stop_loss_pct", 0.06)
            tp = trade.get("take_profit_pct", 0.15)
            age = now_dt - datetime.fromisoformat(trade["timestamp"]).timestamp()
            if pump > 0.55:
                drift = (pump - 0.4) * 0.8; noise = random.uniform(-0.08, 0.25)
            else:
                drift = (pump - 0.5) * 0.3; noise = random.uniform(-0.20, 0.10)
            move = drift + noise
            if move < -sl * 1.5: move = -sl * random.uniform(0.7, 1.1)
            elif move > tp * 2.0: move = tp * random.uniform(0.8, 1.5)
            rw = RealWorldFailureModel.apply_real_world_friction(move, trade["size_sol"], liq)
            trade["pnl_pct"] = rw["adjusted_pnl"]; trade["_failures"] = rw["failures"]
            trade["pnl_sol"] = trade["size_sol"] * trade["pnl_pct"]
            if trade["pnl_pct"] >= tp:
                trade["status"] = "CLOSED"; trade["close_reason"] = f"TP_{tp*100:.0f}pct"
                self.consecutive_wins += 1; self.consecutive_losses = 0; updates.append(trade); continue
            if trade["pnl_pct"] <= -sl:
                trade["status"] = "CLOSED"; trade["close_reason"] = f"SL_{sl*100:.0f}pct"
                self.consecutive_wins = 0; self.consecutive_losses += 1; updates.append(trade); continue
            if age > 600:
                trade["pnl_pct"] = 0.02; trade["pnl_sol"] = trade["size_sol"] * 0.02
                trade["status"] = "CLOSED"; trade["close_reason"] = "TIME"
                self.consecutive_wins += 1; self.consecutive_losses = 0; updates.append(trade)
        return updates

    def summary(self):
        closed = [t for t in self.trades if t.get("status") == "CLOSED"]
        wins = [t for t in closed if (t.get("pnl_pct") or 0) > 0]
        losses = [t for t in closed if (t.get("pnl_pct") or 0) <= 0]
        total_pnl = sum(t.get("pnl_sol", 0) for t in closed)
        all_fails = []; [all_fails.extend(t.get("_failures", [])) for t in closed]
        fail_cnt = {}
        for f in all_fails: ft = f.split("(")[0]; fail_cnt[ft] = fail_cnt.get(ft, 0) + 1
        return {"total": len(self.trades), "closed": len(closed), "wins": len(wins),
                "losses": len(losses), "win_rate": (len(wins)/len(closed)*100) if closed else 0,
                "balance": round(1.0 + total_pnl, 4), "total_fails": len(all_fails), "failure_types": fail_cnt}

def simulated_market():
    base_names = ["MEME","DOGE","PEPE","SHIB","FROG","CAT","BONK","WIF","POP"]
    while True:
        name = random.choice(base_names) + str(random.randint(100, 9999))
        price = round(random.uniform(0.000001, 0.01), 8)
        liquidity = random.uniform(2000, 400000)
        volume_24h = liquidity * random.uniform(0.5, 6)
        age_seconds = random.uniform(5, 300)
        pump_score = random.random()
        is_good = pump_score > 0.55
        if is_good:
            buys_5m = random.randint(40, 200); sells_5m = random.randint(1, int(buys_5m * 0.4))
            vol_momentum = random.uniform(1.5, 5.0); price_change_5m = random.uniform(3, 40)
            bsr = random.uniform(1.5, 4.0)
        else:
            buys_5m = random.randint(5, 50); sells_5m = random.randint(int(buys_5m * 0.6), int(buys_5m * 1.8))
            vol_momentum = random.uniform(0.2, 1.2); price_change_5m = random.uniform(-15, 5)
            bsr = random.uniform(0.3, 1.2)
        buy_pressure = buys_5m / (buys_5m + sells_5m + 1)
        tx_velocity = (buys_5m + sells_5m) * 12
        token = {"address": name, "symbol": name, "price": price, "liquidity": liquidity,
                 "volume_5m": volume_24h * random.uniform(0.05, 0.2), "volume_24h": volume_24h,
                 "buys_5m": buys_5m, "sells_5m": sells_5m, "age_seconds": age_seconds,
                 "fdv": liquidity * random.uniform(5, 50), "_pump_score": pump_score}
        features = {"age_seconds": age_seconds, "liquidity_usd": liquidity,
                    "volume_change_1m": vol_momentum, "price_change_5m": price_change_5m,
                    "buy_pressure_5m": buy_pressure, "buy_sell_ratio": bsr,
                    "tx_velocity_per_hour": tx_velocity, "liq_to_mcap": liquidity / (token["fdv"] + 1)}
        yield token, features

def analyze(features, pump_score, signal_mult=1.0):
    liq = features.get("liquidity_usd", 0); age = features.get("age_seconds", 99999)
    bsr = features.get("buy_sell_ratio", 1.0); vol_m = features.get("volume_change_1m", 0)
    bp = features.get("buy_pressure_5m", 0.5); pc = features.get("price_change_5m", 0)
    tx_v = features.get("tx_velocity_per_hour", 0); ltm = features.get("liq_to_mcap", 0)
    if liq < 5000 or bsr < 0.85 or ltm < 0.005: return None
    if age < 90 and pump_score > 0.75 and bp > 0.60 and bsr > 1.5 and vol_m > 1.5:
        return {"action": "BUY", "size_sol": 0.10 * signal_mult, "mode": "SNIPER"}
    if pump_score > 0.80 and vol_m > 2.0 and pc > 5 and tx_v > 100 and bp > 0.55:
        return {"action": "BUY", "size_sol": 0.08 * signal_mult, "mode": "MG"}
    if pump_score > 0.85 and bp > 0.60 and liq > 10000 and bsr > 1.6:
        return {"action": "BUY", "size_sol": 0.06 * signal_mult, "mode": "HWR"}
    return None

def run_sim(kelly, cp, max_risk, tp, sl, signal_mult, n_trades=100):
    exec = RealWorldPaperExecutor(kelly=kelly, compound_power=cp, max_risk=max_risk, tp_pct=tp, sl_pct=sl)
    market = simulated_market(); fired = 0
    while fired < n_trades:
        token, features = next(market)
        signal = analyze(features, token["_pump_score"], signal_mult)
        if signal:
            if exec.execute_trade(token, signal["mode"], signal): fired += 1
        exec.step()
    return exec.summary()

import argparse
parser = argparse.ArgumentParser(description="Test 1000x potential")
parser.add_argument("--kelly", type=float, default=0.5, help="Kelly fraction")
parser.add_argument("--cp", type=float, default=2.0, help="Compound power")
parser.add_argument("--max-risk", type=float, default=0.40, help="Max account risk pct")
parser.add_argument("--tp", type=float, default=0.15, help="Take profit pct")
parser.add_argument("--sl", type=float, default=0.06, help="Stop loss pct")
parser.add_argument("--signal-mult", type=float, default=1.0, help="Signal size multiplier")
parser.add_argument("--trades", type=int, default=100, help="Trades per run")
parser.add_argument("--runs", type=int, default=20, help="Monte Carlo runs")
parser.add_argument("--label", type=str, default="", help="Config label")
args = parser.parse_args()

if args.label: print(f"\n  === {args.label} ===")
print(f"  kelly={args.kelly}, cp={args.cp}, max_risk={args.max_risk}, tp={args.tp}, sl={args.sl}, signal_x{args.signal_mult}")

results = [run_sim(args.kelly, args.cp, args.max_risk, args.tp, args.sl, args.signal_mult, args.trades) for _ in range(args.runs)]
bals = [r["balance"] for r in results]
wrs = [r["win_rate"] for r in results]
med = sorted(bals)[len(bals)//2]; mean = sum(bals)/len(bals)
wr = sum(wrs)/len(wrs)
prof = sum(1 for r in results if r["balance"] >= 1.0)
over100 = sum(1 for r in results if r["balance"] >= 100)
over1000 = sum(1 for r in results if r["balance"] >= 1000)
print(f"  Median: {med:.1f}x | Mean: {mean:.1f}x | Max: {max(bals):.1f}x | WR: {wr:.1f}% | Profitable: {prof}/{args.runs} | >=100x: {over100}/{args.runs} | >=1000x: {over1000}/{args.runs}")
