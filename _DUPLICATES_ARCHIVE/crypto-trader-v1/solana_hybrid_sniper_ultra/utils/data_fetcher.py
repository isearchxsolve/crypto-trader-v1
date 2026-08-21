import aiohttp
import asyncio
import time
import logging

logger = logging.getLogger("DataFetcher")

SOL_WRAPPED = "So11111111111111111111111111111111111111112"

class DataFetcher:
    def __init__(self):
        self.profiles_url = "https://api.dexscreener.com/token-profiles/latest/v1"
        self.pairs_url = "https://api.dexscreener.com/latest/dex/pairs/solana"
        self.search_url = "https://api.dexscreener.com/latest/dex/search"
        self.token_url = "https://api.dexscreener.com/latest/dex/tokens"
        self.seen_pairs = set()
        self.session = None

    async def _get_session(self):
        if self.session is None or self.session.closed:
            timeout = aiohttp.ClientTimeout(total=10)
            self.session = aiohttp.ClientSession(timeout=timeout)
        return self.session

    async def _safe_get(self, url):
        try:
            session = await self._get_session()
            async with session.get(url) as resp:
                if resp.status == 200:
                    return await resp.json()
                elif resp.status == 429:
                    logger.warning("Rate limited by DexScreener, waiting 5s...")
                    await asyncio.sleep(5)
                    return None
                else:
                    logger.warning(f"DexScreener returned status {resp.status} for {url}")
                    return None
        except asyncio.TimeoutError:
            logger.warning(f"Timeout fetching {url}")
            return None
        except Exception as e:
            logger.error(f"Error fetching {url}: {e}")
            return None

    async def get_new_listings(self):
        tokens = []

        profiles = await self._safe_get(self.profiles_url)
        if profiles and isinstance(profiles, list):
            solana_tokens = [t for t in profiles if t.get("chainId") == "solana"]

            for token_profile in solana_tokens[:10]:
                address = token_profile.get("tokenAddress", "")
                if not address or address in self.seen_pairs:
                    continue

                pair_data = await self.get_pair_data_for_token(address)
                if pair_data:
                    self.seen_pairs.add(address)
                    tokens.append(pair_data)

                await asyncio.sleep(0.3)

        if not tokens:
            data = await self._safe_get(f"{self.search_url}?q=pump")
            if data and "pairs" in data:
                solana_pairs = [p for p in data["pairs"] if p.get("chainId") == "solana"]
                for pair in solana_pairs[:8]:
                    parsed = self._parse_pair(pair)
                    if parsed and parsed["address"] not in self.seen_pairs:
                        self.seen_pairs.add(parsed["address"])
                        tokens.append(parsed)

        if len(self.seen_pairs) > 500:
            self.seen_pairs = set(list(self.seen_pairs)[-100:])

        return tokens

    async def get_pair_data_for_token(self, token_address):
        data = await self._safe_get(f"{self.token_url}/{token_address}")
        if not data or "pairs" not in data or not data["pairs"]:
            return None

        solana_pairs = [p for p in data["pairs"] if p.get("chainId") == "solana"]
        if not solana_pairs:
            return None

        best_pair = max(solana_pairs, key=lambda p: (p.get("liquidity") or {}).get("usd", 0))
        return self._parse_pair(best_pair)

    def _parse_pair(self, pair):
        try:
            base = pair.get("baseToken", {})
            liq = pair.get("liquidity") or {}
            vol = pair.get("volume") or {}
            txns = pair.get("txns") or {}
            price_change = pair.get("priceChange") or {}

            m5_txns = txns.get("m5", {})
            h1_txns = txns.get("h1", {})
            h24_txns = txns.get("h24", {})

            created_at = pair.get("pairCreatedAt")
            age_seconds = (time.time() * 1000 - created_at) / 1000 if created_at else 99999

            m5_buys = m5_txns.get("buys", 0)
            m5_sells = m5_txns.get("sells", 0)
            h1_buys = h1_txns.get("buys", 0)
            h1_sells = h1_txns.get("sells", 0)
            h24_buys = h24_txns.get("buys", 0)
            h24_sells = h24_txns.get("sells", 0)

            return {
                "symbol": base.get("symbol", "???"),
                "name": base.get("name", ""),
                "address": base.get("address", ""),
                "pair_address": pair.get("pairAddress", ""),
                "dex": pair.get("dexId", ""),
                "price": float(pair.get("priceUsd", 0) or 0),
                "price_native": float(pair.get("priceNative", 0) or 0),
                "created_at": (created_at / 1000) if created_at else time.time(),
                "age_seconds": age_seconds,
                "liquidity": liq.get("usd", 0) or 0,
                "volume_5m": vol.get("m5", 0) or 0,
                "volume_1h": vol.get("h1", 0) or 0,
                "volume_6h": vol.get("h6", 0) or 0,
                "volume_24h": vol.get("h24", 0) or 0,
                "price_change_5m": price_change.get("m5", 0) or 0,
                "price_change_1h": price_change.get("h1", 0) or 0,
                "price_change_6h": price_change.get("h6", 0) or 0,
                "price_change_24h": price_change.get("h24", 0) or 0,
                "buys_5m": m5_buys,
                "sells_5m": m5_sells,
                "buys_1h": h1_buys,
                "sells_1h": h1_sells,
                "buys_24h": h24_buys,
                "sells_24h": h24_sells,
                "fdv": pair.get("fdv", 0) or 0,
                "market_cap": pair.get("marketCap", 0) or 0,
            }
        except Exception as e:
            logger.error(f"Error parsing pair: {e}")
            return None

    async def get_market_depth(self, address):
        data = await self._safe_get(f"{self.token_url}/{address}")
        if not data or "pairs" not in data or not data["pairs"]:
            return {"bids": 0, "asks": 0, "volume_24h": 0, "liquidity_usd": 0}

        solana_pairs = [p for p in data["pairs"] if p.get("chainId") == "solana"]
        if not solana_pairs:
            return {"bids": 0, "asks": 0, "volume_24h": 0, "liquidity_usd": 0}

        pair = solana_pairs[0]
        txns_h1 = (pair.get("txns") or {}).get("h1", {})
        vol = pair.get("volume") or {}
        liq = pair.get("liquidity") or {}

        return {
            "bids": txns_h1.get("buys", 0),
            "asks": txns_h1.get("sells", 0),
            "volume_24h": vol.get("h24", 0) or 0,
            "liquidity_usd": liq.get("usd", 0) or 0,
        }

    def process_features(self, token, market):
        vol_5m = token.get("volume_5m", 0)
        vol_1h = token.get("volume_1h", 0)
        buys_5m = token.get("buys_5m", 0)
        sells_5m = token.get("sells_5m", 0)
        buys_1h = token.get("buys_1h", 0)
        sells_1h = token.get("sells_1h", 0)
        liq = token.get("liquidity", 0)
        age = token.get("age_seconds", 99999)

        vol_momentum = vol_5m / (vol_1h / 12 + 1e-9) if vol_1h > 0 else 0
        buy_pressure_5m = buys_5m / (buys_5m + sells_5m + 1e-9)
        buy_pressure_1h = buys_1h / (buys_1h + sells_1h + 1e-9)
        tx_velocity = (buys_5m + sells_5m) * 12

        return {
            "age_seconds": age,
            "liquidity_usd": liq,
            "volume_5m": vol_5m,
            "volume_1h": vol_1h,
            "volume_24h": token.get("volume_24h", 0),
            "volume_change_1m": vol_momentum,
            "price_change_5m": token.get("price_change_5m", 0),
            "price_change_1h": token.get("price_change_1h", 0),
            "price_change_24h": token.get("price_change_24h", 0),
            "buy_pressure_5m": buy_pressure_5m,
            "buy_pressure_1h": buy_pressure_1h,
            "buy_sell_ratio": buys_1h / (sells_1h + 1e-9),
            "tx_velocity_per_hour": tx_velocity,
            "fdv": token.get("fdv", 0),
            "market_cap": token.get("market_cap", 0),
            "liq_to_mcap": liq / (token.get("fdv", 0) or token.get("market_cap", 1) + 1e-9),
        }

    async def close(self):
        if self.session and not self.session.closed:
            await self.session.close()
