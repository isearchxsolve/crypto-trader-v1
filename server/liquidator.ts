// liquidator.ts -- server-INDEPENDENT emergency liquidation
import { Connection, PublicKey } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import { createJupiterService, SOL_MINT } from "./jupiter";
import { log } from "./logger";

const EMERGENCY_SLIPPAGE_BPS = 2500; // 25% -- accept impact to guarantee exit
const RETRY_PASSES = 3;

export async function liquidateEverything() {
  const svc = createJupiterService();
  if (!svc) throw new Error("No wallet configured -- cannot liquidate");

  const owner = new PublicKey(svc.walletAddress);
  const conn = new Connection(
    (process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com").split("?")[0],
    "confirmed"
  );

  const solBefore = await svc.getWalletBalance();

  const [spl, t22] = await Promise.all([
    conn.getParsedTokenAccountsByOwner(owner, { programId: TOKEN_PROGRAM_ID }),
    conn.getParsedTokenAccountsByOwner(owner, { programId: TOKEN_2022_PROGRAM_ID }),
  ]);

  let positions = [...spl.value, ...t22.value]
    .map(a => ({
      mint: a.account.data.parsed.info.mint as string,
      raw: BigInt(a.account.data.parsed.info.tokenAmount.amount),
      ui: (a.account.data.parsed.info.tokenAmount.uiAmount as number) ?? 0,
    }))
    .filter(p => p.mint !== SOL_MINT && p.raw > 0n && p.ui > 0);

  let sold = 0; let failedMints: string[] = [];
  for (let pass = 1; pass <= RETRY_PASSES && positions.length; pass++) {
    log.info(`[LIQUIDATE] pass ${pass} | ${positions.length} positions`);
    const stillOpen: typeof positions = [];
    for (const p of positions) {
      try {
        const r = await svc.sellToken(p.mint, p.raw, EMERGENCY_SLIPPAGE_BPS);
        if (r.success) { sold++; log.info(`[LIQUIDATE] OUT ${p.mint.slice(0,8)} +${r.solReceived} SOL`); }
        else stillOpen.push(p);
      } catch (e: any) { log.error(`[LIQUIDATE] ${p.mint.slice(0,8)} threw: ${e.message}`); stillOpen.push(p); }
    }
    positions = stillOpen;
    if (positions.length) await new Promise(r => setTimeout(r, 2000));
  }
  failedMints = positions.map(p => p.mint);

  const solAfter = await svc.getWalletBalance().catch(() => solBefore);
  return { sold, failed: failedMints.length, failedMints, solRecovered: Math.max(0, solAfter - solBefore) };
}

if (require.main === module) {
  liquidateEverything()
    .then(r => { log.info(`[LIQUIDATE] done sold=${r.sold} failed=${r.failed} +${r.solRecovered} SOL`); process.exit(r.failed ? 1 : 0); })
    .catch(e => { log.error(`[LIQUIDATE] FATAL ${e.message}`); process.exit(2); });
}
