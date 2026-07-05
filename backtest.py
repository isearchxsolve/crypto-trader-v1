#!/usr/bin/env python3
"""
Phase E-DSL Backtest v7 — Convergence Framework (single retrospective run)

The data source is the ORACLE. Bitquery's Solana archive serves ~7 days of
history (probe: data present at 7d, empty at 14d). We pull the entire >=30
candidate sample in ONE run by sweeping several historical entry snapshots
across the last ~6 days. No daily accumulation. No CSV append. No cumulative.

Setup:
  pip install requests pandas python-dotenv
  .env: BITQUERY_API_KEY=...
  python backtest.py
"""
import os, time, requests
import pandas as pd
from datetime import datetime, timedelta
from dotenv import load_dotenv

load_dotenv()

# ============================== CONFIG ==============================
BITQUERY_KEY = os.getenv("BITQUERY_API_KEY")
BITQUERY_URL = "https://streaming.bitquery.io/graphql"
HEADERS = {"Authorization": f"Bearer {BITQUERY_KEY}", "Content-Type": "application/json"}
SOL_MINT = "So11111111111111111111111111111111111111112"

# Historical sweep. Archive horizon ~7d (168h); stay <=150h for safety margin.
ENTRY_POINTS_HA = [150, 132, 114, 96, 78, 60, 42, 24]  # hours-ago per entry snapshot
ENTRY_SPAN_H = 12     # width of each entry snapshot
HOLD_H       = 12     # entry start -> exit start (hold horizon)
EXIT_SPAN_H  = 6      # width of each exit snapshot
TOP_N        = 500    # free-tier max rows per query

EDGE_MIN_SCORE  = 95
MIN_LIQ_USD     = 100_000
STOP_LOSS_PCT   = -15.0
MARGIN_REQUIRED = 1.0
MIN_SAMPLE_N    = 30
RATE_SLEEP_S    = 7    # free tier ~10 req/min -> ~1 call / 7s


# ============================== HELPERS ==============================
def bq(query, label=""):
    try:
        r = requests.post(BITQUERY_URL, json={"query": query}, headers=HEADERS, timeout=90)
        r.raise_for_status()
        resp = r.json()
        if resp.get("errors"):
            print(f"  [BQ ERR {label}] {resp['errors']}")
        return resp.get("data")
    except Exception as e:
        print(f"  [BQ FAIL {label}] {e}")
        return None
    finally:
        time.sleep(RATE_SLEEP_S)

def iso(hours_ago):
    return (datetime.utcnow() - timedelta(hours=hours_ago)).isoformat() + "Z"


# ============================== QUERIES ==============================
def entry_snapshot(start_ha, span_h):
    since = iso(start_ha)
    till  = iso(start_ha - span_h)
    q = """
    {
      Solana {
        DEXTradeByTokens(
          where: {
            Trade: { Side: { Currency: { MintAddress: { is: "%s" } } } }
            Block: { Time: { since: "%s", till: "%s" } }
          }
          orderBy: { descendingByField: "tx_count" }
          limit: { count: %d }
        ) {
          Trade { Currency { Symbol MintAddress } }
          tx_count:   count
          buy_count:  count(if: { Trade: { Side: { Type: { is: buy  } } } })
          sell_count: count(if: { Trade: { Side: { Type: { is: sell } } } })
          volume_usd: sum(of: Trade_Side_AmountInUSD)
          avg_price:  average(of: Trade_Price)
        }
      }
    }
    """ % (SOL_MINT, since, till, TOP_N)
    data = bq(q, f"entry@{start_ha}h")
    if not data:
        return []
    return data["Solana"]["DEXTradeByTokens"] or []

