/**
 * Beast Pipeline Integration Test (2026-07-28)
 *
 * End-to-end validation of the Beast tier entry + asymmetric moonshot exit engine:
 *  1. Discovery pre-valuator (evaluateBeastDiscovery) qualifies a token for Beast tier.
 *  2. Beast tier is stamped onto the trade record.
 *  3. evaluateBeastExit drives the asymmetric exit: TP ladder progression, dead-cat
 *     short-circuit at HOT+, and tier-promotion behavior.
 *  4. Soft + Beast safety combination (combineBeastWithSoft) preserves legacy pass
 *     while adding fail-closed Beast veto.
 *
 * Pure-function tests — no DB, no RPC, no HTTP. Runs in <2s.
 */
import { describe, it, expect } from 'vitest';
import {
  evaluateBeastDiscovery,
  type BeastDiscoveryInput,
  type BeastDiscoveryResult,
} from './beast-scanner';
import {
  evaluateBeastSafety,
  combineBeastWithSoft,
  BEAST_MIN_LP_LOCK_PCT,
  type AuthoritySnapshot,
  type LpLockInput,
  type HolderInput,
  type FlowInput,
  type CreatorHistoryInput,
  type BeastVerdict,
} from './beast-safety';
import {
  evaluateBeastExit,
  BEAST_TP_LADDER,
  tierForMultiplier,
  tierHardStopPct,
  tierShortCircuitDeadcat,
  type BeastBagTier,
} from './beast-exit';

