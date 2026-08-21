/**
 * jupiter.ts -- Jupiter V6 swap integration
 * RPC-OPTIMIZED: health-aware rotation, 3s balance timeouts, keepalive
 */

import dns from "dns";
import { Connection, Keypair, VersionedTransaction, PublicKey, LAMPORTS_PER_SOL, SystemProgram, Transaction, TransactionMessage, ComputeBudgetProgram } from "@solana/web3.js";
import { getAccount, getAssociatedTokenAddress, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, createCloseAccountInstruction, createBurnInstruction } from "@solana/spl-token";
import base58 from "bs58";
import { log } from "./logger";

// esbuild compatibility for default exports
const bs58 = (base58 as any).default || base58;

dns.setDefaultResultOrder("ipv4first");

export const SOL_MINT           = "So11111111111111111111111111111111111111112";
export const MIN_FEE_BUFFER_SOL = 0.004;

// -- RPC Health & Rotation ---------------------------------------------------
interface RpcEndpoint {
  url: string;
  connection: Connection;
  healthy: boolean;
  lastFailMs: number;
  avgLatencyMs: number;
}

const RPC_BLACKLIST_MS = 60_000;
const HEALTH_CHECK_INTERVAL_MS = 5_000;

export class RpcRotator {
  private endpoints: Array<{ url: string; healthy: boolean; restoredAt?: number }> = [];
  private currentIndex = 0;
  private primaryUrl: string | null = null; // Always the fullUrl of the first endpoint added

  constructor() {
    // Slow health checks to 30s — 5s was hammering RPC with 2 pings/sec across 10 endpoints
    setInterval(() => this.runHealthChecks(), 30_000);
  }

  private keys: string[] = [
    "8e13f606-8149-4964-8047-fc5bd4cdc569",
    "2eb86432-fcc5-4a70-b661-c53e557a218c",
    "77cb15bb-36b1-4ee9-87f3-ce862b223a29",
    "000e36a8-650d-4e8c-b411-b965ee310fa1",
    "0e688ee2-b196-434d-ac10-a7fda13c8c5e",
    "be7e351c-ecce-49ec-87c8-fc4ff33cd2a8",
    "7ec9b032-92a2-4fd5-9e19-deeb235f5a6e"
  ];

  add(url: string, fullUrl?: string) {
    // Track the very first full URL as the primary (used for TX send/confirm)
    const effectivePrimary = fullUrl || url;
    if (this.primaryUrl === null) this.primaryUrl = effectivePrimary;

    // If the caller passes the original full URL (with its own API key), use it first
    if (fullUrl) {
      this.endpoints.push({ url: fullUrl, healthy: true });
    }
    // Then add the rotation pool as fallbacks (only for helius-style base URLs)
    if (url.includes('helius-rpc.com')) {
      for (const key of this.keys) {
        this.endpoints.push({ url: `${url}?api-key=${key}`, healthy: true });
      }
    } else {
      // For QuickNode / mainnet-beta — use the full URL directly (key is in path or not needed)
      if (!fullUrl) this.endpoints.push({ url, healthy: true });
    }
  }

  async exec<T>(name: string, fn: (c: Connection) => Promise<T>, timeoutMs: number): Promise<T> {
    const healthyNodes = this.endpoints.filter(e => e.healthy);
    const node = healthyNodes[this.currentIndex % healthyNodes.length] || this.endpoints[0];
    this.currentIndex++;
    const conn = new Connection(node.url, "confirmed");
    try {
      return await Promise.race([fn(conn), new Promise<never>((_, r) => setTimeout(() => r(new Error("RPC_TIMEOUT")), timeoutMs * 1.5))]) as T;
    } catch (e: any) {
      // Blacklist on timeout, server errors, AND rate limits
      if (e.message.includes("TIMEOUT") || e.message.includes("503") || e.message.includes("429")) {
        node.healthy = false;
        node.restoredAt = Date.now() + RPC_BLACKLIST_MS;
        setTimeout(() => { node.healthy = true; }, RPC_BLACKLIST_MS);
      }
      throw e;
    }
  }

  /** Returns a round-robin rotated connection to distribute load across API keys and avoid timeouts */
  get connection(): Connection {
    const healthyNodes = this.endpoints.filter(e => e.healthy);
    const node = healthyNodes[this.currentIndex % healthyNodes.length] || this.endpoints[0];
    this.currentIndex++;
    const url = node?.url || "https://api.mainnet-beta.solana.com";
    return new Connection(url, "confirmed");
  }

  private async runHealthChecks() {
    for (const ep of this.endpoints) {
      // Skip endpoints still in their blacklist window
      if (!ep.healthy && ep.restoredAt && Date.now() < ep.restoredAt) continue;
      try {
        const conn = new Connection(ep.url, "confirmed");
        await Promise.race([conn.getVersion(), new Promise((_, r) => setTimeout(() => r(new Error()), 3000))]);
        ep.healthy = true;
        ep.restoredAt = undefined;
      } catch {
        ep.healthy = false;
        ep.restoredAt = Date.now() + RPC_BLACKLIST_MS;
        setTimeout(() => { ep.healthy = true; ep.restoredAt = undefined; }, RPC_BLACKLIST_MS);
      }
    }
  }
}

