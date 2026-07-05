from solders.keypair import Keypair
from solders.pubkey import Pubkey
class SolanaWallet:
    def __init__(self, private_key_base58=None):
        if private_key_base58: self.keypair = Keypair.from_base58_string(private_key_base58)
        else: self.keypair = Keypair()
    def get_address(self): return str(self.keypair.pubkey())
