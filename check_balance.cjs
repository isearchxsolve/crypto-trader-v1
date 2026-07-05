const { Keypair, Connection, LAMPORTS_PER_SOL } = require('@solana/web3.js');
const bs58 = require('bs58');

const privateKeyBase58 = 'DHt9ipNNB5KmqDv87etG3kfvCU9dsVQcyo13t2U33RHDc7ik3Frex5FuoD5K4veqRJ58zVNaPQm3Kd5EcCcCDzx';

async function main() {
  try {
    const decoded = bs58.decode(privateKeyBase58);
    const keypair = Keypair.fromSecretKey(decoded);
    const pubkey = keypair.publicKey.toBase58();
    console.log('PUBLIC KEY (wallet address):', pubkey);

    // Check balance via Helius
    const conn = new Connection('https://mainnet.helius-rpc.com/?api-key=85a848b0-d314-4477-a123-1a294ac0908b', 'confirmed');
    const lamports = await conn.getBalance(keypair.publicKey);
    console.log(`ON-CHAIN BALANCE: ${lamports} lamports = ${(lamports / LAMPORTS_PER_SOL).toFixed(6)} SOL`);
  } catch(e) {
    console.error('ERROR:', e.message);
  }
}
main();