// -- Latency tracking ---------------------------------------------------------
export interface LatencyRecord {
  tokenMint: string;
  quoteStartMs: number;
  quoteDurationMs: number;
  quoteAgeAtSendMs: number;
  txSendMs: number;
  confirmDurationMs: number;
  totalDurationMs: number;
  slippageBps: number;
  priceImpactPct: number;
  retryCount: number;
  success: boolean;
  error?: string;
}

const latencyLog: LatencyRecord[] = [];
const MAX_LATENCY_LOG = 500;

export function getLatencyLog(): LatencyRecord[] { return [...latencyLog]; }
export function clearLatencyLog(): void { latencyLog.length = 0; }

function recordLatency(rec: LatencyRecord): void {
  latencyLog.push(rec);
  if (latencyLog.length > MAX_LATENCY_LOG) latencyLog.shift();
  const tag = rec.success ? "[OK]" : "[X]";
  log.info(
    `[LATENCY] ${tag} ${rec.tokenMint.slice(0, 8)}... ` +
    `quote:${rec.quoteDurationMs}ms age@send:${rec.quoteAgeAtSendMs}ms ` +
    `confirm:${rec.confirmDurationMs}ms total:${rec.totalDurationMs}ms ` +
    `impact:${rec.priceImpactPct.toFixed(2)}% retries:${rec.retryCount}${rec.error ? ` ERR:${rec.error.slice(0, 60)}` : ""}`
  );
}

const JUPITER_QUOTE_URL = "https://lite-api.jup.ag/swap/v1/quote";
const JUPITER_SWAP_URL  = "https://lite-api.jup.ag/swap/v1/swap";

const CONFIRM_TIMEOUT_MS = 60_000;
const POST_BUY_POLL_TIMEOUT_MS        = 20_000;
const POST_BUY_STABLE_READS_REQUIRED  = 2;

// -- Rate limiter -------------------------------------------------------------

function jupiterRateGate(): Promise<void> {
  const now = Date.now();
  if (now - _jupiterLastCallMs >= MIN_JUPITER_INTERVAL_MS) {
    _jupiterLastCallMs = now;
    _jupiterTail = Promise.resolve();
    return Promise.resolve();
  }
  const slot = _jupiterTail.then(
    () => new Promise<void>(resolve => {
      setTimeout(() => { _jupiterLastCallMs = Date.now(); resolve(); }, MIN_JUPITER_INTERVAL_MS);
    })
  );
  _jupiterTail = slot;
  return slot;
}

export interface BuyResult {
  success: boolean;
  txSignature: string | null;
  actualSolSpent: number;
  tokenAmountRaw: bigint;
  priceImpactPct: number;
  feesSol: number;
  error?: string;
}

export interface SellResult {
  success: boolean;
  txSignature: string | null;
  solReceived: number;
  feesSol: number;
  error?: string;
}
export interface PreflightResult {
  priceImpactPct: number;
  outAmount: string;
  routeInfo: string;
}

const MIN_JUPITER_INTERVAL_MS = 600; // Increase from 300ms to 600ms to be safe with shared RPC
let _jupiterLastCallMs = 0;
let _jupiterTail: Promise<void> = Promise.resolve();



export class JupiterService {
  private readonly rpc: RpcRotator;
  private readonly keypair: Keypair;
  private readonly priorityFeeLamports: number;
  private readonly jitoTipLamports: number;
  private readonly jitoEngineUrl: string | null;
  private executedTransactions = new Set<string>();

  constructor(
    rpcUrls: string[],
    privateKeyBase58: string,
    priorityFeeLamports = 10_000,
    jitoTipLamports = 0,
    jitoEngineUrl: string | null = null,
    fullUrls?: (string | undefined)[],
  ) {
    this.rpc = new RpcRotator();
    for (let i = 0; i < rpcUrls.length; i++) {
      const url = rpcUrls[i];
      const fullUrl = fullUrls?.[i];
      if (url) this.rpc.add(url, fullUrl);
    }
    log.info(`[JUPITER] RPC endpoints: ${rpcUrls.map(u => u.split("/")[2]).join(" | ")}`);
    this.keypair = Keypair.fromSecretKey(bs58.decode(privateKeyBase58));
    this.priorityFeeLamports = priorityFeeLamports;
    this.jitoTipLamports = jitoTipLamports;
    this.jitoEngineUrl = jitoEngineUrl;
  }

  get walletAddress(): string { return this.keypair.publicKey.toBase58(); }

  /** Fast balance read with 3s timeout. No retries -- caller retries if needed. */
  async getWalletBalance(): Promise<number> {
    const lamports = await this.rpc.exec(
      "getBalance",
      c => c.getBalance(this.keypair.publicKey, "confirmed"),
      3_000
    );
    return lamports / LAMPORTS_PER_SOL;
  }

 
  /** Fast token balance read with 3s timeout. Supports SPL and Token-2022 */
  async getTokenBalance(tokenMint: string): Promise<bigint> {
    const mintPubkey = new PublicKey(tokenMint);

    const fetchBalance = async (conn: Connection): Promise<bigint> => {
      // 1. Check Standard SPL Token ATA
      const ataStandard = await getAssociatedTokenAddress(mintPubkey, this.keypair.publicKey, false, TOKEN_PROGRAM_ID);
      try {
        const account = await getAccount(conn, ataStandard, "confirmed", TOKEN_PROGRAM_ID);
        return account.amount;
      } catch (err: any) {
        const notFound = err?.name === "TokenAccountNotFoundError" || err?.message?.includes("could not find");
        if (!notFound) throw err; // Real network error (like timeout), throw it
      }

      // 2. Check Token-2022 ATA
      const ata2022 = await getAssociatedTokenAddress(mintPubkey, this.keypair.publicKey, false, TOKEN_2022_PROGRAM_ID);
      try {
        const account2022 = await getAccount(conn, ata2022, "confirmed", TOKEN_2022_PROGRAM_ID);
        return account2022.amount;
      } catch (err: any) {
        const notFound = err?.name === "TokenAccountNotFoundError" || err?.message?.includes("could not find");
        if (notFound) return BigInt(-1); // Sentinel value: Wallet is genuinely empty
        throw err;
      }
    };

    try {
      const val = await this.rpc.exec("getTokenBalance", fetchBalance, 3_000);
      return val === BigInt(-1) ? BigInt(0) : val;
    } catch (err: any) {
      // Network error - throw it to trigger 'retaining cached balance'
      throw err;
    }
  }

