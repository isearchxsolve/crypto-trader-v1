/**
 * Small, dependency-free production safety primitives.
 *
 * Keep these functions pure so the thresholds that stop trading can be tested
 * exhaustively without importing the networked engine.
 */
export interface AbsoluteDailyLossInput {
  /** Net realized + unrealized PnL in SOL for the current UTC day. */
  netDailyPnlSol: number;
  /** A positive SOL loss ceiling. Undefined disables this additional guard. */
  maxDailyLossSol?: number;
}

export interface AbsoluteDailyLossDecision {
  halt: boolean;
  lossSol: number;
  reason?: string;
}

export function evaluateAbsoluteDailyLoss(input: AbsoluteDailyLossInput): AbsoluteDailyLossDecision {
  const limit = input.maxDailyLossSol;
  const pnl = input.netDailyPnlSol;
  const validLimit = typeof limit === "number" && Number.isFinite(limit) && limit > 0;
  const validPnl = typeof pnl === "number" && Number.isFinite(pnl);
  const lossSol = validPnl && pnl < 0 ? Math.abs(pnl) : 0;

  if (!validLimit || !validPnl) return { halt: false, lossSol };
  if (lossSol >= limit) {
    return {
      halt: true,
      lossSol,
      reason: `MAX_DAILY_LOSS_SOL (${lossSol.toFixed(9)} >= ${limit.toFixed(9)} SOL)`,
    };
  }
  return { halt: false, lossSol };
}

/** A finite positive numeric environment variable, with no value ever logged. */
export function readPositiveNumber(env: Record<string, string | undefined>, name: string): number | undefined {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") return undefined;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

export interface StartupValidationResult {
  mode: "paper" | "live";
  port: number;
  missing: string[];
  invalid: string[];
}

/**
 * Validate only the operating contract that this service owns. Values are never
 * returned, so callers can report variable names without exposing credentials.
 */
export function validateStartupEnvironment(env: Record<string, string | undefined>): StartupValidationResult {
  const modeRaw = (env.MODE || "paper").trim().toLowerCase();
  const mode = modeRaw === "live" ? "live" : "paper";
  const missing: string[] = [];
  const invalid: string[] = [];
  const portRaw = env.PORT || "5000";
  const port = Number(portRaw);

  if (!Number.isInteger(port) || port < 1 || port > 65535) invalid.push("PORT");
  if (modeRaw !== "paper" && modeRaw !== "live") invalid.push("MODE");

  // Paper mode is deliberately credential-free. Live mode refuses to arm until
  // all execution and persistence prerequisites are present.
  if (mode === "live") {
    for (const name of ["DATABASE_URL", "SOLANA_RPC_URL", "BIRDEYE_API_KEY", "WALLET_PRIVATE_KEY"]) {
      if (!(env[name] || "").trim()) missing.push(name);
    }
  }

  return { mode, port: Number.isInteger(port) && port >= 1 && port <= 65535 ? port : 5000, missing, invalid };
}

export function assertStartupEnvironment(env: Record<string, string | undefined>): StartupValidationResult {
  const result = validateStartupEnvironment(env);
  if (result.missing.length || result.invalid.length) {
    const details = [
      result.missing.length ? `missing: ${result.missing.join(", ")}` : "",
      result.invalid.length ? `invalid: ${result.invalid.join(", ")}` : "",
    ].filter(Boolean).join("; ");
    throw new Error(`Startup configuration rejected (${details}). Values are intentionally not displayed.`);
  }
  return result;
}

const sensitiveAssignment = /\b([A-Z][A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PRIVATE|AUTHORIZATION|DATABASE_URL|RPC_URL))\b\s*([:=])\s*([^\s,;]+)/gi;
const sensitiveQuery = /([?&](?:api[-_]?key|token|secret|password|authorization)=)[^&#\s]+/gi;
const bearer = /\b(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi;
const base58Identifier = /\b[1-9A-HJ-NP-Za-km-z]{32,88}\b/g;

/** Remove credential-like values and Solana-sized identifiers from runtime logs. */
export function redactText(value: unknown): string {
  return String(value)
    .replace(sensitiveAssignment, "$1$2[REDACTED]")
    .replace(sensitiveQuery, "$1[REDACTED]")
    .replace(bearer, "$1[REDACTED]")
    .replace(base58Identifier, "[REDACTED_SOLANA_ID]");
}

export function redactLogMeta(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return redactText(value);
  if (typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(redactLogMeta);
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [
    key,
    /key|token|secret|password|private|authorization|wallet|database|rpc/i.test(key)
      ? "[REDACTED]"
      : redactLogMeta(item),
  ]));
}
