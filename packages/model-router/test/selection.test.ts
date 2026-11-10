import { describe, expect, it } from 'vitest';
import { ProviderAdapterError } from '@platform/ai-management';
import {
  classifyFailure,
  DEFAULT_ROUTING_RULES,
  type FallbackState,
  hardFilterRejections,
  nextFallbackStep,
  parseHardCeilings,
  parseRoutingRules,
  type RoutingCandidate,
  RoutingHaltError,
  type RoutingRequirements,
  type SelectInput,
  selectModel,
  type SelectionConfig,
} from '../src/index.js';

function model(key: string, over: Partial<RoutingCandidate> = {}): RoutingCandidate {
  return {
    modelId: key,
    modelKey: key,
    providerId: 'prov-a',
    providerKey: 'prov-a',
    providerEnabled: true,
    providerHealth: 'healthy',
    availability: 'available',
    contextWindow: 100_000,
    maxOutputTokens: 8_000,
    qualityTier: 'standard',
    capabilities: { tool_calling: 'yes', structured_output: 'yes', reasoning: 'yes' },
    pricing: { inputPerMtok: 1, outputPerMtok: 4 },
    ...over,
  };
}

const ECONOMY = model('economy', { qualityTier: 'economy', pricing: { inputPerMtok: 0.1, outputPerMtok: 0.4 } });
const STANDARD = model('standard');
const HIGH = model('high', { qualityTier: 'high', pricing: { inputPerMtok: 3, outputPerMtok: 12 } });
const FRONTIER = model('frontier', {
  qualityTier: 'frontier',
  providerId: 'prov-b',
  providerKey: 'prov-b',
  pricing: { inputPerMtok: 10, outputPerMtok: 40 },
});
const ALL = [ECONOMY, STANDARD, HIGH, FRONTIER];

function req(over: Partial<RoutingRequirements> = {}): RoutingRequirements {
  return {
    requiredCapabilities: [],
    estimatedInputTokens: 1_000,
    outputTokenBudget: 1_000,
    expectedOutputTokens: null,
    complexity: 'medium',
    riskLevel: 'low',
    taskKind: null,
    qualityGateCritical: false,
    ...over,
  };
}

function cfg(over: Partial<SelectionConfig> = {}): SelectionConfig {
  return {
    mode: 'hybrid',
    primaryModelId: 'standard',
    allowlistModelIds: ['economy', 'standard', 'high', 'frontier'],
    fallbackModelIds: [],
    allowAutoUpgrade: true,
    allowAutoDowngrade: true,
    requireApprovalForProviderChange: false,
    maxCostUsd: null,
    ...over,
  };
}

function run(over: Partial<SelectInput> & { config?: SelectionConfig; requirements?: RoutingRequirements } = {}) {
  return selectModel({
    config: cfg(),
    candidates: ALL,
    requirements: req(),
    ceilings: {},
    rules: DEFAULT_ROUTING_RULES,
    limits: { remainingTokens: null, remainingCostUsd: null },
    ...over,
  });
}

function haltReason(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    if (err instanceof RoutingHaltError) return err.haltReason;
    throw err;
  }
  throw new Error('expected a routing halt');
}