def exit_prices(start_ha, span_h, mints=None):
    since = iso(start_ha)
    till  = iso(start_ha - span_h)
    token_filter = ""
    if mints:
        lst = ", ".join('"%s"' % m for m in mints)
        token_filter = 'Currency: { MintAddress: { in: [%s] } }' % lst
    q = """
    {
      Solana {
        DEXTradeByTokens(
          where: {
            Trade: { Side: { Currency: { MintAddress: { is: "%s" } } } %s }
            Block: { Time: { since: "%s", till: "%s" } }
          }
          orderBy: { descendingByField: "tx_count" }
          limit: { count: %d }
        ) {
          Trade { Currency { MintAddress } }
          tx_count:  count
          avg_price: average(of: Trade_Price)
        }
      }
    }
    """ % (SOL_MINT, token_filter, since, till, TOP_N)
    data = bq(q, f"exit@{start_ha}h")
    out = {}
    if not data:
        return out
    for row in data["Solana"]["DEXTradeByTokens"] or []:
        m = row["Trade"]["Currency"]["MintAddress"]
        v = row.get("avg_price")
        if v:
            out[m] = float(v)
    return out


# ============================== SCORE + GATE ==============================
def reconstruct_score(buy_count, sell_count, volume_usd):
    bsr = buy_count / max(sell_count, 1)
    raw = min(bsr * 20, 40) + min(volume_usd / 1000, 25)   # move component omitted
    return round(min(raw / 65 * 100, 100))                  # renormalize: max = 65

def objective_gate(score, liq_usd):
    if score < EDGE_MIN_SCORE:
        return False, 0.0
    if   liq_usd < 15_000:  peak = 5.0
    elif liq_usd < 25_000:  peak = 6.0
    elif liq_usd < 50_000:  peak = 8.0
    elif liq_usd < 100_000: peak = 10.0
    else:                    peak = 12.0
    capture = 1.00 if score >= 90 else (0.85 if score >= 80 else 0.70)
    if   liq_usd < 2_000:   base_slip = 8.0
    elif liq_usd < 5_000:   base_slip = 5.0
    elif liq_usd < 20_000:  base_slip = 2.5
    elif liq_usd < 50_000:  base_slip = 0.6
    elif liq_usd < 200_000: base_slip = 0.3
    else:                    base_slip = 0.2
    entry_slip = base_slip + 0.5
    exit_slip  = base_slip * 1.3 + 0.5
    net_ev = peak * capture - (entry_slip + exit_slip + 1.0)
    return (net_ev > MARGIN_REQUIRED), round(net_ev, 3)

def realized_ev(entry_price, exit_price, liq_usd, alive):
    if not alive or not exit_price or not entry_price or entry_price <= 0:
        return STOP_LOSS_PCT
    gross = (exit_price - entry_price) / entry_price * 100
    cost = 1.7 if liq_usd >= 200_000 else (2.1 if liq_usd >= 50_000 else 4.4)
    return round(max(gross - cost, STOP_LOSS_PCT), 3)


# ============================== BACKTEST ==============================
def run_backtest():
    print("Phase E-DSL Backtest v7 — single retrospective run")
    print(f"Archive sweep : {len(ENTRY_POINTS_HA)} entry snapshots across last {max(ENTRY_POINTS_HA)}h")
    print(f"Gate          : score >= {EDGE_MIN_SCORE}, liq >= ${MIN_LIQ_USD:,.0f}, hold {HOLD_H}h\n")

    all_rows = {}   # dedup by mint across snapshots
    for e in ENTRY_POINTS_HA:
        entry = entry_snapshot(e, ENTRY_SPAN_H)
        passers = []
        for row in entry:
            mint   = row["Trade"]["Currency"]["MintAddress"]
            symbol = row["Trade"]["Currency"]["Symbol"] or "???"
            buy  = float(row.get("buy_count")  or 0)
            sell = float(row.get("sell_count") or 1)
            vol  = float(row.get("volume_usd") or 0)
            ep   = float(row.get("avg_price") or 0) or None
            liq  = vol / (ENTRY_SPAN_H * 1.67)   # window-invariant liquidity proxy
            score = reconstruct_score(buy, sell, vol)
            ok, model_ev = objective_gate(score, liq)
            if not ok or liq < MIN_LIQ_USD:
                continue
            passers.append({"mint": mint, "symbol": symbol, "score": score,
                            "liq_usd": liq, "model_ev": model_ev, "entry_price": ep})
        if not passers:
            print(f"  [{e:>3}h ago] 0 gate-passers")
            continue

        # Exact exit price for exactly these mints (no top-500 false-death artifact)
        px = exit_prices(e - HOLD_H, EXIT_SPAN_H, [p["mint"] for p in passers])
        if not px:  # in-filter empty/unsupported -> fall back to top-500 match for this window
            px = exit_prices(e - HOLD_H, EXIT_SPAN_H, None)

        new = 0
        for p in passers:
            xp = px.get(p["mint"])
            alive = xp is not None
            p["exit_price"]  = xp
            p["survival"]    = "live" if alive else "dead"
            p["realized_ev"] = realized_ev(p["entry_price"], xp, p["liq_usd"], alive)
            if p["mint"] not in all_rows:   # dedup: first occurrence wins
                all_rows[p["mint"]] = p
                new += 1
        print(f"  [{e:>3}h ago] {len(passers)} gate-passers, {new} new unique")

    return pd.DataFrame(list(all_rows.values()))


