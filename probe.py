#!/usr/bin/env python3
"""
A-DSL Data-Source Scan — Bitquery Solana archive depth probe.
Measures how far back the archive serves data on THIS key. No trading logic.
"""
import os, requests
from datetime import datetime, timedelta
from dotenv import load_dotenv

load_dotenv()
KEY = os.getenv("BITQUERY_API_KEY")
URL = "https://streaming.bitquery.io/graphql"
HEADERS = {"Authorization": f"Bearer {KEY}", "Content-Type": "application/json"}
SOL = "So11111111111111111111111111111111111111112"

def probe(hours_ago, span_h=1):
    since = (datetime.utcnow() - timedelta(hours=hours_ago)).isoformat() + "Z"
    till  = (datetime.utcnow() - timedelta(hours=hours_ago - span_h)).isoformat() + "Z"
    q = """
    {
      Solana {
        DEXTradeByTokens(
          where: {
            Trade: { Side: { Currency: { MintAddress: { is: "%s" } } } }
            Block: { Time: { since: "%s", till: "%s" } }
          }
          orderBy: { descendingByField: "Trade_count" }
          limit: { count: 10 }
        ) {
          Trade { Currency { Symbol } }
          Trade_count: count
        }
      }
    }
    """ % (SOL, since, till)
    try:
        r = requests.post(URL, json={"query": q}, headers=HEADERS, timeout=60)
        r.raise_for_status()
        j = r.json()
        if j.get("errors"):
            return f"ERROR {j['errors']}"
        rows = (j.get("data") or {}).get("Solana", {}).get("DEXTradeByTokens") or []
        if not rows:
            return "0 tokens (no data at this depth)"
        top = rows[0]
        sym = top["Trade"]["Currency"].get("Symbol") or "???"
        return f"{len(rows)} tokens | top: {sym} ({top['Trade_count']} trades)"
    except Exception as e:
        return f"FAIL {e}"

if __name__ == "__main__":
    if not KEY:
        raise SystemExit("BITQUERY_API_KEY not set in .env")
    print("Bitquery Solana archive depth probe — 1h window at each lookback\n")
    for label, h in [("~6 hours", 6), ("~1 day", 24), ("~3 days", 72),
                     ("~7 days", 168), ("~14 days", 336), ("~30 days", 720),
                     ("~60 days", 1440), ("~90 days", 2160)]:
        print(f"  {label:>10} ago : {probe(h)}")