describe('hard filters (P4-03, Blueprint §5.2)', () => {
  const ctx = (over: Record<string, unknown> = {}) => ({
    allowed: new Set(['m']),
    primaryProviderId: 'prov-a',
    config: cfg(),
    ceilings: {},
    rules: DEFAULT_ROUTING_RULES,
    requirements: req(),
    minTier: null,
    limits: { remainingTokens: null, remainingCostUsd: null },
    ...over,
  });

  it('accepts a healthy, allowed, capable model', () => {
    expect(hardFilterRejections(model('m'), ctx())).toEqual([]);
  });

  it('reports every violated constraint by name', () => {
    const cases: Array<[string, Partial<RoutingCandidate>, Record<string, unknown>]> = [
      ['not_in_allowlist', {}, { allowed: new Set(['other']) }],
      ['denied_by_policy', {}, { ceilings: { deniedModelIds: ['m'] } }],
      ['provider_not_allowed_by_policy', {}, { ceilings: { allowedProviderIds: ['prov-z'] } }],
      ['provider_change_requires_approval', { providerId: 'prov-b' }, { ceilings: { requireApprovalForProviderChange: true } }],
      ['provider_disabled', { providerEnabled: false }, {}],
      ['provider_unhealthy', { providerHealth: 'failing' }, {}],
      ['model_unavailable', { availability: 'deprecated' }, {}],
      ['missing_capability:vision', { capabilities: { vision: 'no' } }, { requirements: req({ requiredCapabilities: ['vision'] }) }],
      [
        'unverified_capability:vision',
        { capabilities: {} },
        { requirements: req({ requiredCapabilities: ['vision'] }), rules: { ...DEFAULT_ROUTING_RULES, requireVerifiedCapabilities: true } },
      ],
      ['context_window_too_small', { contextWindow: 1_500 }, {}],
      ['max_output_too_small', { maxOutputTokens: 500 }, { requirements: req({ expectedOutputTokens: 900 }) }],
      ['below_min_quality_tier', { qualityTier: 'economy' }, { minTier: 'high' }],
      ['below_min_quality_tier', { qualityTier: 'unknown' }, { minTier: 'economy' }],
      ['exceeds_cost_ceiling', {}, { ceilings: { maxCostPerInvocationUsd: 0.001 } }],
      ['exceeds_cost_ceiling', {}, { config: cfg({ maxCostUsd: 0.001 }) }],
      ['insufficient_cost_budget', {}, { limits: { remainingTokens: null, remainingCostUsd: 0.001 } }],
      ['insufficient_token_budget', {}, { limits: { remainingTokens: 1_999, remainingCostUsd: null } }],
    ];
    for (const [reason, candidate, over] of cases) {
      expect(hardFilterRejections(model('m', candidate), ctx(over) as never), reason).toContain(reason);
    }
  });

  it('lets an unknown capability through unless policy demands verification', () => {
    const c = model('m', { capabilities: {} });
    expect(hardFilterRejections(c, ctx({ requirements: req({ requiredCapabilities: ['vision'] }) }))).toEqual([]);
  });

  it('never guesses a cost when pricing is unknown', () => {
    const c = model('m', { pricing: null });
    expect(hardFilterRejections(c, ctx({ ceilings: { maxCostPerInvocationUsd: 0.000001 } }))).toEqual([]);
  });
});

