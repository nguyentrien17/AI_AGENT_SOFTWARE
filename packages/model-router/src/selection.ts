import type { CapabilitySupport, ModelCapabilityKey } from '@platform/ai-management';
import { UnprocessableError } from '@platform/shared';
import { type HardCeilings, type QualityTier, type RiskLevel, type RoutingRules, TIER_RANK } from './policy.js';

export type RoutingMode = 'fixed' | 'adaptive' | 'hybrid';
export type TaskComplexity = 'trivial' | 'low' | 'medium' | 'high' | 'critical';

/** Everything the router knows about one model at decision time. */
export interface RoutingCandidate {
  modelId: string;
  modelKey: string;
  providerId: string;
  providerKey: string;
  providerEnabled: boolean;
  providerHealth: 'unknown' | 'healthy' | 'degraded' | 'failing';
  availability: 'available' | 'unavailable' | 'unknown' | 'deprecated';
  contextWindow: number | null;
  maxOutputTokens: number | null;
  qualityTier: QualityTier;
  capabilities: Partial<Record<ModelCapabilityKey, CapabilitySupport>>;
  /** USD per million tokens; null when no pricing is registered (cost is then never guessed). */
  pricing: { inputPerMtok: number; outputPerMtok: number } | null;
}

export interface RoutingRequirements {
  requiredCapabilities: ModelCapabilityKey[];
  estimatedInputTokens: number;
  /** Worst-case output used for window, budget and cost checks. */
  outputTokenBudget: number;
  /** Expected size of the produced artifact, when the caller knows it. */
  expectedOutputTokens: number | null;
  complexity: TaskComplexity;
  riskLevel: RiskLevel;
  taskKind: string | null;
  /** True when a Quality Gate depends on this output: auto-downgrade is then forbidden (Blueprint §5.3). */
  qualityGateCritical: boolean;
}

export interface SelectionConfig {
  mode: RoutingMode;
  primaryModelId: string | null;
  allowlistModelIds: string[];
  fallbackModelIds: string[];
  allowAutoUpgrade: boolean;
  allowAutoDowngrade: boolean;
  requireApprovalForProviderChange: boolean;
  /** Tightest per-invocation cost ceiling from configuration limits and per-invocation budgets. */
  maxCostUsd: number | null;
}

export interface SelectionLimits {
  remainingTokens: number | null;
  remainingCostUsd: number | null;
}

export interface CandidateScore {
  quality: number;
  cost: number;
  health: number;
  capability: number;
  total: number;
}

export interface CandidateEvaluation {
  modelId: string;
  modelKey: string;
  providerKey: string;
  qualityTier: QualityTier;
  eligible: boolean;
  rejections: string[];
  estimatedCostUsd: number | null;
  score: CandidateScore | null;
}

export interface RoutingDecision {
  mode: RoutingMode;
  selected: RoutingCandidate;
  selectionReason: string;
  minTier: QualityTier | null;
  desiredTier: QualityTier;
  estimatedCostUsd: number | null;
  candidates: CandidateEvaluation[];
  /** Ordered fallback model ids, selected model excluded. */
  fallbackChain: string[];
  warnings: string[];
}

/** Raised when no model satisfies the constraints: execution halts and a human must intervene (§5.3). */
export class RoutingHaltError extends UnprocessableError {
  readonly haltReason: string;
  constructor(haltReason: string, detail: string, extensions: Record<string, unknown> = {}) {
    super(detail, 'routing_halted', { haltReason, requiresHumanIntervention: true, ...extensions });
    this.haltReason = haltReason;
  }
}

const COMPLEXITY_TIER: Readonly<Record<TaskComplexity, QualityTier>> = {
  trivial: 'economy',
  low: 'economy',
  medium: 'standard',
  high: 'high',
  critical: 'frontier',
};

function higherTier(a: QualityTier | null, b: QualityTier | null): QualityTier | null {
  if (!a) return b;
  if (!b) return a;
  return TIER_RANK[a] >= TIER_RANK[b] ? a : b;
}

export function isHighReasoningTask(req: RoutingRequirements, rules: Required<RoutingRules>): boolean {
  return req.taskKind !== null && rules.highReasoningTaskKinds.includes(req.taskKind);
}

