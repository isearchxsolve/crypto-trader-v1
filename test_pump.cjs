const WebSocket = require('ws');
const ws = new WebSocket('wss://mainnet.helius-rpc.com/?api-key=85a848b0-d314-4477-a123-1a294ac0908b');
ws.on('open', () => {
    ws.send(JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'logsSubscribe',
        params: [{ mentions: ['pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA'] }, { commitment: 'confirmed' }]
    }));
});
let count = 0;
let started = Date.now();
ws.on('message', raw => {
    const s = raw.toString();
    // Pump fun creation might not have Buy or Sell, but it might have Create
    if (s.includes('Instruction: Create') || s.includes('Instruction: InitializeMint')) {
        console.log(s);
        process.exit(0);
    }
    if (Date.now() - started > 15000) {
        console.log('Timeout 15s');
        process.exit(0);
    }
});
