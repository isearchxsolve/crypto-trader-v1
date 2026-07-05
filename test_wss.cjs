const WebSocket = require('ws');
const ws = new WebSocket('wss://mainnet.helius-rpc.com/?api-key=85a848b0-d314-4477-a123-1a294ac0908b');
ws.on('open', () => {
    ws.send(JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'logsSubscribe',
        params: [{ mentions: ['675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8'] }, { commitment: 'confirmed' }]
    }));
});
let count = 0;
ws.on('message', raw => {
    console.log(raw.toString());
    count++;
    if (count > 2) process.exit(0);
});