# ============================== EVALUATE ==============================
def evaluate_results(df):
    print(f"\n{'='*60}")
    print("  PHASE E-DSL RESULTS — v7 (single retrospective run)")
    print(f"{'='*60}")
    if df.empty:
        print("  NO CANDIDATES. Check [BQ ERR] lines above.")
        return

    n = len(df)
    ev = df["realized_ev"]
    mean_ev   = ev.mean()
    median_ev = ev.median()
    win_rate  = (ev > 0).mean() * 100
    dead_rate = (df["survival"] == "dead").mean() * 100
    corr = df["model_ev"].corr(df["realized_ev"]) if (n > 2 and df["model_ev"].std() > 0) else float("nan")
    mean_ex_top = ev[ev < ev.max()].mean() if n > 1 else float("nan")

    print(f"  N unique candidates : {n}")
    print(f"  Mean realized EV    : {mean_ev:+.2f}%")
    print(f"  Median realized EV  : {median_ev:+.2f}%")
    print(f"  Mean EV (drop top)  : {mean_ex_top:+.2f}%   (outlier-robustness)")
    print(f"  Win rate            : {win_rate:.1f}%")
    print(f"  Dead/rugged rate    : {dead_rate:.1f}%")
    print(f"  Model vs realized r : {corr:.3f}")
    print(f"{'='*60}")

    checks = {
        f"N >= {MIN_SAMPLE_N}":      n >= MIN_SAMPLE_N,
        "Mean EV > +1.0%":          mean_ev > MARGIN_REQUIRED,
        "Win rate > 40%":           win_rate > 40,
        "Dead/rugged rate < 30%":   dead_rate < 30,
        "Model corr > 0.3":         (corr > 0.3) if not pd.isna(corr) else False,
    }
    print("\n  Framework criteria (ALL must pass to resolve OD-1):")
    for k, v in checks.items():
        print(f"    [{'PASS' if v else 'FAIL'}] {k}")

    if all(checks.values()):
        print("\n  VERDICT: DSL PASSED — OD-1 RESOLVED.")
    else:
        print("\n  VERDICT: DSL FAILED — do not go live yet.")

    # Objective-level read (Phase 0: objective = mean net EV per trade)
    print(f"\n  Objective read: mean EV {mean_ev:+.2f}%; {mean_ex_top:+.2f}% even without the single best trade.")
    band = df[(df["score"] >= 95) & (df["score"] <= 100)]
    if not band.empty:
        bwin = (band["realized_ev"] > 0).mean() * 100
        print(f"  Score 95-100: n={len(band)}  mean_ev={band['realized_ev'].mean():+.2f}%  win={bwin:.1f}%")
    print(f"{'='*60}\n")


# ============================== MAIN ==============================
if __name__ == "__main__":
    if not BITQUERY_KEY:
        raise SystemExit("\n[ERROR] BITQUERY_API_KEY not set in .env\n")
    df = run_backtest()
    df.to_csv("dsl_v7_results.csv", index=False)   # single run, OVERWRITE (no append)
    evaluate_results(df)