  private async fetchQuoteWithRetry(
    inputMint: string,
    outputMint: string,
    amountRaw: string | number,
    slippageLevels = [500, 1500, 3000], // Expansion: 5% -> 15% -> 30% for exits
    maxAttempts = 3 // Increased attempts
  ): Promise<any> {
    let lastError: any;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      for (const slippage of slippageLevels) {
        try {
          await jupiterRateGate();
          const quoteStart = Date.now();
          const url = new URL(JUPITER_QUOTE_URL);
          url.searchParams.set("inputMint", inputMint);
          url.searchParams.set("outputMint", outputMint);
          url.searchParams.set("amount", String(amountRaw));
          url.searchParams.set("slippageBps", String(Math.max(50, Math.floor(slippage))));
          url.searchParams.set("onlyDirectRoutes", "false");
          url.searchParams.set("swapMode", "ExactIn");
          const resp = await fetch(url.toString(), {
            method: "GET",
            headers: { "Accept": "application/json", "User-Agent": "Mozilla/5.0" },
            signal: AbortSignal.timeout(15_000), // Increase timeout to 15s to handle high-latency RPCs
          });

          if (resp.status === 429) {
            const retryAfterMs = parseFloat(resp.headers.get("retry-after") ?? "0") * 1000 || 3000;
            log.warn(`[JUPITER] 429 Rate limit -- backing off ${retryAfterMs}ms`);
            await new Promise(r => setTimeout(r, retryAfterMs));
            lastError = new Error(`HTTP 429`);
            break;
          }
          if (!resp.ok) {
            const body = await resp.text().catch(() => "");
            throw new Error(`HTTP ${resp.status}: ${body.slice(0, 200)}`);
          }

          const data = await resp.json() as any;
          if (data.error || !data.outAmount) throw new Error(data.error || "No route");
          data._fetchedAt = Date.now();
          data._quoteDurationMs = Date.now() - quoteStart;
          log.info(`[JUPITER] Quote OK | ${slippage}bps | out:${data.outAmount} | impact:${parseFloat(data.priceImpactPct ?? "0").toFixed(3)}% | fetch:${data._quoteDurationMs}ms`);
          return data;
        } catch (err: any) {
          lastError = err;
          log.warn(`[JUPITER] Quote fail | attempt ${attempt + 1}/${maxAttempts} | ${slippage}bps | ${err.message}`);
          await new Promise(r => setTimeout(r, 400 + Math.random() * 200));
        }
      }
      if (attempt < maxAttempts - 1) await new Promise(r => setTimeout(r, 2000 * (attempt + 1)));
    }
    throw new Error(`Quote failed: ${lastError?.message ?? "unknown"}`);
  }

  private async buildAndSendWithRetry(
    quote: any,
    maxRetries = 2,
    maxImpactPct = 15,
    slippageBps: number,
    quoteRefresher?: () => Promise<any>
  ): Promise<{ signature: string; postSwapBalances: { mint: string; amount: bigint }[] }> {
    const usingJito = this.jitoTipLamports > 0 && !!this.jitoEngineUrl;
    let lastError: any;
    let landedSig: string | null = null;
    let finalPostBalances: { mint: string; amount: bigint }[] = [];
    const buildStart = Date.now();
    let txSendWallMs = 0;
    let retryCount = 0;

    const impactPct = parseFloat(quote.priceImpactPct ?? "0");
    if (isNaN(impactPct) || impactPct > maxImpactPct) {
      throw new Error(`Excessive price impact: ${impactPct} (max ${maxImpactPct})`);
    }
    if (!quote.routePlan || quote.routePlan.length === 0) {
      throw new Error("Quote has no routePlan");
    }

    if (quoteRefresher && quote._fetchedAt && Date.now() - quote._fetchedAt > 800) {
      try {
        const refreshed = await quoteRefresher();
        const refreshedImpact = parseFloat(refreshed.priceImpactPct ?? "0");
        if (!isNaN(refreshedImpact) && refreshedImpact <= maxImpactPct) {
          log.info(`[JUPITER] Pre-send refresh (was ${Date.now() - quote._fetchedAt}ms old) | new impact: ${refreshedImpact.toFixed(3)}%`);
          quote = refreshed;
        }
      } catch (refreshErr: any) {
        log.warn(`[JUPITER] Pre-send refresh failed: ${refreshErr.message}`);
      }
    }

    for (let i = 0; i < maxRetries; i++) {
      retryCount = i;
      if (i > 0 && quoteRefresher) {
        try {
          const freshQuote = await quoteRefresher();
          const freshImpact = parseFloat(freshQuote.priceImpactPct ?? "0");
          if (isNaN(freshImpact) || freshImpact > maxImpactPct) throw new Error(`Refreshed impact ${freshImpact}`);
          quote = freshQuote;
          log.info(`[JUPITER] Quote refreshed for retry ${i + 1} | impact: ${freshImpact.toFixed(3)}%`);
        } catch (refreshErr: any) {
          log.warn(`[JUPITER] Refresh failed on retry ${i + 1}: ${refreshErr.message}`);
          throw refreshErr;
        }
      }

      try {
        const outAmount = BigInt(quote.outAmount);
        const minOut = (outAmount * BigInt(10000 - slippageBps)) / 10000n;

        const swapBody: Record<string, any> = {
          quoteResponse: quote,
          userPublicKey: this.keypair.publicKey.toBase58(),
          wrapAndUnwrapSol: true,
          prioritizationFeeLamports: usingJito ? "auto" : this.priorityFeeLamports,
          dynamicComputeUnitLimit: true,
          asLegacyTransaction: false,
          otherAmountThreshold: minOut.toString(),
        };

        await jupiterRateGate();
        const swapResp = await fetch(JUPITER_SWAP_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(swapBody),
          signal: AbortSignal.timeout(10_000),
        });
        if (!swapResp.ok) {
          const body = await swapResp.text().catch(() => "");
          throw new Error(`Swap HTTP ${swapResp.status}: ${body.slice(0, 200)}`);
        }

        const swapData = await swapResp.json() as any;
        const swapTransaction = swapData.swapTransaction;
        let lastValidBlockHeight = swapData.lastValidBlockHeight as number | undefined;
        if (!swapTransaction) throw new Error("No swapTransaction");

        const txBytes = Buffer.from(swapTransaction, "base64");
        const tx = VersionedTransaction.deserialize(txBytes);
        tx.sign([this.keypair]);
        const recentBlockhash = tx.message.recentBlockhash;
        const serializedTx = tx.serialize();

        if (lastValidBlockHeight == null) {
          const latest = await this.rpc.exec("getLatestBlockhash", c => c.getLatestBlockhash("confirmed"), 3_000);
          lastValidBlockHeight = latest.lastValidBlockHeight;
        }

        let sig: string;
        
        // Grab a single rotated connection for this entire attempt
        const txConn = this.rpc.connection;

        // We track the swap signature to confirm the actual trade on-chain
        sig = bs58.encode(tx.signatures[0]);

        if (usingJito && this.jitoEngineUrl) {
          try {
            // 1. Pick a random Jito Tip Account
            const jitoTipAccounts = [
              "96gYZGLnJYVFmbjzopPSU6QiCRK2U2EYhLnKkcs8mZ7U",
              "HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe",
              "Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvVkY",
              "ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iMgaSbg",
              "DfXygSm4jWGvYWpt2wT1T6X1B3jXz5R73tL99H7JpTnP",
              "ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwPe1T",
              "DttWaMuVvTiduZRnguLF7FsBogWAxaTrDptB6FqGcuEa",
              "3AVi9Tg9Uo68tJfuvoKvqKNpKkC5eq1hS35R8bGBz1N9"
            ];
            const tipAccount = new PublicKey(jitoTipAccounts[Math.floor(Math.random() * jitoTipAccounts.length)]);

            // 2. Create the standalone Tip Transaction
            const tipIx = SystemProgram.transfer({
              fromPubkey: this.keypair.publicKey,
              toPubkey: tipAccount,
              lamports: this.jitoTipLamports,
            });

            const tipMessage = new TransactionMessage({
              payerKey: this.keypair.publicKey,
              recentBlockhash: recentBlockhash,
              instructions: [tipIx],
            }).compileToV0Message();

            const tipTx = new VersionedTransaction(tipMessage);
            tipTx.sign([this.keypair]);

            // 3. Send both transactions as an MEV-protected Bundle
            const encodedSwapTx = bs58.encode(serializedTx);
            const encodedTipTx = bs58.encode(tipTx.serialize());
            
            // Auto-convert your /transactions endpoint URL to the /bundles endpoint
            const bundleUrl = this.jitoEngineUrl.replace("/transactions", "/bundles");

            txSendWallMs = Date.now();
            const jitoRes = await fetch(bundleUrl, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                jsonrpc: "2.0",
                id: 1,
                method: "sendBundle",
                params: [[encodedSwapTx, encodedTipTx]]
              }),
              signal: AbortSignal.timeout(10_000),
            });

            if (!jitoRes.ok) throw new Error(`Jito HTTP ${jitoRes.status}`);
            const jitoData = await jitoRes.json() as any;
            if (jitoData.error) throw new Error(`Jito rejected: ${JSON.stringify(jitoData.error)}`);

            log.info(`[JUPITER] MEV Bundle Sent via Jito | Swap Sig: ${sig.slice(0, 20)}...`);
            
          } catch (jitoErr: any) {
            log.warn(`[JUPITER] Jito bundle failed: ${jitoErr.message} -- falling back to public RPC`);
            txSendWallMs = Date.now();
            await Promise.race([
              txConn.sendRawTransaction(serializedTx, { skipPreflight: false, maxRetries: 0, preflightCommitment: "confirmed" }),
              new Promise<never>((_, reject) => setTimeout(() => reject(new Error("sendRawTransaction timeout")), 15_000))
            ]);
          }
        } else {
          // Standard public send if Jito is disabled
          txSendWallMs = Date.now();
          await Promise.race([
            txConn.sendRawTransaction(serializedTx, { skipPreflight: false, maxRetries: 0, preflightCommitment: "confirmed" }),
            new Promise<never>((_, reject) => setTimeout(() => reject(new Error("sendRawTransaction timeout")), 15_000))
          ]);
        }

        if (this.executedTransactions.has(sig)) throw new Error(`Duplicate tx: ${sig}`);
        landedSig = sig;

        // Confirm on the SAME connection that sent it -- never rotate during confirmation
        const confirmResult = await Promise.race([
          txConn.confirmTransaction(
            { signature: sig, blockhash: recentBlockhash, lastValidBlockHeight: lastValidBlockHeight! },
            "confirmed"
          ),
          new Promise<never>((_, reject) => setTimeout(() => reject(new Error("Confirm timeout")), CONFIRM_TIMEOUT_MS)),
        ]) as any;

        if (confirmResult?.value?.err) {
          throw new Error(`Tx reverted: ${JSON.stringify(confirmResult.value.err)}`);
        }

        let txDetails: Awaited<ReturnType<typeof txConn.getTransaction>> | null = null;
        try {
          txDetails = await this.rpc.exec("getTransaction", c => c.getTransaction(sig, { maxSupportedTransactionVersion: 0 }), 5_000);
        } catch (metaErr: any) {
          log.warn(`[JUPITER] getTransaction threw: ${metaErr.message}`);
        }
        if (!txDetails?.meta) {
          log.warn("[JUPITER] TX metadata missing -- balance poll will resolve");
          finalPostBalances = [];
        } else {
          finalPostBalances = (txDetails.meta.postTokenBalances || []).map(b => ({
            mint: b.mint,
            amount: BigInt(b.uiTokenAmount?.amount || "0"),
          }));
        }

        this.executedTransactions.add(sig);
        if (this.executedTransactions.size > 1000) {
          const toDelete = Array.from(this.executedTransactions).slice(0, 500);
          toDelete.forEach(s => this.executedTransactions.delete(s));
        }

        recordLatency({
          tokenMint: quote.inputMint ?? quote.outputMint ?? "unknown",
          quoteStartMs: quote._fetchedAt ? quote._fetchedAt - (quote._quoteDurationMs ?? 0) : buildStart,
          quoteDurationMs: quote._quoteDurationMs ?? 0,
          quoteAgeAtSendMs: quote._fetchedAt ? (txSendWallMs || Date.now()) - quote._fetchedAt : 0,
          txSendMs: txSendWallMs || Date.now(),
          confirmDurationMs: Date.now() - (txSendWallMs || Date.now()),
          totalDurationMs: Date.now() - buildStart,
          slippageBps, priceImpactPct: parseFloat(quote.priceImpactPct ?? "0"), retryCount, success: true,
        });

        log.info(`[JUPITER] TX confirmed | sig: ${sig.slice(0, 20)}...`);
        return { signature: sig, postSwapBalances: finalPostBalances };

      } catch (err: any) {
        lastError = err;
        log.warn(`[JUPITER] Swap attempt ${i + 1}/${maxRetries} failed: ${err.message}`);
        if (landedSig) {
          try {
            const status = await this.rpc.exec("getSignatureStatus", c => c.getSignatureStatus(landedSig!, { searchTransactionHistory: false }), 3_000) as any;
            if (status?.value && !status.value.err) {
              log.info(`[JUPITER] TX landed despite error`);
              const txDetails = await this.rpc.exec("getTransaction", c => c.getTransaction(landedSig!, { maxSupportedTransactionVersion: 0 }), 10_000);
              finalPostBalances = (txDetails?.meta?.postTokenBalances || []).map((b: any) => ({
                mint: b.mint, amount: BigInt(b.uiTokenAmount?.amount || "0"),
              }));
              return { signature: landedSig, postSwapBalances: finalPostBalances };
            }
            if (status && status.value === null) {
              throw new Error(`TX pending -- aborting to prevent double-spend. sig: ${landedSig}`);
            }
          } catch (statusErr: any) {
            if (statusErr.message?.includes("double-spend")) throw statusErr;
          }
        }
        if (i < maxRetries - 1) await new Promise(r => setTimeout(r, 1_500));
      }
    }

    recordLatency({
      tokenMint: quote.inputMint ?? quote.outputMint ?? "unknown",
      quoteStartMs: quote._fetchedAt ? quote._fetchedAt - (quote._quoteDurationMs ?? 0) : buildStart,
      quoteDurationMs: quote._quoteDurationMs ?? 0,
      quoteAgeAtSendMs: quote._fetchedAt ? (txSendWallMs || Date.now()) - quote._fetchedAt : 0,
      txSendMs: txSendWallMs || Date.now(),
      confirmDurationMs: 0,
      totalDurationMs: Date.now() - buildStart,
      slippageBps, priceImpactPct: parseFloat(quote.priceImpactPct ?? "0"), retryCount, success: false,
      error: lastError?.message ?? "unknown",
    });
    throw new Error(`Swap failed after ${maxRetries}: ${lastError?.message ?? "unknown"}`);
  }

  async preflightQuote(inputMint: string, outputMint: string, amountRaw: number, slippageBps: number): Promise<PreflightResult | null> {
    try {
      const quote = await this.fetchQuoteWithRetry(inputMint, outputMint, amountRaw, [slippageBps], 2);
      const priceImpactPct = parseFloat(quote.priceImpactPct ?? "0");
      const routeLabels = (quote.routePlan ?? []).map((s: any) => s.swapInfo?.label ?? "unknown").slice(0, 3);
      return { priceImpactPct, outAmount: quote.outAmount ?? "0", routeInfo: routeLabels.join("->") || "direct" };
    } catch { return null; }
  }

  async fetchQuote(inputMint: string, outputMint: string, amountRaw: number | string, slippageLevels: number[] = [500, 1000]): Promise<any> {
    return this.fetchQuoteWithRetry(inputMint, outputMint, amountRaw, slippageLevels);
  }

  async buyToken(tokenMint: string, amountSol: number, slippageBps: number, quoteOverride?: any, maxImpactPct = 15): Promise<BuyResult> {
    const lamports = Math.floor(amountSol * LAMPORTS_PER_SOL);
    try {
      const latestSolBal = await this.getWalletBalance();
      if (latestSolBal < amountSol + MIN_FEE_BUFFER_SOL) {
        throw new Error(`Balance low: ${latestSolBal.toFixed(5)} SOL`);
      }

      let quote = quoteOverride;
      if (!quote) {
        quote = await this.fetchQuoteWithRetry(SOL_MINT, tokenMint, lamports, [slippageBps, Math.max(slippageBps, Math.min(slippageBps * 2, 1000))]);
      }
      if (quoteOverride && Date.now() - (quoteOverride._fetchedAt ?? 0) > 800) {
        log.warn(`[JUPITER] Stale quote (>800ms) -- refreshing`);
        quote = await this.fetchQuoteWithRetry(SOL_MINT, tokenMint, lamports, [slippageBps, Math.max(slippageBps, Math.min(slippageBps * 2, 1000))]);
      }

      const priceImpactPct = parseFloat(quote.priceImpactPct ?? "0");
      const [tokenBalBefore, solBalBefore] = await Promise.all([
        this.getTokenBalance(tokenMint),
        this.getWalletBalance(),
      ]);

      if (!quote.routePlan || quote.routePlan.length === 0) throw new Error("No routePlan");

      const { signature: txSignature, postSwapBalances } = await this.buildAndSendWithRetry(
        quote, 2, maxImpactPct, slippageBps,
        () => this.fetchQuoteWithRetry(SOL_MINT, tokenMint, lamports, [slippageBps, Math.max(slippageBps, Math.min(slippageBps * 2, 1000))])
      );

      let finalTokenBal = BigInt(0);
      for (const bal of postSwapBalances) {
        if (bal.mint === tokenMint) { finalTokenBal = bal.amount; break; }
      }
      if (finalTokenBal === BigInt(0)) {
        let stableReads = 0, lastTokenBal = BigInt(0);
        const POLL_START = Date.now();
        while (Date.now() - POLL_START < POST_BUY_POLL_TIMEOUT_MS) {
          await new Promise(r => setTimeout(r, 500));
          const tokenBal = await this.getTokenBalance(tokenMint);
          if (tokenBal > tokenBalBefore) {
            if (tokenBal === lastTokenBal) {
              stableReads++;
              if (stableReads >= POST_BUY_STABLE_READS_REQUIRED) { finalTokenBal = tokenBal; break; }
            } else { stableReads = 1; lastTokenBal = tokenBal; }
          } else { stableReads = 0; }
        }
        if (finalTokenBal === BigInt(0)) throw new Error("Token balance did not increase");
      }

      const tokenAmountRaw = finalTokenBal - tokenBalBefore;
      const safeTokenAmountRaw = tokenAmountRaw < BigInt(0) ? finalTokenBal : tokenAmountRaw;
      const finalSolBal = await this.getWalletBalance();
      let actualSolSpent = solBalBefore - finalSolBal;
      if (actualSolSpent <= 0) actualSolSpent = amountSol + 0.005;

      const expectedOut = BigInt(quote.outAmount);
      if (safeTokenAmountRaw < expectedOut * 70n / 100n) {
        return {
          success: true, txSignature, actualSolSpent, tokenAmountRaw: safeTokenAmountRaw, priceImpactPct,
          feesSol: 0, error: `Partial fill: ${(safeTokenAmountRaw * 100n / expectedOut).toString()}%`,
        };
      }

      const BASE_TX_FEE_SOL = 0.000005;
      const feesSol = BASE_TX_FEE_SOL + (this.priorityFeeLamports / 1e9) + (this.jitoTipLamports / 1e9);
      log.info(`[JUPITER] BUY OK | sig:${txSignature?.slice(0,20)} | SOL:${actualSolSpent.toFixed(6)} | tokens:${safeTokenAmountRaw} | impact:${priceImpactPct.toFixed(3)}%`);
      return { success: true, txSignature, actualSolSpent, tokenAmountRaw: safeTokenAmountRaw, priceImpactPct, feesSol };
    } catch (e: any) {
      log.error(`[JUPITER] BUY FAILED ${tokenMint}: ${e.message}`);
      return { success: false, txSignature: null, actualSolSpent: 0, tokenAmountRaw: BigInt(0), priceImpactPct: 0, feesSol: 0, error: e.message };
    }
  }

  async sellToken(tokenMint: string, tokenAmountRaw: bigint, slippageBps: number): Promise<SellResult> {
    try {
      let sellAmount = tokenAmountRaw;
      if (sellAmount <= BigInt(0)) {
        sellAmount = await this.getTokenBalance(tokenMint);
        if (sellAmount <= BigInt(0)) throw new Error("No token balance");
      }
      const dynamicSlippageLevels = [
        slippageBps,
        Math.max(slippageBps, Math.min(slippageBps * 2, 1000)),
        Math.max(slippageBps, Math.min(slippageBps * 4, 2000)),
      ];
      const quote = await this.fetchQuoteWithRetry(tokenMint, SOL_MINT, sellAmount.toString(), dynamicSlippageLevels);
      const impactPct = parseFloat(quote.priceImpactPct ?? "0");
      if (impactPct > 30) log.warn(`[JUPITER] SELL high impact ${impactPct.toFixed(2)}%`);

      const solBefore = await this.getWalletBalance();
      const { signature: txSignature } = await this.buildAndSendWithRetry(
        quote, 2, 99, slippageBps,
        () => this.fetchQuoteWithRetry(tokenMint, SOL_MINT, sellAmount.toString(), [
          Math.max(slippageBps, Math.min(slippageBps * 2, 2000)),
          Math.max(slippageBps, Math.min(slippageBps * 4, 3000)),
        ])
      );

      let solAfter = solBefore;
      for (let i = 0; i < 30; i++) {
        await new Promise(r => setTimeout(r, 500));
        try {
          const latestBal = await this.getWalletBalance();
          if (latestBal > solBefore + 0.0001) { solAfter = latestBal; break; }
          solAfter = latestBal;
        } catch (rpcErr: any) {
          log.warn(`[JUPITER] Post-sell poll err ${i + 1}/30: ${rpcErr.message}`);
        }
      }
      let solReceived = Math.max(0, solAfter - solBefore);
      if (solReceived === 0) {
        const confirmedBal = await this.getWalletBalance().catch(() => solBefore);
        const retryReceived = Math.max(0, confirmedBal - solBefore);
        if (retryReceived > 0) {
          log.warn(`[JUPITER] Poll missed balance -- confirmed: ${retryReceived.toFixed(6)} SOL`);
          solReceived = retryReceived;
        } else {
          log.error(`[JUPITER] SELL confirmed but SOL delta = 0 after poll + read`);
        }
      }

      const feesSol = 0.000005 + (this.priorityFeeLamports / 1e9) + (this.jitoTipLamports / 1e9);
      log.info(`[JUPITER] SELL OK | sig:${txSignature?.slice(0,20)} | SOL:${solReceived.toFixed(6)} | fees:${feesSol.toFixed(6)}`);
      return { success: true, txSignature, solReceived, feesSol };
    } catch (e: any) {
      log.error(`[JUPITER] SELL FAILED ${tokenMint}: ${e.message}`);
      return { success: false, txSignature: null, solReceived: 0, feesSol: 0, error: e.message };
    }
  }

  async closeTokenAccount(tokenMint: string): Promise<boolean> {
    try {
      const mintPubkey = new PublicKey(tokenMint);
      const ata = await getAssociatedTokenAddress(mintPubkey, this.keypair.publicKey);
      const closeIx = createCloseAccountInstruction(ata, this.keypair.publicKey, this.keypair.publicKey);
      const tx = new Transaction().add(
        ComputeBudgetProgram.setComputeUnitLimit({ units: 30_000 }),
        ComputeBudgetProgram.setComputeUnitPrice({ microLamports: this.priorityFeeLamports || 10_000 }),
        closeIx
      );
      // Use the RPC rotator (retry + failover) instead of raw connection for blockhash resilience
      const sig = await this.rpc.exec(
        'closeTokenAccount',
        (conn) => conn.sendTransaction(tx, [this.keypair], { skipPreflight: true }),
        10_000
      );
      log.info(`[JUPITER] ATA cleanup ${tokenMint.slice(0, 8)}... | sig:${sig}`);
      return true;
    } catch (e: any) {
      log.warn(`[JUPITER] ATA close failed: ${e.message}`);
      return false;
    }
  }

  /** Scans the wallet for dust/empty ATAs, burns the dust, and closes them to reclaim rent */
  async sweepEmptyAccounts(): Promise<void> {
    // Wait 5s for RPC connections to fully warm up before making account queries
    await new Promise(r => setTimeout(r, 5_000));
    log.info("[JANITOR] Scanning wallet for empty or dust accounts to reclaim rent...");
    try {
      // 1. Fetch all token accounts via RPC rotator (retry + failover)
      const [splAccounts, token2022Accounts] = await Promise.all([
        this.rpc.exec('janitor-spl', c => c.getParsedTokenAccountsByOwner(this.keypair.publicKey, { programId: TOKEN_PROGRAM_ID }), 15_000),
        this.rpc.exec('janitor-2022', c => c.getParsedTokenAccountsByOwner(this.keypair.publicKey, { programId: TOKEN_2022_PROGRAM_ID }), 15_000),
      ]);

      const allAccounts = [...splAccounts.value, ...token2022Accounts.value];
      log.info(`[JANITOR] RPC returned ${allAccounts.length} total token accounts.`);
      
      // 2. Filter for exactly zero OR dust (< 0.01 tokens)
      const targetAccounts = allAccounts.filter(acc => {
          const uiAmount = acc.account.data.parsed.info.tokenAmount.uiAmount || 0;
          return uiAmount < 0.01; // FIX #3: filter was disabled (return true), causing ALL accounts including live positions to be burned on engine restart
      });

      if (targetAccounts.length === 0) {
        log.info("[JANITOR] Wallet is clean. No empty/dust accounts found.");
        return;
      }

      log.info(`[JANITOR] Found ${targetAccounts.length} empty/dust accounts. Commencing Burn & Sweep...`);
      
      // 3. Batch the operations (Lowered batch size because burning adds instructions)
      const BATCH_SIZE = 8; 
      let totalReclaimed = 0;

      for (let i = 0; i < targetAccounts.length; i += BATCH_SIZE) {
        const batch = targetAccounts.slice(i, i + BATCH_SIZE);
        const tx = new Transaction().add(
          ComputeBudgetProgram.setComputeUnitLimit({ units: 50000 + (batch.length * 20000) }),
          ComputeBudgetProgram.setComputeUnitPrice({ microLamports: this.priorityFeeLamports || 15000 })
        );

        for (const acc of batch) {
          const rawAmount = acc.account.data.parsed.info.tokenAmount.amount;
          const programId = new PublicKey(acc.account.owner);
          const mintPubkey = new PublicKey(acc.account.data.parsed.info.mint);

          // If there is dust, we MUST burn it before Solana allows the account to be closed
          if (rawAmount !== "0") {
              tx.add(
                  createBurnInstruction(
                      acc.pubkey,             // The ATA
                      mintPubkey,             // The Token Mint
                      this.keypair.publicKey, // Owner
                      BigInt(rawAmount),      // Amount to burn
                      [],
                      programId               // Program ID
                  )
              );
          }

          // Close the account to reclaim the 0.002 SOL
          tx.add(
            createCloseAccountInstruction(
              acc.pubkey,
              this.keypair.publicKey,
              this.keypair.publicKey,
              [],
              programId
            )
          );
        }

        try {
          const sig = await this.rpc.exec(
            'janitor-sweep',
            (conn) => conn.sendTransaction(tx, [this.keypair], { skipPreflight: true }),
            15_000
          );
          log.info(`[JANITOR] Batch cleared! Reclaimed ~${(batch.length * 0.002039).toFixed(4)} SOL | Tx: ${sig.slice(0, 20)}...`);
          totalReclaimed += batch.length * 0.002039;
          
          if (i + BATCH_SIZE < targetAccounts.length) {
              await new Promise(r => setTimeout(r, 1000)); // Rate limit protection
          }
        } catch (err: any) {
          log.warn(`[JANITOR] Batch failed: ${err.message}`);
        }
      }
      log.info(`[JANITOR] Sweep complete! Total reclaimed: ~${totalReclaimed.toFixed(4)} SOL.`);
    } catch (e: any) {
      log.error(`[JANITOR] Sweep error: ${e.message}`);
    }
  }
}