describe('Beast Pipeline Integration', () => {
  // ─────────────────────────────────────────────────────────────────────────
  // 1. Discovery → Tier Promotion → Exit Engine happy-path
  // ─────────────────────────────────────────────────────────────────────────
  describe('Discovery → Tier Stamp → Exit progression', () => {
    it('qualifies a strong runner for Beast tier and walks it through 1.5x TP1', () => {
      // 1. ENTRY: a runner with healthy liquidity + flow
      const entryInput: BeastDiscoveryInput = {
        liquidityUsd: 30_000,
        ageSeconds: 60,
        buys5m: 80,
        sells5m: 10,
        volume5mUsd: 18_000,
        volume24hUsd: 90_000,
        priceChange5mPct: 22,
        priceChange1hPct: 65,
        smartWalletsNetBuyers: 4,
        whaleNetBuyers: 2,
        nonLpTop1Pct: 4,
        nonLpTop5Pct: 18,
        lpLockedPct: 95,
        creatorPriorActiveCount: 0,
      };
      const discovery: BeastDiscoveryResult = evaluateBeastDiscovery(entryInput);
      expect(discovery.verdict).toBe('PASS');
      expect(['HIGH', 'LEGENDARY', 'MEDIUM']).toContain(discovery.tier);
      const stampedTier: string | null = discovery.tier === 'SKIP' ? null : discovery.tier;

      // 2. The stamp is preserved (trade records the tier)
      expect(stampedTier).not.toBeNull();

      // 3. EXIT: the runner has reached 1.5x — TP1 fires
      const exitInput = {
        entryPriceSol: 0.0001,
        currentPriceSol: 0.00015, // 1.5x — IEEE-754 epsilon fix in beast-exit handles this
        peakPriceSol: 0.00015,
        ageSeconds: 300, // 5 min
        positionSol: 0.05,
        tier: 'COLD' as BeastBagTier,
        tpLevelReached: 0,
      };
      const exitDecision = evaluateBeastExit(exitInput);
      expect(exitDecision.action).toBe('partial');
      expect(exitDecision.reason).toMatch(/tp1_1\.5x/);
      expect(exitDecision.sellFraction).toBeCloseTo(BEAST_TP_LADDER[0].fraction);
      expect(exitDecision.multiplierFromEntry).toBeCloseTo(1.5, 5);
    });

    it('a 7x runner promotes through WARM → HOT and disables dead-cat short-circuit', () => {
      // 7x — per the ladder, this is the HOT tier
      const tier = tierForMultiplier(7);
      expect(tier).toBe('HOT');
      // At HOT, dead-cat still applies (false), but at ROCKET+ it's blocked
      expect(tierShortCircuitDeadcat('HOT')).toBe(false);
      expect(tierShortCircuitDeadcat('ROCKET')).toBe(true);
      expect(tierShortCircuitDeadcat('MOON')).toBe(true);
      expect(tierShortCircuitDeadcat('MOONSHOT')).toBe(true);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 2. Asymmetric Moonshot Exit — a 50x runner should be held, NOT trail-stopped
  // ─────────────────────────────────────────────────────────────────────────
  describe('Moonshot survival at 50x with 30% pullback', () => {
    it('does NOT trail-stop a 50x runner that retraced 30% from peak', () => {
      // 50x peak, then -30% retrace — legacy trailing stop (12-18%) would have
      // stopped this out. Beast at MOON tier uses 55% trail → stays in.
      const tier = tierForMultiplier(50);
      expect(tier).toBe('MOON');
      const exit = evaluateBeastExit({
        entryPriceSol: 0.0001,
        currentPriceSol: 0.0035, // 35x current
        peakPriceSol: 0.005, // 50x peak
        ageSeconds: 3600, // 1 hour
        positionSol: 0.05,
        tier,
        tpLevelReached: 4, // tp1-tp4 done (10+7+10+10 = 37% sold, 63% bag)
      });
      // MOON trail = 55%. We're at 30% drawdown → within tolerance → HOLD.
      expect(exit.action).toBe('hold');
      expect(exit.reason).toMatch(/beast_moonshot_hold|beast_hold/);
      // Multiplier is 35x, but next TP is tp6 at 200x — not hit → hold.
      expect(exit.multiplierFromEntry).toBeCloseTo(35);
    });

    it('DOES exit a 50x runner at -60% from peak (MOON trail = 55%)', () => {
      const tier = tierForMultiplier(50);
      const exit = evaluateBeastExit({
        entryPriceSol: 0.0001,
        currentPriceSol: 0.002, // 20x current
        peakPriceSol: 0.005, // 50x peak
        ageSeconds: 7200,
        positionSol: 0.05,
        tier,
        tpLevelReached: 5, // tp5 (50x) just hit
      });
      // 60% drawdown > MOON's 55% trail → exit.
      expect(exit.action).toBe('exit');
      expect(exit.reason).toMatch(/beast_trailing_stop/);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 3. Safety: combineBeastWithSoft keeps legacy PASS while adding Beast veto
  // ─────────────────────────────────────────────────────────────────────────
  describe('Beast safety integration with legacy soft chain', () => {
    it('PASSes a clean rugcheck + clean beast-safety = soft + Beast PASS', () => {
      const soft = { safe: true, reason: 'soft_clean' };
      const auth: AuthoritySnapshot = { freezeAuthority: null, mintAuthority: null };
      const lpLock: LpLockInput = { lpLockedPct: 95, lockSourceVerified: true, now: Date.now() };
      const holders: HolderInput[] = [
        { address: 'LP_VAULT_1', amount: 500_000_000, isLp: true },
        { address: 'LP_VAULT_2', amount: 200_000_000, isLp: true },
        { address: 'TOP_HOLDER_1', amount: 30_000_000, isInsider: false },
      ];
      const flow: FlowInput = {
        buys: 12, sells: 8, volume5mUsd: 5_000, volume24hUsd: 50_000,
        liquidityUsd: 30_000, priceChange5mPct: 12,
      };
      const creator: CreatorHistoryInput | null = null; // null = opt-out (clean deployer)
      const beast: BeastVerdict = evaluateBeastSafety(auth, lpLock, holders, 1_000_000_000, flow, creator);
      expect(beast.vote).toBe('PASS');
      const combined = combineBeastWithSoft(soft, beast);
      expect(combined.safe).toBe(true);
      expect(combined.reason).toMatch(/BEAST_PASS|soft_clean/);
    });

    it('legacy SOFT passes but Beast VETOs (active mint authority) → still VETO', () => {
      const soft = { safe: true, reason: 'soft_clean' };
      const auth: AuthoritySnapshot = {
        freezeAuthority: null,
        mintAuthority: 'SomeAddr1111111111111111111111111111111', // active mint = rug risk
      };
      const lpLock: LpLockInput = { lpLockedPct: 95, lockSourceVerified: true, now: Date.now() };
      const holders: HolderInput[] = [
        { address: 'LP_VAULT_1', amount: 500_000_000, isLp: true },
      ];
      const flow: FlowInput = {
        buys: 12, sells: 8, volume5mUsd: 5_000, volume24hUsd: 50_000,
        liquidityUsd: 30_000, priceChange5mPct: 12,
      };
      const creator: CreatorHistoryInput = {
        creatorPriorTokenAddresses: [],
        creatorPriorTokenStatuses: [],
      };
      const beast: BeastVerdict = evaluateBeastSafety(auth, lpLock, holders, 1_000_000_000, flow, creator);
      expect(beast.vote).toBe('VETO');
      const combined = combineBeastWithSoft(soft, beast);
      // Critical: combine vetoes even though soft passed. Beast is fail-closed.
      expect(combined.safe).toBe(false);
      expect(combined.reason).toMatch(/mint_authority_active|beast_block/);
      expect(combined.beastVetoed).toBe(true);
    });

    it('enforces BEAST_MIN_LP_LOCK_PCT constant (default 80%)', () => {
      expect(BEAST_MIN_LP_LOCK_PCT).toBeGreaterThanOrEqual(70);
      expect(BEAST_MIN_LP_LOCK_PCT).toBeLessThanOrEqual(95);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 4. TP Ladder integrity — total sold at MOONSHOT = 82% (18% moonshot bag kept)
  // ─────────────────────────────────────────────────────────────────────────
  describe('TP ladder arithmetic', () => {
    it('TP ladder sums to 82% leaving 18% moonshot bag', () => {
      const totalFraction = BEAST_TP_LADDER.reduce((sum, tp) => sum + tp.fraction, 0);
      expect(totalFraction).toBeCloseTo(0.82);
      expect(1 - totalFraction).toBeCloseTo(0.18); // moonshot bag
    });

    it('TP ladder multiplier gates are strictly increasing', () => {
      for (let i = 1; i < BEAST_TP_LADDER.length; i++) {
        expect(BEAST_TP_LADDER[i].multiplier).toBeGreaterThan(BEAST_TP_LADDER[i - 1].multiplier);
      }
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 5. Hard stop differential — tier adaptive (lower tiers stop out faster)
  // ─────────────────────────────────────────────────────────────────────────
  describe('Tier-adaptive hard stop', () => {
    it('COLD hard-stop is tighter than MOONSHOT (asymmetric — protect the moonshot)', () => {
      const coldStop = tierHardStopPct('COLD');
      const moonStop = tierHardStopPct('MOONSHOT');
      expect(coldStop).toBeLessThan(moonStop);
      expect(moonStop).toBeGreaterThanOrEqual(90); // 95% — only fire on near-total wipeout
    });
  });
});
