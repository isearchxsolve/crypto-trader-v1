import aiohttp
import logging

logger = logging.getLogger("JupiterSwap")

class JupiterSwap:
    def __init__(self):
        self.quote_url = "https://quote-api.jup.ag/v6"
        self.swap_url = "https://quote-api.jup.ag/v6/swap"

    async def get_quote(self, input_mint, output_mint, amount, slippage=500):
        url = f"{self.quote_url}/quote?inputMint={input_mint}&outputMint={output_mint}&amount={amount}&slippageBps={slippage}"
        async with aiohttp.ClientSession() as session:
            async with session.get(url) as resp:
                data = await resp.json()
                if resp.status != 200:
                    return {"error": data.get("error", "Unknown quote error")}
                return data

    async def execute_swap(self, quote_response, private_key_base58):
        if not private_key_base58:
            logger.error("No private key configured for live trading")
            return {"success": False, "error": "No private key"}

        payload = {
            "quoteResponse": quote_response,
            "userPublicKey": self._get_pubkey_from_private(private_key_base58),
            "wrapAndUnwrapSol": True,
            "dynamicComputeUnitLimit": True,
            "prioritizationFeeLamports": "auto"
        }

        async with aiohttp.ClientSession() as session:
            async with session.post(self.swap_url, json=payload) as resp:
                data = await resp.json()
                if resp.status != 200:
                    return {"success": False, "error": data.get("error", "Swap API error")}

                swap_transaction = data.get("swapTransaction")
                if not swap_transaction:
                    return {"success": False, "error": "No swap transaction returned"}

                txid = await self._send_transaction(swap_transaction, private_key_base58)
                return {"success": bool(txid), "txid": txid}

    def _get_pubkey_from_private(self, private_key_base58):
        try:
            from solders.keypair import Keypair
            kp = Keypair.from_base58_string(private_key_base58)
            return str(kp.pubkey())
        except Exception as e:
            logger.error(f"Failed to derive pubkey: {e}")
            return ""

    async def _send_transaction(self, swap_transaction_b64, private_key_base58):
        try:
            from solders.keypair import Keypair
            from solders.transaction import VersionedTransaction
            import base64 as b64

            raw_tx = b64.b64decode(swap_transaction_b64)
            tx = VersionedTransaction.from_bytes(raw_tx)

            keypair = Keypair.from_base58_string(private_key_base58)
            signed_tx = VersionedTransaction(tx.message, [keypair])
            serialized = bytes(signed_tx)

            rpc_url = "https://api.mainnet-beta.solana.com"
            payload = {
                "jsonrpc": "2.0",
                "id": 1,
                "method": "sendTransaction",
                "params": [
                    b64.b64encode(serialized).decode("utf-8"),
                    {"skipPreflight": True, "encoding": "base64", "maxRetries": 3}
                ]
            }

            async with aiohttp.ClientSession() as session:
                async with session.post(rpc_url, json=payload) as resp:
                    result = await resp.json()
                    if "result" in result:
                        txid = result["result"]
                        logger.info(f"Transaction sent: {txid}")
                        return txid
                    else:
                        logger.error(f"Send failed: {result.get('error', {})}")
                        return None
        except Exception as e:
            logger.error(f"Transaction signing/sending failed: {e}")
            return None
