export type TradingMode = "live" | "paper";

export interface TokenSafetyDecision {
  safe: boolean;
  reason: string;
}

export interface TokenSafetyPreflightInput {
  checksEnabled: boolean;
  now: number;
  entryMinLiquidityUsd: number;
  liquidityUsd: number;
  m5Sells: number;
  pairCreatedAt?: number | null;
}

export interface RugcheckRisk {
  name?: string | null;
}

export interface RugcheckAuthoritySnapshot {
  freezeAuthority?: string | null;
  mintAuthority?: string | null;
}

export interface TokenSafetySummaryDecisionInput {
  scoreNormalised?: number | null;
  rugcheckMaxRiskNormalised: number;
  risks: RugcheckRisk[];
  tradingMode: TradingMode;
  goldTier?: string | null;
  goldSingleHolderPaperProbeEnabled: boolean;
  lpRelaxGateReason?: string | null;
  token?: RugcheckAuthoritySnapshot | null;
  tokenMeta?: RugcheckAuthoritySnapshot | null;
}

export interface TokenSafetySummaryDecision extends TokenSafetyDecision {
  freezeAuthorityActive: boolean;
  mintAuthorityActive: boolean;
  vetoRiskName: string | null;
}

const NULL_AUTHORITY = "11111111111111111111111111111111";

function hasAddressAuthority(value: string | null | undefined): boolean {
  return typeof value === "string" && value.length > 0 && value !== NULL_AUTHORITY;
}

function slugRiskName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
}

export function evaluateTokenSafetyPreflight(
  input: TokenSafetyPreflightInput,
): TokenSafetyDecision | null {
  if (!input.checksEnabled) {
    return { safe: true, reason: "checks_disabled" };
  }

  if (input.liquidityUsd < input.entryMinLiquidityUsd) {
    return {
      safe: false,
      reason: `liquidity_below_entry_floor($${Math.round(input.liquidityUsd)} < $${input.entryMinLiquidityUsd})`,
    };
  }

  const ageSeconds = input.pairCreatedAt ? (input.now - input.pairCreatedAt) / 1000 : 99999;
  const minSells =
    ageSeconds < 120 ? 2 : ageSeconds < 300 ? 5 : ageSeconds < 900 ? 8 : 10;

  if (input.m5Sells < minSells) {
    return {
      safe: false,
      reason: `insufficient_sell_activity_honeypot_risk(${input.m5Sells}/${minSells}@${Math.round(ageSeconds)}s)`,
    };
  }

  return null;
}

export function evaluateTokenSafetySummaryDecision(
  input: TokenSafetySummaryDecisionInput,
): TokenSafetySummaryDecision {
  const risks = Array.isArray(input.risks) ? input.risks : [];
  const riskName = (risk: RugcheckRisk) => String(risk?.name || "");
  const riskNameLc = (risk: RugcheckRisk) => riskName(risk).toLowerCase();
  const hasRisk = (keyword: string) => risks.some((risk) => riskNameLc(risk).includes(keyword));

  const freezeAuthorityActive =
    hasRisk("freeze authority") ||
    hasAddressAuthority(input.token?.freezeAuthority) ||
    hasAddressAuthority(input.tokenMeta?.freezeAuthority);
  const mintAuthorityActive =
    hasRisk("mint authority") ||
    hasAddressAuthority(input.token?.mintAuthority) ||
    hasAddressAuthority(input.tokenMeta?.mintAuthority);

  const absoluteVetoRisk = risks.find((risk) => {
    const name = riskNameLc(risk);
    return (
      name.includes("single holder ownership") ||
      (name.includes("lp unlocked") && !name.includes("large amount of lp unlocked"))
    );
  });
  const gradedLpRisk = risks.find((risk) =>
    riskNameLc(risk).includes("large amount of lp unlocked"),
  );

  let effectiveAbsoluteVetoRisk = absoluteVetoRisk;
  const singleHolderOnlyAbsolute =
    !!absoluteVetoRisk &&
    riskNameLc(absoluteVetoRisk).includes("single holder ownership") &&
    !risks.some((risk) => {
      const name = riskNameLc(risk);
      return name.includes("lp unlocked") && !name.includes("large amount of lp unlocked");
    });

  if (
    singleHolderOnlyAbsolute &&
    input.goldSingleHolderPaperProbeEnabled &&
    input.tradingMode !== "live" &&
    input.goldTier === "LEGENDARY"
  ) {
    effectiveAbsoluteVetoRisk = undefined;
  }

  const gradedLpAdmit = input.tradingMode !== "live";
  const vetoRisk =
    effectiveAbsoluteVetoRisk || (gradedLpRisk && !gradedLpAdmit ? gradedLpRisk : undefined);

  if (freezeAuthorityActive) {
    return {
      safe: false,
      reason: "freeze_authority_active_honeypot_risk",
      freezeAuthorityActive,
      mintAuthorityActive,
      vetoRiskName: null,
    };
  }

  if (vetoRisk) {
    return {
      safe: false,
      reason: `rugcheck_veto_${slugRiskName(riskName(vetoRisk) || "unknown")}`,
      freezeAuthorityActive,
      mintAuthorityActive,
      vetoRiskName: riskName(vetoRisk) || null,
    };
  }

  if (input.lpRelaxGateReason) {
    return {
      safe: false,
      reason: input.lpRelaxGateReason,
      freezeAuthorityActive,
      mintAuthorityActive,
      vetoRiskName: null,
    };
  }

  if (
    typeof input.scoreNormalised === "number" &&
    input.scoreNormalised > input.rugcheckMaxRiskNormalised
  ) {
    return {
      safe: false,
      reason: `rugcheck_risk_high(norm=${input.scoreNormalised})`,
      freezeAuthorityActive,
      mintAuthorityActive,
      vetoRiskName: null,
    };
  }

  return {
    safe: true,
    reason: "ok",
    freezeAuthorityActive,
    mintAuthorityActive,
    vetoRiskName: null,
  };
}
