import { type BudgetThresholdsConfig, DEFAULT_BUDGET_THRESHOLDS } from '@platform/db';
import { ValidationError } from '@platform/shared';

/** Budget alert bands (Blueprint §10.4), ordered from least to most severe. */
export const BUDGET_BANDS = [
  'normal',
  'optimize_50',
  'warning_70',
  'restrict_85',
  'halt_95',
  'exhausted_100',
] as const;
export type BudgetBand = (typeof BUDGET_BANDS)[number];

export function bandRank(band: BudgetBand): number {
  return BUDGET_BANDS.indexOf(band);
}

export function worstBand(bands: BudgetBand[]): BudgetBand {
  return bands.reduce<BudgetBand>((worst, b) => (bandRank(b) > bandRank(worst) ? b : worst), 'normal');
}

export function validateThresholds(input?: Partial<BudgetThresholdsConfig>): BudgetThresholdsConfig {
  const t = { ...DEFAULT_BUDGET_THRESHOLDS, ...(input ?? {}) };
  const seq = [t.optimizePct, t.warningPct, t.restrictPct, t.haltPct];
  if (seq.some((n) => typeof n !== 'number' || !Number.isFinite(n))) {
    throw new ValidationError('Budget thresholds must be finite numbers');
  }
  for (let i = 0; i < seq.length; i++) {
    const cur = seq[i]!;
    const prev = i === 0 ? 0 : seq[i - 1]!;
    if (cur <= prev) {
      throw new ValidationError('Budget thresholds must be strictly ascending and greater than 0');
    }
  }
  if (t.haltPct >= 100) throw new ValidationError('haltPct must be below 100');
  return t;
}

export interface BudgetUsageSnapshot {
  tokenLimit: number | null;
  costLimitUsd: number | null;
  consumedTokens: number;
  consumedCostUsd: number;
}

/**
 * Utilisation is the more constrained of the token and cost dimensions. A budget without limits never
 * constrains anything and reports 0%.
 */
export function utilizationPct(s: BudgetUsageSnapshot): number {
  const ratios: number[] = [];
  if (s.tokenLimit !== null && s.tokenLimit > 0) ratios.push(s.consumedTokens / s.tokenLimit);
  if (s.costLimitUsd !== null && s.costLimitUsd > 0) ratios.push(s.consumedCostUsd / s.costLimitUsd);
  if (ratios.length === 0) return 0;
  return Math.round(Math.max(...ratios) * 10_000) / 100;
}

export function bandFor(pct: number, t: BudgetThresholdsConfig = DEFAULT_BUDGET_THRESHOLDS): BudgetBand {
  if (pct >= 100) return 'exhausted_100';
  if (pct >= t.haltPct) return 'halt_95';
  if (pct >= t.restrictPct) return 'restrict_85';
  if (pct >= t.warningPct) return 'warning_70';
  if (pct >= t.optimizePct) return 'optimize_50';
  return 'normal';
}

/** The mandated reaction when a budget enters a band (Blueprint §10.4). */
export function bandAction(band: BudgetBand): string {
  switch (band) {
    case 'normal':
      return 'none';
    case 'optimize_50':
      return 'enable_context_optimization';
    case 'warning_70':
      return 'emit_budget_warning';
    case 'restrict_85':
      return 'restrict_non_essential';
    case 'halt_95':
      return 'halt_and_checkpoint';
    case 'exhausted_100':
      return 'hard_stop';
  }
}

/** New scheduling stops at the halt band; the hard-exhaustion protocol applies from there on. */
export function isHaltBand(band: BudgetBand): boolean {
  return bandRank(band) >= bandRank('halt_95');
}