/** The minimum quality tier any selected or fallback model must meet. */
export function minimumTier(
  req: RoutingRequirements,
  ceilings: HardCeilings,
  rules: Required<RoutingRules>,
): QualityTier | null {
  let tier: QualityTier | null = ceilings.minQualityTier ?? null;
  tier = higherTier(tier, rules.minTierByRisk[req.riskLevel] ?? null);
  if (isHighReasoningTask(req, rules)) tier = higherTier(tier, rules.highReasoningMinTier);
  return tier;
}

export function desiredTier(req: RoutingRequirements, minTier: QualityTier | null): QualityTier {
  return higherTier(COMPLEXITY_TIER[req.complexity], minTier)!;
}

export function estimateCostUsd(c: RoutingCandidate, req: RoutingRequirements): number | null {
  if (!c.pricing) return null;
  return (
    (req.estimatedInputTokens * c.pricing.inputPerMtok + req.outputTokenBudget * c.pricing.outputPerMtok) / 1_000_000
  );
}

export interface FilterContext {
  allowed: ReadonlySet<string>;
  primaryProviderId: string | null;
  config: SelectionConfig;
  ceilings: HardCeilings;
  rules: Required<RoutingRules>;
  requirements: RoutingRequirements;
  minTier: QualityTier | null;
  limits: SelectionLimits;
}

/** Hard filters (Blueprint §5.2 criteria 1–7 and 9). An empty result means the candidate is eligible. */
export function hardFilterRejections(c: RoutingCandidate, ctx: FilterContext): string[] {
  const { ceilings, rules, requirements: req, config } = ctx;
  const out: string[] = [];

  if (!ctx.allowed.has(c.modelId)) out.push('not_in_allowlist');
  if (ceilings.deniedModelIds?.includes(c.modelId)) out.push('denied_by_policy');
  if (ceilings.allowedProviderIds?.length && !ceilings.allowedProviderIds.includes(c.providerId)) {
    out.push('provider_not_allowed_by_policy');
  }
  if (
    (config.requireApprovalForProviderChange || ceilings.requireApprovalForProviderChange) &&
    ctx.primaryProviderId !== null &&
    c.providerId !== ctx.primaryProviderId
  ) {
    out.push('provider_change_requires_approval');
  }
  if (!c.providerEnabled) out.push('provider_disabled');
  if (c.providerHealth === 'failing') out.push('provider_unhealthy');
  if (c.availability === 'unavailable' || c.availability === 'deprecated') out.push('model_unavailable');

  for (const cap of req.requiredCapabilities) {
    const support = c.capabilities[cap] ?? 'unknown';
    if (support === 'no') out.push(`missing_capability:${cap}`);
    else if (support === 'unknown' && rules.requireVerifiedCapabilities) out.push(`unverified_capability:${cap}`);
  }

  if (c.contextWindow !== null && req.estimatedInputTokens + req.outputTokenBudget > c.contextWindow) {
    out.push('context_window_too_small');
  }
  if (c.maxOutputTokens !== null && req.expectedOutputTokens !== null && req.expectedOutputTokens > c.maxOutputTokens) {
    out.push('max_output_too_small');
  }
  if (ctx.minTier && TIER_RANK[c.qualityTier] < TIER_RANK[ctx.minTier]) out.push('below_min_quality_tier');

  const cost = estimateCostUsd(c, req);
  if (cost !== null) {
    const ceiling = [ceilings.maxCostPerInvocationUsd, config.maxCostUsd].filter((v): v is number => v != null);
    if (ceiling.length > 0 && cost > Math.min(...ceiling)) out.push('exceeds_cost_ceiling');
    if (ctx.limits.remainingCostUsd !== null && cost > ctx.limits.remainingCostUsd) out.push('insufficient_cost_budget');
  }
  if (
    ctx.limits.remainingTokens !== null &&
    req.estimatedInputTokens + req.outputTokenBudget > ctx.limits.remainingTokens
  ) {
    out.push('insufficient_token_budget');
  }
  return out;
}

const WEIGHTS = { quality: 0.5, cost: 0.2, health: 0.2, capability: 0.1 } as const;

/**
 * Scores eligible candidates for the audit trail and for ordering models of equal tier fit. Together with
 * the tier-first comparison in `best` this guarantees a model is never chosen solely because it is the
 * cheapest (Blueprint §5.2 rule).
 */
