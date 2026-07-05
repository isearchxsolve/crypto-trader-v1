export interface GateInput {
  tier: string;
  sigScore: number;
  combinedScore: number;
  mlScore: number;
  px5m: number;
  volMom: number;
  bp5m: number;
  pc5m: number;
  qualifiedMode: string | null;
  isMicroWallet: boolean;
  /** Precomputed effective min score for non-NEW_MINT tokens (includes loss-based penalties from routes.ts) */
  minScoreOverride?: number;
  env: {
    NEW_MINT_MIN_SCORE?: number;
    EDGE_POCKET_ONLY?: string;
    EDGE_MIN_SCORE?: number;
    EDGE_HIGH_CONF_SCORE?: number;
    EDGE_EXPLOSIVE_SCORE?: number;
    EDGE_EXPLOSIVE_ML?: number;
    EDGE_EXPLOSIVE_PX5M?: number;
    EDGE_EXPLOSIVE_VOLMOM?: number;
    ENTRY_CONFIRM_MIN_BP?: number;
    ENTRY_CONFIRM_MIN_PC5M?: number;
  };
}

export interface GateDecision {
  admit: boolean;
  reason: string;
  mode: string | null;
  effectiveMinScore: number;
  newCombinedScore: number;
}

export function getEffectiveMinScore(isMicroWallet: boolean): number {
  return isMicroWallet ? 85 : 90;
}

export function evaluateNewMintGate(i: GateInput): GateDecision {
  let combinedScore = Math.max(i.combinedScore, Math.round(i.sigScore * 1.1));
  let qualifiedMode = i.qualifiedMode;

  if (i.tier === 'LEGENDARY' && !qualifiedMode) {
    qualifiedMode = 'SNIPER';
  }

  const NEW_MINT_MIN_SCORE = Number(i.env.NEW_MINT_MIN_SCORE) || 65;
  const _isNewMintSurvivor = i.tier === 'NEW_MINT' && combinedScore >= NEW_MINT_MIN_SCORE;
  if (_isNewMintSurvivor && !qualifiedMode) {
    qualifiedMode = 'SNIPER';
  }

  const effectiveMinScore = _isNewMintSurvivor ? NEW_MINT_MIN_SCORE : (i.minScoreOverride ?? getEffectiveMinScore(i.isMicroWallet));
  if (!qualifiedMode || combinedScore < effectiveMinScore) {
    return {
      admit: false,
      reason: `score ${combinedScore} < ${effectiveMinScore} mode=${qualifiedMode || 'none'}`,
      mode: qualifiedMode,
      effectiveMinScore,
      newCombinedScore: combinedScore
    };
  }

  const _edgePocketOnly = String(i.env.EDGE_POCKET_ONLY ?? 'true').toLowerCase() !== 'false';
  const _EDGE_MODES = ['SNIPER'];
  const _EDGE_MIN_SCORE = Number(i.env.EDGE_MIN_SCORE) || 80;
  const _isSniperEdge = _EDGE_MODES.includes(qualifiedMode) && combinedScore >= _EDGE_MIN_SCORE;
  const _isHighConfidence = combinedScore >= (Number(i.env.EDGE_HIGH_CONF_SCORE) || 90);
  const _eqScore = Number(i.env.EDGE_EXPLOSIVE_SCORE) || 85;
  const _eqMl = Number(i.env.EDGE_EXPLOSIVE_ML) || 80;
  const _eqPx5m = Number(i.env.EDGE_EXPLOSIVE_PX5M) || 8;
  const _eqVolMom = Number(i.env.EDGE_EXPLOSIVE_VOLMOM) || 1.5;
  const _isExplosiveQuality = (combinedScore >= _eqScore) && (i.mlScore >= _eqMl) && (i.px5m >= _eqPx5m) && (i.volMom >= _eqVolMom);

  const _isGoldLegendary = i.tier === 'LEGENDARY';
  if (_edgePocketOnly && !_isGoldLegendary && !_isNewMintSurvivor && !_isSniperEdge && !_isHighConfidence && !_isExplosiveQuality) {
    return {
      admit: false,
      reason: `outside EDGE_POCKET (score=${combinedScore} gold=${i.tier})`,
      mode: qualifiedMode,
      effectiveMinScore,
      newCombinedScore: combinedScore
    };
  }

  const ENTRY_CONFIRM_MIN_BP = Number(i.env.ENTRY_CONFIRM_MIN_BP ?? 0.50);
  const ENTRY_CONFIRM_MIN_PC5M = Number(i.env.ENTRY_CONFIRM_MIN_PC5M ?? 0);
  if (combinedScore < 90 && i.bp5m < ENTRY_CONFIRM_MIN_BP && i.pc5m < ENTRY_CONFIRM_MIN_PC5M) {
    return {
      admit: false,
      reason: `rolling over (bp5m=${i.bp5m.toFixed(2)} pc5m=${i.pc5m.toFixed(1)}%)`,
      mode: qualifiedMode,
      effectiveMinScore,
      newCombinedScore: combinedScore
    };
  }

  return {
    admit: true,
    reason: 'ok',
    mode: qualifiedMode,
    effectiveMinScore,
    newCombinedScore: combinedScore
  };
}
