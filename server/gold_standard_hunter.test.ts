import { describe, expect, it } from "vitest";

import {
  goldScore,
  scoreTier,
  evaluateDevFundingAge,
  evaluateVolumeSpikeAuthenticity,
  type GoldSignal,
  type GmgnTokenInfo,
  type DexPair,
} from "./gold_standard_hunter";

// Helper to create minimal GmgnTokenInfo with required fields
function createGmgnTokenInfo(overrides: Partial<GmgnTokenInfo> = {}): GmgnTokenInfo {
  return {
    address: "test",
    holder_count: 1000,
    creation_timestamp: Date.now() / 1000 - 3600,
    launchpad_platform: "pump",
    dev: { creator_address: "test", creator_open_count: 1, creator_token_status: "hold", top_10_holder_rate: 0.1 },
    stat: { rat_trader_amount_rate: 0.01, top_bundler_trader_percentage: 0.05, top_entrapment_trader_percentage: 0.05, fresh_wallet_rate: 0.2 },
    price: {},
    ...overrides,
  };
}

describe("gold_standard_hunter", () => {
  describe("scoreTier", () => {
    it("returns LEGENDARY for score >= 75", () => {
      expect(scoreTier(75)).toBe("LEGENDARY");
      expect(scoreTier(80)).toBe("LEGENDARY");
      expect(scoreTier(100)).toBe("LEGENDARY");
    });

    it("returns HIGH for score >= 50", () => {
      expect(scoreTier(50)).toBe("HIGH");
      expect(scoreTier(60)).toBe("HIGH");
      expect(scoreTier(74)).toBe("HIGH");
    });

    it("returns MEDIUM for score >= 35", () => {
      expect(scoreTier(35)).toBe("MEDIUM");
      expect(scoreTier(40)).toBe("MEDIUM");
      expect(scoreTier(49)).toBe("MEDIUM");
    });

    it("returns SKIP for score < 35", () => {
      expect(scoreTier(0)).toBe("SKIP");
      expect(scoreTier(20)).toBe("SKIP");
      expect(scoreTier(34)).toBe("SKIP");
    });
  });

  describe("goldScore - Layer 1: Hard Gates", () => {
    it("hard rejects Meteora virtual curve platform", () => {
      const gmgn = createGmgnTokenInfo({
        launchpad_platform: "meteora_virtual_curve",
      });

      const signals: string[] = [];
      const score = goldScore(gmgn, null, signals);

      expect(score).toBe(-1);
    });

    it("hard rejects honeypot tokens", () => {
      const gmgn = createGmgnTokenInfo({
        security: { is_honeypot: true },
      });

      const signals: string[] = [];
      const score = goldScore(gmgn, null, signals);

      expect(score).toBe(-1);
    });

    it("hard rejects wash trading tokens", () => {
      const gmgn = createGmgnTokenInfo({
        stat: { rat_trader_amount_rate: 0.01, top_bundler_trader_percentage: 0.05, top_entrapment_trader_percentage: 0.05, fresh_wallet_rate: 0.2, is_wash_trading: true },
      });

      const signals: string[] = [];
      const score = goldScore(gmgn, null, signals);

      expect(score).toBe(-1);
    });

    it("hard rejects high entrapment rate > 10%", () => {
      const gmgn = createGmgnTokenInfo({
        stat: { rat_trader_amount_rate: 0.01, top_bundler_trader_percentage: 0.05, top_entrapment_trader_percentage: 0.15, fresh_wallet_rate: 0.2 },
      });

      const signals: string[] = [];
      const score = goldScore(gmgn, null, signals);

      expect(score).toBe(-1);
    });

    it("hard rejects high fresh wallet rate > 40%", () => {
      const gmgn = createGmgnTokenInfo({
        stat: { rat_trader_amount_rate: 0.01, top_bundler_trader_percentage: 0.05, top_entrapment_trader_percentage: 0.05, fresh_wallet_rate: 0.5 },
      });

      const signals: string[] = [];
      const score = goldScore(gmgn, null, signals);

      expect(score).toBe(-1);
    });

    it("hard rejects CTO without smart money", () => {
      const gmgn = createGmgnTokenInfo({
        dev: { creator_address: "test", creator_open_count: 1, creator_token_status: "hold", top_10_holder_rate: 0.1, cto_flag: 1 },
        wallet_tags_stat: { smart_wallets: 0, renowned_wallets: 0, sniper_wallets: 0 },
      });

      const signals: string[] = [];
      const score = goldScore(gmgn, null, signals);

      expect(score).toBe(-1);
    });

    it("hard rejects dev who deleted >3 tweets", () => {
      const gmgn = createGmgnTokenInfo({
        dev: { creator_address: "test", creator_open_count: 1, creator_token_status: "hold", top_10_holder_rate: 0.1, twitter_del_post_token_count: 5 },
      });

      const signals: string[] = [];
      const score = goldScore(gmgn, null, signals);

      expect(score).toBe(-1);
    });

    it("allows CTO with smart money >= 2", () => {
      const gmgn = createGmgnTokenInfo({
        dev: { creator_address: "test", creator_open_count: 1, creator_token_status: "hold", top_10_holder_rate: 0.1, cto_flag: 1 },
        wallet_tags_stat: { smart_wallets: 3, renowned_wallets: 0, sniper_wallets: 0 },
      });

      const signals: string[] = [];
      const score = goldScore(gmgn, null, signals);

      expect(score).toBeGreaterThan(0);
    });
  });

  describe("goldScore - Layer 2: Creator Integrity", () => {
    it("awards +20 for true first-timer (0 or 1 token)", () => {
      const gmgn = createGmgnTokenInfo({
        dev: { creator_address: "test", creator_open_count: 0, creator_token_status: "hold", top_10_holder_rate: 0.1 },
      });

      const signals: string[] = [];
      const score = goldScore(gmgn, null, signals);

      expect(score).toBeGreaterThanOrEqual(20);
      expect(signals).toContain("TRUE first-timer (+20)");
    });

    it("awards +12 for low serial creator (2-5 tokens)", () => {
      const gmgn = createGmgnTokenInfo({
        dev: { creator_address: "test", creator_open_count: 3, creator_token_status: "hold", top_10_holder_rate: 0.1 },
      });

      const signals: string[] = [];
      const score = goldScore(gmgn, null, signals);

      expect(score).toBeGreaterThanOrEqual(12);
      expect(signals.some(s => s.includes("Low serial creator"))).toBe(true);
    });

    it("penalizes -10 for factory deployer (>20 tokens)", () => {
      const gmgn = createGmgnTokenInfo({
        dev: { creator_address: "test", creator_open_count: 25, creator_token_status: "hold", top_10_holder_rate: 0.1 },
      });

      const signals: string[] = [];
      goldScore(gmgn, null, signals);

      expect(signals).toContain("Factory deployer (>20 tokens, -10)");
    });

    it("awards +5 for dev holding", () => {
      const gmgn = createGmgnTokenInfo();

      const signals: string[] = [];
      goldScore(gmgn, null, signals);

      expect(signals).toContain("Dev holding (+5)");
    });

    it("penalizes -15 for dev selling", () => {
      const gmgn = createGmgnTokenInfo({
        dev: { creator_address: "test", creator_open_count: 1, creator_token_status: "sell", top_10_holder_rate: 0.1 },
      });

      const signals: string[] = [];
      goldScore(gmgn, null, signals);

      expect(signals).toContain("Dev SOLD (-15)");
    });

    it("awards +5 for proven creator >$5M ATH", () => {
      const gmgn = createGmgnTokenInfo({
        dev: { creator_address: "test", creator_open_count: 1, creator_token_status: "hold", top_10_holder_rate: 0.1, ath_token_info: { ath_mc: 10_000_000 } },
      });

      const signals: string[] = [];
      goldScore(gmgn, null, signals);

      expect(signals).toContain("Proven creator >$5M ATH (+5)");
    });
  });

  describe("goldScore - Layer 3: Quality Thresholds", () => {
    it("awards +20 for holder sweet spot (1000-5000)", () => {
      const gmgn = createGmgnTokenInfo({ holder_count: 2500 });

      const signals: string[] = [];
      const score = goldScore(gmgn, null, signals);

      expect(signals.some(s => s.includes("SWEET SPOT"))).toBe(true);
    });

    it("awards +10 for building holders (500-999)", () => {
      const gmgn = createGmgnTokenInfo({ holder_count: 750 });

      const signals: string[] = [];
      goldScore(gmgn, null, signals);

      expect(signals.some(s => s.includes("building"))).toBe(true);
    });

    it("penalizes -5 for too low holders", () => {
      const gmgn = createGmgnTokenInfo({ holder_count: 100 });

      const signals: string[] = [];
      goldScore(gmgn, null, signals);

      expect(signals).toContain("Holders 100 [too low, -5]");
    });

    it("awards +15 for high liquidity >= $100K", () => {
      const dex: DexPair = {
        pairAddress: "test",
        baseToken: { address: "test", symbol: "TEST", name: "Test" },
        liquidity: { usd: 150_000 },
      };

      const gmgn = createGmgnTokenInfo();

      const signals: string[] = [];
      goldScore(gmgn, dex, signals);

      expect(signals).toContain("Liquidity $150K [308x ratio] (+15)");
    });

    it("awards +12 for medium liquidity >= $50K", () => {
      const dex: DexPair = {
        pairAddress: "test",
        baseToken: { address: "test", symbol: "TEST", name: "Test" },
        liquidity: { usd: 75_000 },
      };

      const gmgn = createGmgnTokenInfo();

      const signals: string[] = [];
      goldScore(gmgn, dex, signals);

      expect(signals).toContain("Liquidity $75K [369x ratio] (+12)");
    });

    it("penalizes -10 for low liquidity <$10K", () => {
      const dex: DexPair = {
        pairAddress: "test",
        baseToken: { address: "test", symbol: "TEST", name: "Test" },
        liquidity: { usd: 5_000 },
      };

      const gmgn = createGmgnTokenInfo();

      const signals: string[] = [];
      goldScore(gmgn, dex, signals);

      expect(signals).toContain("Liquidity $5000 [TRENCHES <$10K, +0]");
    });

    it("awards +10 for optimal market cap $100K-$1M", () => {
      const dex: DexPair = {
        pairAddress: "test",
        baseToken: { address: "test", symbol: "TEST", name: "Test" },
        marketCap: 500_000,
      };

      const gmgn = createGmgnTokenInfo();

      const signals: string[] = [];
      goldScore(gmgn, dex, signals);

      expect(signals).toContain("MCap $500K [78% moon, +10]");
    });
  });

  describe("goldScore - Layer 4: Timing Precision", () => {
    it("awards +15 for tokens < 1 hour old", () => {
      const gmgn = createGmgnTokenInfo({
        creation_timestamp: Date.now() / 1000 - 1800, // 30 minutes old
      });

      const signals: string[] = [];
      goldScore(gmgn, null, signals);

      expect(signals.some(s => s.includes("<1h FIRE") && s.includes("+15"))).toBe(true);
    });

    it("awards +10 for tokens well under MAX_TOKEN_AGE_HOURS (72h)", () => {
      const gmgn = createGmgnTokenInfo({
        creation_timestamp: Date.now() / 1000 - 10800, // 3 hours old
      });

      const signals: string[] = [];
      goldScore(gmgn, null, signals);

      expect(signals.some(s => s.includes("<72h") && s.includes("+10"))).toBe(true);
    });

    it("penalizes -5 for stale tokens > MAX_TOKEN_AGE_HOURS (72h)", () => {
      const gmgn = createGmgnTokenInfo({
        creation_timestamp: Date.now() / 1000 - 300000, // ~83 hours old
      });

      const signals: string[] = [];
      goldScore(gmgn, null, signals);

      expect(signals.some(s => s.includes("stale") && s.includes("-5"))).toBe(true);
    });

    it("awards +15 for buy ratio >= 99%", () => {
      const dex: DexPair = {
        pairAddress: "test",
        baseToken: { address: "test", symbol: "TEST", name: "Test" },
        txns: { h1: { buys: 990, sells: 10 }, m5: { buys: 0, sells: 0 } },
      };

      const gmgn = createGmgnTokenInfo();

      const signals: string[] = [];
      goldScore(gmgn, dex, signals);

      expect(signals.some(s => s.includes("BuyRatio") && s.includes("+15"))).toBe(true);
    });

    it("awards +10 for buy ratio >= 97%", () => {
      const dex: DexPair = {
        pairAddress: "test",
        baseToken: { address: "test", symbol: "TEST", name: "Test" },
        txns: { h1: { buys: 970, sells: 30 }, m5: { buys: 0, sells: 0 } },
      };

      const gmgn = createGmgnTokenInfo();

      const signals: string[] = [];
      goldScore(gmgn, dex, signals);

      expect(signals.some(s => s.includes("BuyRatio") && s.includes("+10"))).toBe(true);
    });

    it("penalizes -5 for weak buy ratio < 40%", () => {
      const dex: DexPair = {
        pairAddress: "test",
        baseToken: { address: "test", symbol: "TEST", name: "Test" },
        txns: { h1: { buys: 300, sells: 700 }, m5: { buys: 0, sells: 0 } },
      };

      const gmgn = createGmgnTokenInfo();

      const signals: string[] = [];
      goldScore(gmgn, dex, signals);

      expect(signals).toContain("BuyRatio 30.0% [weak, -5]");
    });

    it("awards +15 for explosive volume acceleration >= 5x", () => {
      const dex: DexPair = {
        pairAddress: "test",
        baseToken: { address: "test", symbol: "TEST", name: "Test" },
        volume: { m5: 50_000, h1: 100_000, h24: 100_000 },
      };

      const gmgn = createGmgnTokenInfo({
        price: { volume_5m: 50_000, volume_24h: 100_000, volume_1h: 100_000, buys_1h: 0, sells_1h: 0 },
      });

      const signals: string[] = [];
      goldScore(gmgn, dex, signals);

      expect(signals).toContain("VolAccel 144.0x [EXPLOSION] (+15)");
    });

    it("awards +10 for elite capital efficiency >= $2000/swap", () => {
      const dex: DexPair = {
        pairAddress: "test",
        baseToken: { address: "test", symbol: "TEST", name: "Test" },
        volume: { m5: 0, h1: 1_000_000, h24: 0 },
        txns: { h1: { buys: 100, sells: 0 }, m5: { buys: 0, sells: 0 } },
      };

      const gmgn = createGmgnTokenInfo({
        price: { volume_1h: 1_000_000, buys_1h: 100, volume_5m: 0, volume_24h: 0, sells_1h: 0 },
      });

      const signals: string[] = [];
      goldScore(gmgn, dex, signals);

      expect(signals).toContain("CapEff $10000/swap [elite] (+10)");
    });
  });

  describe("goldScore - Layer 5: Organic Conviction", () => {
    it("awards +20 for stage 2 breakout (>=5 smart degens)", () => {
      const gmgn = createGmgnTokenInfo({
        wallet_tags_stat: { smart_wallets: 5, renowned_wallets: 0, sniper_wallets: 0 },
      });

      const signals: string[] = [];
      goldScore(gmgn, null, signals);

      expect(signals).toContain("SmartDegens 5 [STAGE 2 BREAKOUT] (+20)");
    });

    it("awards +15 for conviction (3-4 smart degens)", () => {
      const gmgn = createGmgnTokenInfo({
        wallet_tags_stat: { smart_wallets: 3, renowned_wallets: 0, sniper_wallets: 0 },
      });

      const signals: string[] = [];
      goldScore(gmgn, null, signals);

      expect(signals).toContain("SmartDegens 3 [conviction] (+15)");
    });

    it("penalizes -5 for no smart money", () => {
      const gmgn = createGmgnTokenInfo();

      const signals: string[] = [];
      goldScore(gmgn, null, signals);

      expect(signals).toContain("No smart money (-5)");
    });

    it("awards +12 for very low rat rate < 1%", () => {
      const gmgn = createGmgnTokenInfo({
        stat: { rat_trader_amount_rate: 0.005, top_bundler_trader_percentage: 0.05, top_entrapment_trader_percentage: 0.05, fresh_wallet_rate: 0.2 },
      });

      const signals: string[] = [];
      goldScore(gmgn, null, signals);

      expect(signals).toContain("RatRate 0.5% [12.5x edge] (+12)");
    });

    it("penalizes -8 for bot dominated rat rate > 10%", () => {
      const gmgn = createGmgnTokenInfo({
        stat: { rat_trader_amount_rate: 0.15, top_bundler_trader_percentage: 0.05, top_entrapment_trader_percentage: 0.05, fresh_wallet_rate: 0.2 },
      });

      const signals: string[] = [];
      goldScore(gmgn, null, signals);

      expect(signals).toContain("RatRate 15.0% [bot dominated, -8]");
    });

    it("awards +10 for gold standard social (Twitter+Web no TG)", () => {
      const gmgn = createGmgnTokenInfo({
        link: { twitter: "test", website: "https://test.com" },
      });

      const signals: string[] = [];
      goldScore(gmgn, null, signals);

      expect(signals).toContain("Social: Twitter+Web no TG [Gold Standard] (+10)");
    });

    it("penalizes -5 for having Telegram (dump risk)", () => {
      const gmgn = createGmgnTokenInfo({
        link: { telegram: "test" },
      });

      const signals: string[] = [];
      goldScore(gmgn, null, signals);

      expect(signals).toContain("Social: Has Telegram [dump risk, -5]");
    });

    it("penalizes -10 for DANGER MELT bundler rate > 30%", () => {
      const gmgn = createGmgnTokenInfo({
        stat: { rat_trader_amount_rate: 0.01, top_bundler_trader_percentage: 0.35, top_entrapment_trader_percentage: 0.05, fresh_wallet_rate: 0.2 },
      });

      const signals: string[] = [];
      goldScore(gmgn, null, signals);

      expect(signals).toContain("BundlerRate 35.0% [DANGER MELT] (-10)");
    });

    it("awards +8 for USDC bonding curve (premium quality)", () => {
      const gmgn = createGmgnTokenInfo({
        bonding_currency: "usdc",
      });

      const signals: string[] = [];
      goldScore(gmgn, null, signals);

      expect(signals).toContain("USDC bonding curve [+67% entry cost, premium quality] (+8)");
    });

    it("awards +5 when creator claimed PumpSwap fees", () => {
      const gmgn = createGmgnTokenInfo({
        fee_distribution: {
          launchpad: "pump",
          platform_data: {
            list: [{ is_creator: true, has_claimed_fee: true, royalty_bps: 100 }],
          },
        },
      });

      const signals: string[] = [];
      goldScore(gmgn, null, signals);

      expect(signals).toContain("Creator claimed fees [actively monitoring] (+5)");
    });
  });

  describe("goldScore - Integration", () => {
    it("calculates comprehensive score for legendary token", () => {
      const dex: DexPair = {
        pairAddress: "test",
        baseToken: { address: "test", symbol: "TEST", name: "Test" },
        liquidity: { usd: 150_000 },
        marketCap: 500_000,
        volume: { m5: 50_000, h1: 1_000_000, h24: 100_000 },
        txns: { h1: { buys: 990, sells: 10 }, m5: { buys: 0, sells: 0 } },
      };

      const gmgn = createGmgnTokenInfo({
        holder_count: 2500,
        creation_timestamp: Date.now() / 1000 - 1800,
        bonding_currency: "usdc",
        dev: {
          creator_address: "test",
          creator_open_count: 1,
          creator_token_status: "hold",
          top_10_holder_rate: 0.1,
          ath_token_info: { ath_mc: 10_000_000 },
        },
        wallet_tags_stat: { smart_wallets: 5, renowned_wallets: 0, sniper_wallets: 0 },
        link: { twitter: "test", website: "https://test.com" },
        stat: {
          rat_trader_amount_rate: 0.005,
          top_bundler_trader_percentage: 0.03,
          top_entrapment_trader_percentage: 0.05,
          fresh_wallet_rate: 0.2,
        },
        price: { volume_5m: 50_000, volume_1h: 1_000_000, volume_24h: 100_000, buys_1h: 990, sells_1h: 10 },
      });

      const signals: string[] = [];
      const score = goldScore(gmgn, dex, signals);

      expect(score).toBeGreaterThanOrEqual(75);
      expect(scoreTier(score)).toBe("LEGENDARY");
    });

    it("clamps score between 0 and 100", () => {
      const gmgn = createGmgnTokenInfo();

      const signals: string[] = [];
      const score = goldScore(gmgn, null, signals);

      expect(score).toBeGreaterThanOrEqual(0);
      expect(score).toBeLessThanOrEqual(100);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // TRACK 5: DEV FUNDING AGE PENALTY
  // ─────────────────────────────────────────────────────────────────────────────

  describe("evaluateDevFundingAge", () => {
    const now = 1_700_000_000_000;
    const ONE_DAY_MS = 24 * 60 * 60 * 1000;
    const SEVEN_DAYS_MS = 7 * ONE_DAY_MS;

    it("applies -15 penalty for dev wallet funded < 1 day ago", () => {
      const result = evaluateDevFundingAge(now - 6 * 60 * 60 * 1000, now); // 6h ago
      expect(result.fresh).toBe(true);
      expect(result.points).toBe(-15);
      expect(result.signal).toContain("very_fresh_dev_wallet");
    });

    it("applies -8 penalty for dev wallet funded 1-7 days ago", () => {
      const result = evaluateDevFundingAge(now - 3 * ONE_DAY_MS, now); // 3 days ago
      expect(result.fresh).toBe(true);
      expect(result.points).toBe(-8);
      expect(result.signal).toContain("fresh_dev_wallet");
    });

    it("applies no penalty for dev wallet funded > 7 days ago", () => {
      const result = evaluateDevFundingAge(now - 30 * ONE_DAY_MS, now); // 30 days ago
      expect(result.fresh).toBe(false);
      expect(result.points).toBe(0);
    });

    it("applies no penalty when fund_from_ts is null/undefined (missing data)", () => {
      const result = evaluateDevFundingAge(null, now);
      expect(result.fresh).toBe(false);
      expect(result.points).toBe(0);
      expect(result.signal).toContain("unknown");
    });

    it("applies no penalty when fund_from_ts is 0 (not set)", () => {
      const result = evaluateDevFundingAge(0, now);
      expect(result.fresh).toBe(false);
      expect(result.points).toBe(0);
    });

    it("exactly 1 day old gets the fresh (not very_fresh) penalty", () => {
      const result = evaluateDevFundingAge(now - ONE_DAY_MS - 1000, now); // just over 1 day
      expect(result.points).toBe(-8); // fresh, not very fresh
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // TRACK 5: VOLUME SPIKE AUTHENTICITY
  // ─────────────────────────────────────────────────────────────────────────────

  describe("evaluateVolumeSpikeAuthenticity", () => {
    it("flags isolated volume spike: 5m > 80% of 1h AND 1h < 5% of 24h", () => {
      // 5m vol is 90% of 1h vol AND 1h vol is only 2% of 24h
      const result = evaluateVolumeSpikeAuthenticity(9_000, 10_000, 500_000);

      expect(result.authentic).toBe(false);
      expect(result.points).toBe(-10);
      expect(result.signal).toContain("isolated_volume_spike");
    });

    it("does NOT flag when 1h volume is a substantial part of 24h (organic)", () => {
      // 1h is 15% of 24h — normal sustained pump
      const result = evaluateVolumeSpikeAuthenticity(20_000, 75_000, 500_000);

      expect(result.authentic).toBe(true);
      expect(result.points).toBe(0);
    });

    it("does NOT flag when 5m is a small fraction of 1h (normal intra-hour activity)", () => {
      // 5m is 10% of 1h — perfectly normal
      const result = evaluateVolumeSpikeAuthenticity(5_000, 50_000, 200_000);

      expect(result.authentic).toBe(true);
    });

    it("handles zero 24h volume gracefully", () => {
      const result = evaluateVolumeSpikeAuthenticity(10_000, 50_000, 0);
      expect(result.authentic).toBe(true); // can't compute ratio, assume organic
    });

    it("handles zero 1h volume gracefully", () => {
      const result = evaluateVolumeSpikeAuthenticity(0, 0, 100_000);
      expect(result.authentic).toBe(true);
    });
  });

  describe("goldScore - Track 5 integration", () => {
    it("penalizes token with very fresh dev wallet in goldScore", () => {
      const now = Date.now();
      const freshFundTs = Math.floor((now - 6 * 60 * 60 * 1000) / 1000); // 6h ago in seconds

      const withFresh = createGmgnTokenInfo({
        dev: {
          creator_address: "test",
          creator_open_count: 1,
          creator_token_status: "hold",
          top_10_holder_rate: 0.1,
          fund_from_ts: freshFundTs,
        },
      });

      const withoutFresh = createGmgnTokenInfo();

      const signals1: string[] = [];
      const signals2: string[] = [];
      const score1 = goldScore(withFresh, null, signals1);
      const score2 = goldScore(withoutFresh, null, signals2);

      expect(score1).toBeLessThan(score2);
      expect(signals1.some(s => s.includes("very_fresh_dev_wallet"))).toBe(true);
    });
  });
});
