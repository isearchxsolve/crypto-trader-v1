// Test: what events does Helius Enhanced TX API return for Raydium program?
// Docs say base URL: https://mainnet.helius-rpc.com (NOT api.helius.xyz)

const RAYDIUM_V4 = '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8';

async function main() {
  const keys = (process.env.HELIUS_KEYS || '').split(',').map(k => k.trim()).filter(Boolean);
  if (!keys.length) { console.log('No HELIUS_KEYS found'); return; }
  const key = keys[0];

  // Try both base URLs
  const bases = [
    'https://mainnet.helius-rpc.com/v0/addresses',
    'https://api.helius.xyz/v0/addresses'
  ];

  for (const base of bases) {
    const url = `${base}/${RAYDIUM_V4}/transactions?api-key=${key}&limit=20`;
    console.log(`\n=== ${base.replace(key, '***')} ===`);
    try {
      const resp = await fetch(url, { signal: AbortSignal.timeout(10000) });
      console.log(`Status: ${resp.status}`);
      if (!resp.ok) { console.log(`Body: ${(await resp.text()).slice(0, 200)}`); continue; }
      const txs = await resp.json();
      console.log(`Txs: ${txs?.length || 0}`);
      if (!Array.isArray(txs)) { console.log(`Not an array: ${typeof txs}`); continue; }
      
      // Collect all unique event types
      const eventTypes = new Set();
      const types = new Set();
      for (const tx of txs) {
        types.add(tx.type || 'UNKNOWN');
        if (tx.events) {
          for (const k of Object.keys(tx.events)) eventTypes.add(k);
        }
      }
      console.log(`Transaction types found: ${[...types].join(', ')}`);
      console.log(`Event types found: ${[...eventTypes].join(', ') || 'NONE'}`);
      
      // Show first 2 transactions' event structure
      for (let i = 0; i < Math.min(2, txs.length); i++) {
        const tx = txs[i];
        console.log(`\n  TX ${i}: type=${tx.type} source=${tx.source}`);
        console.log(`  description: ${(tx.description || '').slice(0, 120)}`);
        if (tx.events) {
          console.log(`  events keys: ${Object.keys(tx.events).join(', ')}`);
          for (const [k, v] of Object.entries(tx.events)) {
            console.log(`    ${k}: ${JSON.stringify(v).slice(0, 200)}`);
          }
        }
        // Check instructions for InitializePool
        if (tx.instructions) {
          for (const inst of tx.instructions.slice(0, 3)) {
            console.log(`  inst: ${inst.programId?.slice(0, 12)}... | ${inst.accounts?.length || 0} accounts`);
          }
        }
      }
    } catch (e) {
      console.log(`Error: ${e.message || e}`);
    }
  }
}

main().catch(console.error);
