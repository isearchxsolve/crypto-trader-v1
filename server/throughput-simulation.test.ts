import { describe, expect, it } from "vitest";

// ─── constants (mirrors routes.ts exit cascade + engineSettings) ───
const TRAILING_STOP_ACTIVATION = 12;
const TRAILING_STOP_PCT = 5;
const HARD_TAKE_PROFIT = 100_000_000;
const STOP_LOSS_PCT = -22;
const HARD_LOSS_PCT = -45;
const DEEP_RUG_PCT = -50;
const DYNAMIC_HOLD_MAX_SEC = 14400;
const PRICE_CHECK_MS = 500;
const SCAN_INTERVAL_MS = 2000;
const SCAN_CYCLE_DURATION_SEC = 7;

const NEVER_GREEN_PEAK_PCT = 1.0;
const NEVER_GREEN_CUT_PCT = -5.0;
const NEVER_GREEN_MIN_HOLD = 18;

const STAGNANT_GREEN_KILL_SEC = 1500;
const DIP_RECOVERY_FAILED_SEC = 1800;
const MOMENTUM_FADE_HOLD = 45;

// trailing floor ladder (routes.ts:4749)
function trailingFloor(peakPnl: number): number {
  if (peakPnl > 30) return peakPnl * 0.60;
  if (peakPnl > 15) return peakPnl * 0.50;
  if (peakPnl > 8) return peakPnl * 0.40;
  if (peakPnl > 3) return peakPnl * 0.20;
  return 0;
}

// ─── exit cascade (mirrors routes.ts:4805-4837) ───
interface ExitInput {
  pnlPct: number;
  peakPnl: number;
  holdTime: number;
  bp5m: number;
  pc5m: number;
  volLiqRatio: number;
  vol5m: number;
  expVol5m: number;
  liqCollapsed: boolean;
  liqDroppedThreshold: boolean;
  pairExists: boolean;
}

interface ExitResult {
  shouldClose: boolean;
  reason: string;
}

function simulateExitCascade(input: ExitInput): ExitResult {
  const { pnlPct, peakPnl, holdTime, bp5m, pc5m, volLiqRatio, vol5m, expVol5m, liqCollapsed, liqDroppedThreshold, pairExists } = input;
  const drawdownFromPeak = peakPnl > 0 ? ((peakPnl - pnlPct) / peakPnl) * 100 : 0;

  // Tier 1: survival / emergency
  if (pnlPct <= DEEP_RUG_PCT) return { shouldClose: true, reason: `DEEP_RUG_KILL` };
  if (pairExists && (liqCollapsed || liqDroppedThreshold)) return { shouldClose: true, reason: `LIQ_COLLAPSE` };
  if (pnlPct <= HARD_LOSS_PCT) return { shouldClose: true, reason: `HARD_LOSS_KILL` };
  if (pnlPct <= STOP_LOSS_PCT) return { shouldClose: true, reason: `STOP_LOSS` };

  // Tier 2: profit capture
  if (pnlPct >= HARD_TAKE_PROFIT) return { shouldClose: true, reason: `HARD_TAKE_PROFIT` };
  const tf = trailingFloor(peakPnl);
  if (peakPnl >= TRAILING_STOP_ACTIVATION && (drawdownFromPeak >= TRAILING_STOP_PCT || (tf > 0 && pnlPct <= tf))) {
    return { shouldClose: true, reason: `TRAIL_STOP` };
  }

  // Tier 3: stop / loss management
  if (peakPnl <= NEVER_GREEN_PEAK_PCT && holdTime > NEVER_GREEN_MIN_HOLD && pnlPct <= NEVER_GREEN_CUT_PCT) {
    return { shouldClose: true, reason: `NEVER_GREEN_CUT` };
  }

  // Tier 4: momentum / structure fades
  if (pnlPct > 10 && bp5m < 0.43 && pc5m < -3) return { shouldClose: true, reason: `EARLY_EXIT_WEAK_BP` };
  if (holdTime > MOMENTUM_FADE_HOLD && bp5m < 0.38 && pc5m < -2) return { shouldClose: true, reason: `MOMENTUM_FADE` };
  if (holdTime > MOMENTUM_FADE_HOLD && pnlPct > 5 && bp5m < 0.43 && pc5m < -4) return { shouldClose: true, reason: `PROFIT_PROTECT_FADE` };
  if (pnlPct > 5 && volLiqRatio > 7) return { shouldClose: true, reason: `LIQUIDITY_EXHAUSTION` };
  if (holdTime > 180 && pnlPct > 1 && expVol5m > 100 && vol5m < expVol5m * 0.15) return { shouldClose: true, reason: `VOL_COLLAPSE` };

  // Tier 5: time stops
  if (holdTime > STAGNANT_GREEN_KILL_SEC && pnlPct >= 0 && pnlPct < 20) return { shouldClose: true, reason: `STAGNANT_GREEN_KILL` };
  if (holdTime > DIP_RECOVERY_FAILED_SEC && pnlPct < 0) return { shouldClose: true, reason: `DIP_RECOVERY_FAILED` };
  if (holdTime > DYNAMIC_HOLD_MAX_SEC) return { shouldClose: true, reason: `ABSOLUTE_MAX_HOLD` };

  return { shouldClose: false, reason: "HOLD" };
}