export function scoreCandidates(
  eligible: RoutingCandidate[],
  req: RoutingRequirements,
  desired: QualityTier,
): Map<string, CandidateScore> {
  const costs = eligible.map((c) => estimateCostUsd(c, req)).filter((v): v is number => v !== null);
  const minCost = costs.length ? Math.min(...costs) : 0;
  const maxCost = costs.length ? Math.max(...costs) : 0;
  const scores = new Map<string, CandidateScore>();

  for (const c of eligible) {
    const rank = TIER_RANK[c.qualityTier];
    const want = TIER_RANK[desired];
    let quality: number;
    if (rank === 0) quality = 0.3;
    else if (rank === want) quality = 1;
    else if (rank > want) quality = Math.max(0.5, 1 - 0.15 * (rank - want));
    else quality = Math.max(0, 0.4 - 0.2 * (want - rank - 1));

    const cost = estimateCostUsd(c, req);
    const costScore = cost === null ? 0.5 : maxCost === minCost ? 1 : 1 - (cost - minCost) / (maxCost - minCost);
    const health = c.providerHealth === 'healthy' ? 1 : c.providerHealth === 'unknown' ? 0.7 : 0.4;
    const capability = req.requiredCapabilities.every((cap) => c.capabilities[cap] === 'yes') ? 1 : 0.5;
    const total =
      WEIGHTS.quality * quality + WEIGHTS.cost * costScore + WEIGHTS.health * health + WEIGHTS.capability * capability;
    const round = (n: number) => Math.round(n * 1000) / 1000;
    scores.set(c.modelId, {
      quality: round(quality),
      cost: round(costScore),
      health: round(health),
      capability: round(capability),
      total: round(total),
    });
  }
  return scores;
}

/** 0 = exactly the desired tier; overshoot ranks before any shortfall; unrated models come last. */
function tierFit(c: RoutingCandidate, desired: QualityTier): number {
  const rank = TIER_RANK[c.qualityTier];
  const want = TIER_RANK[desired];
  if (rank === 0) return 100;
  return rank >= want ? rank - want : 10 + (want - rank);
}

/**
 * Picks the winner. Tier fit is compared first and the weighted score only orders models of equal fit,
 * so cost can break a tie but can never buy a worse-fitting model the win.
 */
function best(
  pool: RoutingCandidate[],
  scores: Map<string, CandidateScore>,
  desired: QualityTier,
): RoutingCandidate | null {
  return (
    [...pool].sort(
      (a, b) =>
        tierFit(a, desired) - tierFit(b, desired) ||
        scores.get(b.modelId)!.total - scores.get(a.modelId)!.total ||
        a.modelKey.localeCompare(b.modelKey),
    )[0] ?? null
  );
}

/** Models that may ever be dispatched under this configuration, including explicit fallbacks. */
export function allowedModelIds(config: SelectionConfig): Set<string> {
  const allowed = new Set<string>(config.allowlistModelIds);
  if (config.primaryModelId) allowed.add(config.primaryModelId);
  // Without an explicit allowlist the configured fallback chain is the implicit allowlist.
  if (config.allowlistModelIds.length === 0) for (const id of config.fallbackModelIds) allowed.add(id);
  return allowed;
}

export interface SelectInput {
  config: SelectionConfig;
  candidates: RoutingCandidate[];
  requirements: RoutingRequirements;
  ceilings: HardCeilings;
  rules: Required<RoutingRules>;
  limits: SelectionLimits;
}

/**
 * The routing engine: hard filters, then the mode-specific choice.
 * - `fixed`: always the primary model; anything else is a halt.
 * - `adaptive`: best-scoring eligible model of the allowlist.
 * - `hybrid`: the primary by default, auto-upgrade for complex work and auto-downgrade for simple work
 *   when policy allows and no Quality Gate is put at risk.
 */
