import aiohttp
class HeliusClient:
    def __init__(self, api_key):
        self.api_key = api_key
        self.rpc_url = f"https://mainnet.helius-rpc.com/?api-key={api_key}"
    async def get_token_accounts(self, owner):
        payload = {"jsonrpc": "2.0", "id": 1, "method": "getTokenAccountsByOwner", "params": [owner, {"programId": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"}, {"encoding": "jsonParsed"}]}
        async with aiohttp.ClientSession() as session:
            async with session.post(self.rpc_url, json=payload) as resp: return await resp.json()
