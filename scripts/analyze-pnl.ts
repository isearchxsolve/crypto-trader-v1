import { initStorageWrapper, storage } from '../server/storage';

function extractTier(txHash: string): string {
  const match = txHash.match(/^paper_([a-z0-9_]+?)_/);
  return match ? match[1].toUpperCase() : 'SCANNER';
}

function roundTo(n: number, d: number): number {
  return Math.round(n * 10 ** d) / 10 ** d;
}

async function main() {
  await initStorageWrapper();
  const allTrades = await storage.getTrades();

  const closedTrades = allTrades.filter((t: any) => t.status === 'CLOSED');
  const byTier = new Map<string, any[]>();

  for (const t of closedTrades) {
    const tier = extractTier(t.txHash || '');
    if (!byTier.has(tier)) byTier.set(tier, []);
    byTier.get(tier)!.push(t);
  }

  const COST_PCT = 3.76;

  console.log('=== P&L ANALYSIS ===');
  console.log(`Total trades: ${allTrades.length} (closed: ${closedTrades.length}, open: ${allTrades.length - closedTrades.length})`);
  console.log('');

  const sorted = [...byTier.entries()].sort((a, b) => b[1].length - a[1].length);
  for (const [tier, trades] of sorted) {
    const count = trades.length;
    const pnls = trades.map((t: any) => parseFloat(t.pnl || '0')).filter((v: number) => !isNaN(v));
    if (pnls.length === 0) {
      console.log(`[${tier}] ${count} closed trades, no numeric P&L data`);
      continue;
    }

    const wins = pnls.filter((v: number) => v > 0).length;
    const losses = pnls.filter((v: number) => v <= 0).length;
    const winRate = (wins / pnls.length) * 100;
    const meanPnl = pnls.reduce((a: number, b: number) => a + b, 0) / pnls.length;
    const sortedP = [...pnls].sort((a: number, b: number) => a - b);
    const medianPnl = sortedP.length % 2 === 0
      ? (sortedP[sortedP.length / 2 - 1] + sortedP[sortedP.length / 2]) / 2
      : sortedP[Math.floor(sortedP.length / 2)];
    const totalPnl = pnls.reduce((a: number, b: number) => a + b, 0);
    const netEdge = meanPnl - COST_PCT;

    const minPnl = Math.min(...pnls);
    const maxPnl = Math.max(...pnls);

    console.log(`[${tier}] ${count} closed trades`);
    console.log(`       Win rate: ${roundTo(winRate, 1)}% (${wins}W / ${losses}L)`);
    console.log(`       Mean P&L: ${roundTo(meanPnl, 2)}%`);
    console.log(`       Median P&L: ${roundTo(medianPnl, 2)}%`);
    console.log(`       Total P&L: ${roundTo(totalPnl, 2)}%`);
    console.log(`       Best: ${roundTo(maxPnl, 2)}% | Worst: ${roundTo(minPnl, 2)}%`);
    console.log(`       Net edge vs ${COST_PCT}% cost: ${roundTo(netEdge, 2)}%`);
    console.log('');
  }

  if (byTier.size === 0) {
    console.log('No closed trades found.');
  }
}

main().catch((err) => {
  console.error('Analyzer failed:', err);
  process.exit(1);
});