// ─── price path simulation ───
interface PriceStep {
  t: number;       // seconds
  pnl: number;     // % from entry
  bp: number;      // buy pressure
  pc: number;      // price change 5m %
}

interface TickResult {
  exitTime: number;
  exitReason: string;
}

function simulatePricePath(pricePath: PriceStep[], tradeType: string): TickResult {
  const maxTime = Math.max(...pricePath.map(s => s.t));
  let peakPnl = -Infinity;

  for (let t = 0; t <= maxTime; t += PRICE_CHECK_MS / 1000) {
    // interpolate price at current time
    const step = [...pricePath].reverse().find(s => s.t <= t) ?? pricePath[0];
    const pnlPct = step.pnl;
    const bp5m = step.bp;
    const pc5m = step.pc;
    if (pnlPct > peakPnl) peakPnl = pnlPct;

    const result = simulateExitCascade({
      pnlPct,
      peakPnl,
      holdTime: t,
      bp5m,
      pc5m,
      volLiqRatio: 2.0,
      vol5m: 5000,
      expVol5m: 10000,
      liqCollapsed: false,
      liqDroppedThreshold: false,
      pairExists: true,
    });

    if (result.shouldClose) {
      return { exitTime: t, exitReason: result.reason };
    }
  }

  return { exitTime: maxTime, exitReason: "MAX_TIME" };
}

function throughputTradesPerMin(avgHoldTimeSec: number): number {
  const cycleSec = avgHoldTimeSec + SCAN_CYCLE_DURATION_SEC;
  return 60 / cycleSec;
}

// ─── Trade archetype definitions ───
//
// Archetypes must satisfy: if peakPnl <= 1%, NEVER_GREEN_CUT fires at -5%/18s
// before any other loss exit. To hit other exits, the path must either:
//   (a) dump past -22% before 18s (STOP_LOSS wins), or
//   (b) reach peakPnl > 1% so NEVER_GREEN_CUT doesn't apply.
//
// NEVER_GREEN (35%): never clears +1% peak, steadily bleeds
//   → exits via NEVER_GREEN_CUT at -5% / ~20s
const NEVER_GREEN_PATH: PriceStep[] = [
  { t: 0, pnl: 0, bp: 0.50, pc: 0 },
  { t: 5, pnl: -1.5, bp: 0.45, pc: -2 },
  { t: 10, pnl: -3.0, bp: 0.40, pc: -3 },
  { t: 15, pnl: -4.2, bp: 0.38, pc: -4 },
  { t: 20, pnl: -5.5, bp: 0.35, pc: -5 },
  { t: 25, pnl: -7.0, bp: 0.32, pc: -6 },
  { t: 30, pnl: -8.0, bp: 0.30, pc: -7 },
];

// RAPID_DUMP (5%): gaps past -22% before 18s holdTime → STOP_LOSS fires first
const RAPID_DUMP_PATH: PriceStep[] = [
  { t: 0, pnl: 0, bp: 0.50, pc: 0 },
  { t: 5, pnl: -10, bp: 0.30, pc: -15 },
  { t: 10, pnl: -22, bp: 0.20, pc: -25 },
  { t: 15, pnl: -30, bp: 0.15, pc: -30 },
];

// BRIEF_GREEN_DUMP (10%): briefly touches +2% peak (avoids NEVER_GREEN_CUT),
//   then dumps to -22% while bp stays above 0.38 (avoids MOMENTUM_FADE).
//   → STOP_LOSS fires at -22%.
const BRIEF_GREEN_DUMP_PATH: PriceStep[] = [
  { t: 0, pnl: 0, bp: 0.55, pc: 0 },
  { t: 10, pnl: 2, bp: 0.52, pc: 1 },
  { t: 20, pnl: -5, bp: 0.48, pc: -8 },
  { t: 30, pnl: -12, bp: 0.45, pc: -12 },
  { t: 40, pnl: -18, bp: 0.42, pc: -18 },
  { t: 50, pnl: -22, bp: 0.40, pc: -22 },
];

