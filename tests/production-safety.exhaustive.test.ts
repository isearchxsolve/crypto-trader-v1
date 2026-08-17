import { describe, expect, it } from "vitest";
import {
  evaluateAbsoluteDailyLoss,
  readPositiveNumber,
  redactLogMeta,
  redactText,
  validateStartupEnvironment,
} from "../server/production-safety";

// Trading loss controls need much denser coverage than ordinary application
// code. This grid covers sub-lamport through institutional-sized limits and
// values immediately below, equal to, and above every threshold.
const limits = Array.from({ length: 30 }, (_, index) => 10 ** (-9 + index * 0.3));
const multipliers = Array.from({ length: 41 }, (_, index) => (index - 20) / 10);
const lossCases = limits.flatMap(limit => multipliers.map(multiplier => ({ limit, multiplier, pnl: limit * multiplier })));

describe("absolute daily-loss breaker — exhaustive precision grid", () => {
  it.each(lossCases)("halts exactly at threshold: limit=$limit multiplier=$multiplier", ({ limit, pnl }) => {
    const actual = evaluateAbsoluteDailyLoss({ netDailyPnlSol: pnl, maxDailyLossSol: limit });
    const expectedLoss = pnl < 0 ? -pnl : 0;
    expect(actual.lossSol).toBeCloseTo(expectedLoss, 15);
    expect(actual.halt).toBe(pnl < 0 && expectedLoss >= limit);
    if (actual.halt) expect(actual.reason).toContain("MAX_DAILY_LOSS_SOL");
    else expect(actual.reason).toBeUndefined();
  });

  it.each([
    { pnl: Number.NaN, limit: 1 }, { pnl: Number.POSITIVE_INFINITY, limit: 1 },
    { pnl: Number.NEGATIVE_INFINITY, limit: 1 }, { pnl: -1, limit: 0 },
    { pnl: -1, limit: -1 }, { pnl: -1, limit: Number.NaN }, { pnl: -1, limit: undefined },
  ])("fails safe against invalid arithmetic without inventing a loss (%o)", ({ pnl, limit }) => {
    expect(evaluateAbsoluteDailyLoss({ netDailyPnlSol: pnl, maxDailyLossSol: limit }).halt).toBe(false);
  });
});

describe("configuration parser", () => {
  it.each([
    [undefined, undefined], ["", undefined], ["0", undefined], ["-0.01", undefined],
    ["NaN", undefined], ["Infinity", undefined], ["0.000000001", 0.000000001],
    ["0.5", 0.5], ["1000000000", 1000000000], [" 2 ", 2],
  ])("accepts only positive finite %s", (raw, expected) => {
    expect(readPositiveNumber({ MAX_DAILY_LOSS_SOL: raw }, "MAX_DAILY_LOSS_SOL")).toBe(expected);
  });

  it.each([
    [{}, "paper", 5000, [], []],
    [{ PORT: "65535", MODE: "paper" }, "paper", 65535, [], []],
    [{ PORT: "0" }, "paper", 5000, [], ["PORT"]],
    [{ PORT: "65536" }, "paper", 5000, [], ["PORT"]],
    [{ MODE: "unicode-🚀" }, "paper", 5000, [], ["MODE"]],
    [{ MODE: "live" }, "live", 5000, ["DATABASE_URL", "SOLANA_RPC_URL", "BIRDEYE_API_KEY", "WALLET_PRIVATE_KEY"], []],
    [{ MODE: "live", DATABASE_URL: "configured", SOLANA_RPC_URL: "configured", BIRDEYE_API_KEY: "configured", WALLET_PRIVATE_KEY: "configured" }, "live", 5000, [], []],
  ] as const)("reports names, never values", (env, mode, port, missing, invalid) => {
    const result = validateStartupEnvironment(env);
    expect(result.mode).toBe(mode);
    expect(result.port).toBe(port);
    expect(result.missing).toEqual(missing);
    expect(result.invalid).toEqual(invalid);
  });
});

describe("log redaction", () => {
  it.each([
    ["BIRDEYE_API_KEY=not-for-output", "BIRDEYE_API_KEY=[REDACTED]"],
    ["WALLET_PRIVATE_KEY: not-for-output", "WALLET_PRIVATE_KEY:[REDACTED]"],
    ["Bearer not-for-output", "Bearer [REDACTED]"],
    ["https://example.test/x?api-key=not-for-output", "https://example.test/x?api-key=[REDACTED]"],
    ["symbol=🚀漢字", "symbol=🚀漢字"],
    ["mint So11111111111111111111111111111111111111112", "mint [REDACTED_SOLANA_ID]"],
  ])("redacts sensitive content while retaining useful context", (input, expected) => {
    expect(redactText(input)).toBe(expected);
  });

  it("redacts nested sensitive fields and wallet-bearing objects", () => {
    const value = redactLogMeta({ provider: "birdeye", apiKey: "not-for-output", nested: { walletAddress: "not-for-output" }, symbol: "🚀" });
    expect(value).toEqual({ provider: "birdeye", apiKey: "[REDACTED]", nested: { walletAddress: "[REDACTED]" }, symbol: "🚀" });
  });
});