describe('routing engines (P4-04, P4-05)', () => {
  it('fixed: always the primary, and halts instead of switching when it is rejected', () => {
    const d = run({ config: cfg({ mode: 'fixed' }), requirements: req({ complexity: 'critical' }) });
    expect([d.selected.modelKey, d.selectionReason]).toEqual(['standard', 'fixed_primary']);

    const unhealthy = ALL.map((c) => (c.modelId === 'standard' ? { ...c, providerHealth: 'failing' as const } : c));
    expect(haltReason(() => run({ config: cfg({ mode: 'fixed' }), candidates: unhealthy }))).toBe('primary_model_rejected');
    expect(haltReason(() => run({ config: cfg({ mode: 'fixed', primaryModelId: null }) }))).toBe('no_model_assigned');
  });

  it('adaptive: picks by quality fit, never just the cheapest', () => {
    const adaptive = cfg({ mode: 'adaptive', primaryModelId: null });
    expect(run({ config: adaptive, requirements: req({ complexity: 'low' }) }).selected.modelKey).toBe('economy');
    expect(run({ config: adaptive, requirements: req({ complexity: 'medium' }) }).selected.modelKey).toBe('standard');
    const hard = run({ config: adaptive, requirements: req({ complexity: 'high' }) });
    expect(hard.selected.modelKey).toBe('high');
    expect(hard.selectionReason).toBe('adaptive_best_score');
    // The cheapest model is eligible and has the best cost score, yet loses on quality fit.
    const economy = hard.candidates.find((c) => c.modelKey === 'economy')!;
    expect(economy.eligible).toBe(true);
    expect(economy.score!.cost).toBe(1);
    expect(run({ config: adaptive, requirements: req({ complexity: 'critical' }) }).selected.modelKey).toBe('frontier');
  });

  it('adaptive: never selects outside the allowlist, even when a better model exists', () => {
    const d = run({
      config: cfg({ mode: 'adaptive', primaryModelId: null, allowlistModelIds: ['economy', 'standard'] }),
      requirements: req({ complexity: 'critical' }),
    });
    expect(d.selected.modelKey).toBe('standard');
    expect(d.candidates.find((c) => c.modelKey === 'frontier')?.rejections ?? ['not_a_candidate']).not.toEqual([]);

    expect(
      haltReason(() =>
        run({
          config: cfg({ mode: 'adaptive', primaryModelId: null, allowlistModelIds: ['economy'] }),
          requirements: req({ riskLevel: 'critical' }),
        }),
      ),
    ).toBe('no_valid_model');
  });

  it('hybrid: keeps the primary for ordinary work', () => {
    const d = run();
    expect([d.selected.modelKey, d.selectionReason]).toEqual(['standard', 'hybrid_primary']);
  });

  it('hybrid: auto-upgrades complex work only when policy allows', () => {
    const up = run({ requirements: req({ complexity: 'high' }) });
    expect([up.selected.modelKey, up.selectionReason]).toEqual(['high', 'hybrid_auto_upgrade']);

    const blocked = run({ config: cfg({ allowAutoUpgrade: false }), requirements: req({ complexity: 'high' }) });
    expect(blocked.selected.modelKey).toBe('standard');
    expect(blocked.warnings).toContain('task_exceeds_primary_tier_but_auto_upgrade_disabled');
  });

  it('hybrid: auto-downgrades simple work, but never when a quality gate or high-reasoning task is at stake', () => {
    const simple = req({ complexity: 'low' });
    const down = run({ requirements: simple });
    expect([down.selected.modelKey, down.selectionReason]).toEqual(['economy', 'hybrid_auto_downgrade']);

    expect(run({ config: cfg({ allowAutoDowngrade: false }), requirements: simple }).selected.modelKey).toBe('standard');
    expect(run({ requirements: req({ complexity: 'low', qualityGateCritical: true }) }).selected.modelKey).toBe('standard');

    // A security analysis is "low complexity" here, but §5.3 demands a high-reasoning model.
    const security = run({
      config: cfg({ primaryModelId: 'high' }),
      requirements: req({ complexity: 'low', taskKind: 'security_analysis' }),
    });
    expect([security.selected.modelKey, security.minTier]).toEqual(['high', 'high']);
  });

  it('hybrid: falls to the best remaining model when the primary is rejected', () => {
    const d = run({
      candidates: ALL.map((c) => (c.modelId === 'standard' ? { ...c, availability: 'unavailable' as const } : c)),
    });
    expect(d.selectionReason).toBe('hybrid_primary_rejected');
    expect(d.selected.modelKey).not.toBe('standard');
    expect(d.warnings[0]).toMatch(/^primary_rejected:model_unavailable/);
  });

  it('applies workspace hard ceilings over any configuration scope', () => {
    // Risk policy raises the floor: the standard primary is no longer acceptable.
    const risky = run({ requirements: req({ riskLevel: 'critical' }) });
    expect(risky.minTier).toBe('high');
    expect(risky.selected.modelKey).toBe('high');

    expect(
      haltReason(() => run({ config: cfg({ mode: 'fixed' }), ceilings: { deniedModelIds: ['standard'] } })),
    ).toBe('primary_model_rejected');

    // Crossing a provider trust boundary needs approval: the frontier model on prov-b is off the table.
    const pinned = run({
      config: cfg({ requireApprovalForProviderChange: true }),
      requirements: req({ complexity: 'critical' }),
    });
    expect(pinned.selected.modelKey).toBe('high');
    expect(pinned.warnings).toContain('upgraded_but_still_below_desired_tier');
    expect(pinned.candidates.find((c) => c.modelKey === 'frontier')!.rejections).toEqual([
      'provider_change_requires_approval',
    ]);
  });

  it('returns the configured fallback chain without the selected model', () => {
    const d = run({ config: cfg({ fallbackModelIds: ['standard', 'high', 'economy'] }) });
    expect(d.fallbackChain).toEqual(['high', 'economy']);
  });

  it('validates routing policy documents', () => {
    expect(parseHardCeilings({ maxOutputTokens: 4000, minQualityTier: 'standard' })).toEqual({
      maxOutputTokens: 4000,
      minQualityTier: 'standard',
    });
    expect(() => parseHardCeilings({ maxOutputTokens: -1 })).toThrow(/positive integer/);
    expect(() => parseHardCeilings({ bogus: 1 })).toThrow(/Unknown hard ceiling/);
    expect(() => parseRoutingRules({ minTierByRisk: { extreme: 'high' } })).toThrow(/Unknown risk level/);
    expect(parseRoutingRules({ minTierByRisk: { low: 'standard' } }).minTierByRisk).toEqual({ low: 'standard' });
  });
});