// MOMENTUM_FADE (15%): brief pump then fades
//   → exits via MOMENTUM_FADE (bp<0.38, pc<-2, hold>45s)
const MOMENTUM_FADE_PATH: PriceStep[] = [
  { t: 0, pnl: 0, bp: 0.55, pc: 0 },
  { t: 15, pnl: 4, bp: 0.58, pc: 3 },
  { t: 30, pnl: 8, bp: 0.55, pc: 2 },
  { t: 45, pnl: 7, bp: 0.48, pc: -1 },
  { t: 60, pnl: 6, bp: 0.42, pc: -2 },
  { t: 75, pnl: 5, bp: 0.38, pc: -3 },
  { t: 90, pnl: 4, bp: 0.35, pc: -4 },
  { t: 120, pnl: 3, bp: 0.32, pc: -5 },
];

// TRAIL_STOP (10%): solid pump to +20% peak, then pullback
//   → exits via TRAIL_STOP when drawdown >= 5% from peak or trailingFloor hit
const TRAIL_STOP_PATH: PriceStep[] = [
  { t: 0, pnl: 0, bp: 0.55, pc: 0 },
  { t: 30, pnl: 5, bp: 0.60, pc: 4 },
  { t: 60, pnl: 10, bp: 0.62, pc: 5 },
  { t: 90, pnl: 15, bp: 0.60, pc: 3 },
  { t: 120, pnl: 20, bp: 0.58, pc: 2 },
  { t: 135, pnl: 18, bp: 0.55, pc: 0 },
  { t: 150, pnl: 16, bp: 0.52, pc: -1 },
  { t: 165, pnl: 14, bp: 0.50, pc: -2 },
  { t: 180, pnl: 12, bp: 0.48, pc: -3 },
  { t: 240, pnl: 10, bp: 0.45, pc: -4 },
];

// STAGNANT_GREEN (15%): small green but not mooning
//   → exits via STAGNANT_GREEN_KILL at 1500s
const STAGNANT_GREEN_PATH: PriceStep[] = [
  { t: 0, pnl: 0, bp: 0.55, pc: 0 },
  { t: 60, pnl: 5, bp: 0.52, pc: 2 },
  { t: 300, pnl: 5, bp: 0.50, pc: 0 },
  { t: 600, pnl: 4, bp: 0.48, pc: 0 },
  { t: 900, pnl: 4, bp: 0.48, pc: 0 },
  { t: 1200, pnl: 4, bp: 0.48, pc: 0 },
  { t: 1500, pnl: 4, bp: 0.48, pc: 0 },
  { t: 1800, pnl: 4, bp: 0.48, pc: 0 },
];

// DIP_RECOVERY_FAILED (10%): briefly green (+5% peak, avoids NEVER_GREEN_CUT),
//   dips negative, never recovers → DIP_RECOVERY_FAILED at 1800s
const DIP_RECOVERY_PATH: PriceStep[] = [
  { t: 0, pnl: 0, bp: 0.55, pc: 0 },
  { t: 60, pnl: 5, bp: 0.52, pc: 2 },
  { t: 300, pnl: 0, bp: 0.45, pc: -2 },
  { t: 600, pnl: -4, bp: 0.40, pc: -1 },
  { t: 900, pnl: -4, bp: 0.40, pc: 0 },
  { t: 1200, pnl: -3, bp: 0.40, pc: 0 },
  { t: 1500, pnl: -3, bp: 0.40, pc: 0 },
  { t: 1800, pnl: -3, bp: 0.40, pc: 0 },
  { t: 2100, pnl: -3, bp: 0.40, pc: 0 },
];

interface Archetype {
  name: string;
  fraction: number;
  path: PriceStep[];
  expectedExit: string;
}

const ARCHETYPES: Archetype[] = [
  { name: "NEVER_GREEN", fraction: 0.35, path: NEVER_GREEN_PATH, expectedExit: "NEVER_GREEN_CUT" },
  { name: "RAPID_DUMP", fraction: 0.05, path: RAPID_DUMP_PATH, expectedExit: "STOP_LOSS" },
  { name: "BRIEF_GREEN_DUMP", fraction: 0.10, path: BRIEF_GREEN_DUMP_PATH, expectedExit: "STOP_LOSS" },
  { name: "MOMENTUM_FADE", fraction: 0.15, path: MOMENTUM_FADE_PATH, expectedExit: "MOMENTUM_FADE" },
  { name: "TRAIL_STOP", fraction: 0.10, path: TRAIL_STOP_PATH, expectedExit: "TRAIL_STOP" },
  { name: "STAGNANT_GREEN", fraction: 0.15, path: STAGNANT_GREEN_PATH, expectedExit: "STAGNANT_GREEN_KILL" },
  { name: "DIP_RECOVERY", fraction: 0.10, path: DIP_RECOVERY_PATH, expectedExit: "DIP_RECOVERY_FAILED" },
];