export function selectModel(input: SelectInput): RoutingDecision {
  const { config, candidates, requirements: req, ceilings, rules, limits } = input;
  const byId = new Map(candidates.map((c) => [c.modelId, c]));
  const primary = config.primaryModelId ? (byId.get(config.primaryModelId) ?? null) : null;
  const allowed = allowedModelIds(config);
  const minTier = minimumTier(req, ceilings, rules);
  const desired = desiredTier(req, minTier);
  const ctx: FilterContext = {
    allowed,
    primaryProviderId: primary?.providerId ?? null,
    config,
    ceilings,
    rules,
    requirements: req,
    minTier,
    limits,
  };

  // Selection pool: fixed mode only ever considers the primary.
  const poolIds =
    config.mode === 'fixed'
      ? config.primaryModelId
        ? [config.primaryModelId]
        : []
      : [...new Set([...(config.primaryModelId ? [config.primaryModelId] : []), ...config.allowlistModelIds])];
  const pool = poolIds.map((id) => byId.get(id)).filter((c): c is RoutingCandidate => Boolean(c));

  const rejections = new Map<string, string[]>();
  for (const c of candidates) rejections.set(c.modelId, hardFilterRejections(c, ctx));
  const eligible = pool.filter((c) => rejections.get(c.modelId)!.length === 0);
  const scores = scoreCandidates(eligible, req, desired);
  const warnings: string[] = [];

  const evaluations: CandidateEvaluation[] = candidates.map((c) => ({
    modelId: c.modelId,
    modelKey: c.modelKey,
    providerKey: c.providerKey,
    qualityTier: c.qualityTier,
    eligible: rejections.get(c.modelId)!.length === 0,
    rejections: rejections.get(c.modelId)!,
    estimatedCostUsd: estimateCostUsd(c, req),
    score: scores.get(c.modelId) ?? null,
  }));

  const halt = (reason: string, detail: string): never => {
    throw new RoutingHaltError(reason, detail, {
      mode: config.mode,
      minTier,
      desiredTier: desired,
      candidates: evaluations.map((e) => ({ modelKey: e.modelKey, providerKey: e.providerKey, rejections: e.rejections })),
    });
  };

  let selected: RoutingCandidate | null = null;
  let selectionReason = '';
  const primaryEligible = primary !== null && eligible.includes(primary);

  if (config.mode === 'fixed') {
    if (!primary) halt('no_model_assigned', 'Fixed routing mode has no primary model');
    if (!primaryEligible) {
      halt(
        'primary_model_rejected',
        `Fixed model '${primary!.modelKey}' violates routing constraints: ${rejections.get(primary!.modelId)!.join(', ')}`,
      );
    }
    selected = primary;
    selectionReason = 'fixed_primary';
  } else if (eligible.length === 0) {
    halt('no_valid_model', 'No allowed model satisfies the routing constraints');
  } else if (config.mode === 'adaptive') {
    selected = best(eligible, scores, desired);
    selectionReason = 'adaptive_best_score';
  } else if (!primaryEligible) {
    selected = best(eligible, scores, desired);
    selectionReason = primary ? 'hybrid_primary_rejected' : 'hybrid_best_score';
    if (primary) warnings.push(`primary_rejected:${rejections.get(primary.modelId)!.join('|')}`);
  } else {
    const p = primary!;
    const pRank = TIER_RANK[p.qualityTier];
    const wantRank = TIER_RANK[desired];
    selected = p;
    selectionReason = 'hybrid_primary';

    if (pRank < wantRank) {
      if (config.allowAutoUpgrade) {
        const stronger = eligible.filter((c) => TIER_RANK[c.qualityTier] > pRank);
        const pick = best(stronger, scores, desired);
        if (pick) {
          selected = pick;
          selectionReason = 'hybrid_auto_upgrade';
          if (TIER_RANK[pick.qualityTier] < wantRank) warnings.push('upgraded_but_still_below_desired_tier');
        } else warnings.push('upgrade_wanted_but_no_stronger_model_eligible');
      } else warnings.push('task_exceeds_primary_tier_but_auto_upgrade_disabled');
    } else if (
      config.allowAutoDowngrade &&
      (req.complexity === 'trivial' || req.complexity === 'low') &&
      !req.qualityGateCritical &&
      !isHighReasoningTask(req, rules)
    ) {
      const pCost = estimateCostUsd(p, req);
      const cheaper = eligible.filter((c) => {
        const rank = TIER_RANK[c.qualityTier];
        const cost = estimateCostUsd(c, req);
        // Never downgrade to an unrated model or below the task's own tier: cost alone is not a reason.
        return rank > 0 && rank < pRank && rank >= wantRank && pCost !== null && cost !== null && cost < pCost;
      });
      const pick = best(cheaper, scores, desired);
      if (pick) {
        selected = pick;
        selectionReason = 'hybrid_auto_downgrade';
      }
    }
  }

  const chosen = selected!;
  return {
    mode: config.mode,
    selected: chosen,
    selectionReason,
    minTier,
    desiredTier: desired,
    estimatedCostUsd: estimateCostUsd(chosen, req),
    candidates: evaluations,
    fallbackChain: config.fallbackModelIds.filter((id) => id !== chosen.modelId),
    warnings,
  };
}