describe('fallback state machine (P4-06, Blueprint §5.4)', () => {
  const state = (over: Partial<FallbackState> = {}): FallbackState => ({
    currentModelId: 'primary',
    retriesOnCurrent: 0,
    maxRetries: 0,
    attempted: ['primary'],
    chain: [{ modelId: 'fb1', rejections: [] }, { modelId: 'fb2', rejections: [] }],
    budgetAllowsAnotherAttempt: true,
    ...over,
  });
  const err = (kind: ConstructorParameters<typeof ProviderAdapterError>[0], opts = {}) =>
    new ProviderAdapterError(kind, kind, opts);

  it('switches model on every valid trigger', () => {
    const triggers: Array<[ProviderAdapterError, string]> = [
      [err('timeout'), 'timeout'],
      [err('rate_limited', { httpStatus: 429 }), 'rate_limited'],
      [err('model_unavailable', { httpStatus: 503 }), 'model_unavailable'],
      [err('unknown_error', { httpStatus: 500 }), 'model_unavailable'],
      [err('unknown_error', { retryable: true }), 'transient_network'],
      [err('unsupported_capability', { httpStatus: 400 }), 'capability_mismatch'],
    ];
    for (const [e, trigger] of triggers) {
      const failure = classifyFailure(e);
      expect(failure, trigger).toMatchObject({ kind: 'fallback', trigger });
      expect(nextFallbackStep(failure, state()), trigger).toEqual({ action: 'switch', modelId: 'fb1', skipped: [] });
    }
  });

  it('retries the same model within the bound before switching, except for capability mismatches', () => {
    const timeout = classifyFailure(err('timeout'));
    expect(nextFallbackStep(timeout, state({ maxRetries: 2 }))).toEqual({ action: 'retry', modelId: 'primary' });
    expect(nextFallbackStep(timeout, state({ maxRetries: 2, retriesOnCurrent: 2 }))).toMatchObject({
      action: 'switch',
      modelId: 'fb1',
    });
    const mismatch = classifyFailure(err('unsupported_capability'));
    expect(nextFallbackStep(mismatch, state({ maxRetries: 2 }))).toMatchObject({ action: 'switch', modelId: 'fb1' });
  });

  it('halts immediately on every prohibited scenario', () => {
    const timeout = classifyFailure(err('timeout'));
    const halt = (failure: ReturnType<typeof classifyFailure>, s: FallbackState) => {
      const step = nextFallbackStep(failure, s);
      return step.action === 'halt' ? step.reason : `unexpected:${step.action}`;
    };

    expect(halt(classifyFailure(err('authentication_failed', { httpStatus: 401 })), state())).toBe('authentication_failed');
    expect(halt(classifyFailure(err('unknown_error', { httpStatus: 400, retryable: false })), state())).toBe('non_retryable_error');
    expect(halt(classifyFailure(new Error('bug')), state())).toBe('non_retryable_error');
    expect(halt(timeout, state({ budgetAllowsAnotherAttempt: false }))).toBe('budget_exhausted');
    expect(halt(timeout, state({ chain: [{ modelId: 'fb1', rejections: ['insufficient_cost_budget'] }] }))).toBe('budget_exhausted');
    expect(halt(timeout, state({ chain: [{ modelId: 'fb1', rejections: ['not_in_allowlist'] }] }))).toBe('fallback_outside_allowlist');
    expect(halt(timeout, state({ chain: [{ modelId: 'fb1', rejections: ['below_min_quality_tier'] }] }))).toBe('fallback_below_min_quality_tier');
    expect(halt(timeout, state({ chain: [{ modelId: 'fb1', rejections: ['provider_change_requires_approval'] }] }))).toBe('provider_change_requires_approval');
    expect(halt(timeout, state({ chain: [{ modelId: 'fb1', rejections: ['missing_capability:vision'] }] }))).toBe('no_capable_fallback');
    expect(halt(timeout, state({ chain: [] }))).toBe('fallback_chain_exhausted');
    expect(halt(timeout, state({ attempted: ['primary', 'fb1', 'fb2'] }))).toBe('fallback_chain_exhausted');
  });

  it('skips unusable fallbacks and reports them', () => {
    const step = nextFallbackStep(
      classifyFailure(err('rate_limited')),
      state({ chain: [{ modelId: 'fb1', rejections: ['provider_unhealthy'] }, { modelId: 'fb2', rejections: [] }] }),
    );
    expect(step).toEqual({
      action: 'switch',
      modelId: 'fb2',
      skipped: [{ modelId: 'fb1', rejections: ['provider_unhealthy'] }],
    });
  });
});