// ─── TESTS ───

describe("throughput-simulation", () => {
  for (const arch of ARCHETYPES) {
    it(`${arch.name} exits via ${arch.expectedExit}`, () => {
      const result = simulatePricePath(arch.path, arch.name);
      expect(result.exitReason).toBe(arch.expectedExit);
    });
  }

  it("NEVER_GREEN_CUT fires at -5% before STOP_LOSS would fire at -22%", () => {
    const result = simulatePricePath(NEVER_GREEN_PATH, "NEVER_GREEN");
    // Exits at first tick where pnl <= -5% and holdTime > 18s
    expect(result.exitTime).toBeGreaterThanOrEqual(NEVER_GREEN_MIN_HOLD);
    expect(result.exitTime).toBeLessThan(30);
    expect(result.exitReason).toBe("NEVER_GREEN_CUT");
  });

  it("RAPID_DUMP hits STOP_LOSS before NEVER_GREEN_CUT (hold < 18s at -22%)", () => {
    const result = simulatePricePath(RAPID_DUMP_PATH, "RAPID_DUMP");
    expect(result.exitReason).toBe("STOP_LOSS");
    expect(result.exitTime).toBeLessThan(NEVER_GREEN_MIN_HOLD);
  });

  it("BRIEF_GREEN_DUMP hits STOP_LOSS (peak>1% so NEVER_GREEN_CUT skipped, goes to -22%)", () => {
    const result = simulatePricePath(BRIEF_GREEN_DUMP_PATH, "BRIEF_GREEN_DUMP");
    expect(result.exitReason).toBe("STOP_LOSS");
    expect(result.exitTime).toBeGreaterThanOrEqual(45);
  });

  it("throughput improved 2x+ vs baseline (no NEVER_GREEN_CUT)", () => {
    // Baseline: NEVER_GREEN trades held 1800s (DIP_RECOVERY_FAILED) before our changes
    const baselineWeighted = 0.35 * 1800 + 0.05 * 10 + 0.10 * 50 + 0.15 * 90 + 0.10 * 135 + 0.15 * 1500 + 0.10 * 1800;
    const baselineTpmin = throughputTradesPerMin(baselineWeighted);

    const results: Array<{ name: string; exitTime: number }> = [];
    for (const arch of ARCHETYPES) {
      const result = simulatePricePath(arch.path, arch.name);
      results.push({ name: arch.name, exitTime: result.exitTime });
    }

    const weightedAvg = results.reduce(
      (sum, r, i) => sum + r.exitTime * ARCHETYPES[i].fraction,
      0
    );

    const tpmin = throughputTradesPerMin(weightedAvg);
    const tphour = tpmin * 60;
    const improvement = tpmin / Math.max(0.001, baselineTpmin);

    console.log(""); // spacing
    for (const r of results) {
      const arch = ARCHETYPES.find(a => a.name === r.name)!;
      console.log(`  ${r.name.padEnd(20)} ${(arch.fraction * 100).toFixed(0)}%  → ${r.exitTime.toFixed(1)}s  ${r.exitTime >= 1800 ? "(time-stop)" : ""}`);
    }
    console.log(`  ${"─".repeat(50)}`);
    console.log(`  Weighted avg hold  ${weightedAvg.toFixed(1)}s  (baseline: ${baselineWeighted.toFixed(0)}s)`);
    console.log(`  Overhead/cycle     ${SCAN_CYCLE_DURATION_SEC}s`);
    console.log(`  Trades/min         ${tpmin.toFixed(3)}  (baseline: ${baselineTpmin.toFixed(3)})`);
    console.log(`  Trades/hour        ${tphour.toFixed(1)}  (baseline: ${(baselineTpmin * 60).toFixed(1)})`);
    console.log(`  Improvement        ${improvement.toFixed(1)}x`);
    console.log(`  NOTE: 1 trade/min requires avg hold ≤53s. Dominant anchors:`);
    console.log(`    STAGNANT_GREEN_KILL(1500s, 15%) and DIP_RECOVERY_FAILED(1800s, 10%)`);
    console.log(`    together account for 25% of trades at 25-30min each.`);

    // Assert: improvement >= 2x vs baseline, absolute throughput > 0.1 trades/min
    expect(improvement).toBeGreaterThanOrEqual(2.0);
    expect(tpmin).toBeGreaterThan(0.1);
  });
});
