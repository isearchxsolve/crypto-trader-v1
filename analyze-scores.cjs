const fs = require('fs');
const log = fs.readFileSync('paper-run-profit.log', 'utf8');
const scores = [];
const re = /SCORE-BREAKDOWN\] \$([^\s]+) combined=(\d+)/g;
let m;
while ((m = re.exec(log)) !== null) scores.push({ sym: m[1], s: parseInt(m[2], 10) });
console.log('total score events:', scores.length);
const dist = {};
for (const x of scores) { const b = Math.floor(x.s / 10) * 10; dist[b] = (dist[b] || 0) + 1; }
console.log('=== SCORE DISTRIBUTION (fixed/honest scoring) ===');
Object.keys(dist).sort((a, b) => a - b).forEach(b => console.log('band', String(b).padStart(3), ':', '#'.repeat(Math.min(60, dist[b])), dist[b]));
const max = scores.length ? Math.max(...scores.map(x => x.s)) : 0;
console.log('max score seen:', max);
console.log('tokens reaching >=65:', scores.filter(x => x.s >= 65).length);
console.log('tokens reaching >=55:', scores.filter(x => x.s >= 55).length);
console.log('tokens reaching >=45:', scores.filter(x => x.s >= 45).length);
// top 10 scoring events
console.log('\n=== TOP 10 SCORE EVENTS ===');
scores.sort((a, b) => b.s - a.s).slice(0, 10).forEach(x => console.log(x.sym.padEnd(14), x.s));
