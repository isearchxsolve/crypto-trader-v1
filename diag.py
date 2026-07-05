#!/usr/bin/env python3
"""
A-DSL diagnostic #2 — isolate WHY a 12h window returns 0 rows when the 1h probe
returned data. Small matrix (window width x field set x limit) at the same
24h-ago start. Prints row counts only. Inspecting the oracle; changing nothing.
"""
import os, time, requests
from datetime import datetime, timedelta
from dotenv import load_dotenv

load_dotenv()
KEY = os.getenv("BITQUERY_API_KEY")
URL = "https://streaming.bitquery.io/graphql"
HEADERS = {"Authorization": f"Bearer {KEY}", "Content-Type": "application/json"}
SOL = "So11111111111111111111111111111111111111112"
START_HA = 24

def iso(h):
    return (datetime.utcnow() - timedelta(hours=h)).isoformat() + "Z"

MINIMAL = """
      Trade { Currency { Symbol } }
      tx_count: count
"""
FULL = """
      Trade { Currency { Symbol MintAddress } }
      tx_count:   count
      buy_count:  count(if: { Trade: { Side: { Type: { is: buy  } } } })
      sell_count: count(if: { Trade: { Side: { Type: { is: sell } } } })
      volume_usd: sum(of: Trade_Side_AmountInUSD)
      avg_price:  average(of: Trade_Price)
"""

def run(span_h, fields, limit, label):
    since = iso(START_HA)
    till  = iso(START_HA - span_h)
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
        ) {%s}
      }
    }
    """ % (SOL, since, till, limit, fields)
    try:
        r = requests.post(URL, json={"query": q}, headers=HEADERS, timeout=90)
        j = r.json()
        if j.get("errors"):
            print(f"  {label:<44} ERROR: {j['errors'][0]['message'][:80]}")
            return
        rows = (j.get("data") or {}).get("Solana", {}).get("DEXTradeByTokens") or []
        print(f"  {label:<44} rows = {len(rows)}")
    except Exception as e:
        print(f"  {label:<44} FAIL: {e}")
    finally:
        time.sleep(2)

if __name__ == "__main__":
    print(f"Matrix at start = {START_HA}h ago (window goes start -> start-span)\n")
    run(1,  MINIMAL, 10,  "A: 1h  window | minimal | limit 10  (probe control)")
    run(1,  MINIMAL, 500, "B: 1h  window | minimal | limit 500")
    run(1,  FULL,    500, "C: 1h  window | FULL    | limit 500")
    run(12, MINIMAL, 10,  "D: 12h window | minimal | limit 10")
    run(12, MINIMAL, 500, "E: 12h window | minimal | limit 500")
    run(12, FULL,    500, "F: 12h window | FULL    | limit 500 (v7 config)")