export function createJupiterService(): JupiterService | null {
  const pk = process.env.WALLET_PRIVATE_KEY?.trim();
  if (!pk) {
    log.info("[JUPITER] WALLET_PRIVATE_KEY not set -- live disabled");
    return null;
  }

  // Build endpoint list: primary -> backup -> tertiary
  // IMPORTANT: preserve the original full URL (with its API key) as the primary endpoint.
  // The base URL (without query params) is used only for the rotation pool fallbacks.
  const primaryFull = process.env.SOLANA_RPC_URL?.trim();
  const backupFull  = process.env.SOLANA_RPC_BACKUP_URL?.trim();
  const tertiaryFull = process.env.SOLANA_RPC_TERTIARY_URL?.trim();

  const urls: Array<{ base: string; full?: string }> = [];
  if (primaryFull)  urls.push({ base: primaryFull.split("?")[0],  full: primaryFull  });
  if (backupFull)   urls.push({ base: backupFull.split("?")[0],   full: backupFull   });
  if (tertiaryFull) urls.push({ base: tertiaryFull.split("?")[0], full: tertiaryFull });
  if (urls.length === 0) urls.push({ base: "https://api.mainnet-beta.solana.com" });

  const jitoEngineUrl = process.env.JITO_ENGINE_URL?.trim() || null;
  const DEFAULT_JITO_TIP = jitoEngineUrl ? 30_000 : 0;
  const rawJitoTip = parseInt(process.env.JITO_TIP_LAMPORTS ?? String(DEFAULT_JITO_TIP), 10);
  const jitoTipLamports = isNaN(rawJitoTip) ? DEFAULT_JITO_TIP : rawJitoTip;

  const DEFAULT_PRIORITY_FEE = 100_000;
  const rawPriorityFee = parseInt(process.env.PRIORITY_FEE_LAMPORTS ?? String(DEFAULT_PRIORITY_FEE), 10);
  const priorityFeeLamports = isNaN(rawPriorityFee) ? DEFAULT_PRIORITY_FEE : rawPriorityFee;

  try {
    const svc = new JupiterService(urls.map(u => u.base), pk, priorityFeeLamports, jitoTipLamports, jitoEngineUrl, urls.map(u => u.full));
    log.info(`[JUPITER] Init | wallet:${svc.walletAddress} | endpoints:${urls.length}`);
    return svc;
  } catch (e: any) {
    log.error(`[JUPITER] Init failed: ${e.message}`);
    return null;
  }
}