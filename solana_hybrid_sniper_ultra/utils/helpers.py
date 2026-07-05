import base58
def is_valid_sol_address(address):
    try:
        decoded = base58.b58decode(address)
        return len(decoded) == 32
    except: return False
