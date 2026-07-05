import os, requests
from dotenv import load_dotenv
load_dotenv()

KEY = os.getenv("BITQUERY_API_KEY")
URL = "https://streaming.bitquery.io/graphql"
HEADERS = {"Authorization": f"Bearer {KEY}", "Content-Type": "application/json"}

# Minimal test query
query = """
{
  Solana {
    DEXTradeByTokens(
      where: {
        Trade: {
          Side: { Currency: { MintAddress: { is: "So11111111111111111111111111111111111111112" } } }
        }
      }
      limit: { count: 3 }
    ) {
      Trade { Currency { Symbol MintAddress } }
      Trade_count: count
    }
  }
}
"""

r = requests.post(URL, json={"query": query}, headers=HEADERS, timeout=30)
print("Status:", r.status_code)
print("Response:", r.text[:2000])