import { ProviderAdapterError } from '@platform/ai-management';

/** Valid fallback triggers (Blueprint §5.4). */
export type FallbackTrigger =
  | 'timeout'
  | 'rate_limited'
  | 'model_unavailable'
  | 'transient_network'
  | 'capability_mismatch';

/** Reasons the fallback state machine stops instead of switching model (Blueprint §5.4 prohibited scenarios). */
export type FallbackHaltReason =
  | 'authentication_failed'
  | 'non_retryable_error'
  | 'budget_exhausted'
  | 'fallback_outside_allowlist'
  | 'fallback_below_min_quality_tier'
  | 'provider_change_requires_approval'
  | 'no_capable_fallback'
  | 'fallback_chain_exhausted';

export type FailureClass =
  | { kind: 'fallback'; trigger: FallbackTrigger; retrySameModel: boolean }
  | { kind: 'halt'; reason: FallbackHaltReason };

/**
 * Classifies a provider failure. Authentication failures and non-transient errors never trigger a model
 * switch: a different model would hide a configuration problem a human has to fix.
 */
export function classifyFailure(err: unknown): FailureClass {
  if (!(err instanceof ProviderAdapterError)) return { kind: 'halt', reason: 'non_retryable_error' };
  switch (err.kind) {
    case 'authentication_failed':
      return { kind: 'halt', reason: 'authentication_failed' };
    case 'timeout':
      return { kind: 'fallback', trigger: 'timeout', retrySameModel: true };
    case 'rate_limited':
      return { kind: 'fallback', trigger: 'rate_limited', retrySameModel: true };
    case 'model_unavailable':
      return { kind: 'fallback', trigger: 'model_unavailable', retrySameModel: err.retryable };
    case 'unsupported_capability':
      return { kind: 'fallback', trigger: 'capability_mismatch', retrySameModel: false };
    case 'unknown_error':
      if ((err.httpStatus ?? 0) >= 500) return { kind: 'fallback', trigger: 'model_unavailable', retrySameModel: true };
      if (err.retryable) return { kind: 'fallback', trigger: 'transient_network', retrySameModel: true };
      return { kind: 'halt', reason: 'non_retryable_error' };
  }
}

export interface FallbackOption {
  modelId: string;
  /** Hard-filter rejections of this model for the current request; empty when it is usable. */
  rejections: string[];
}

export type FallbackStep =
  | { action: 'retry'; modelId: string }
  | { action: 'switch'; modelId: string; skipped: Array<{ modelId: string; rejections: string[] }> }
  | {
      action: 'halt';
      reason: FallbackHaltReason;
      skipped: Array<{ modelId: string; rejections: string[] }>;
      /** The fallback model that caused the halt, when one did. */
      blockedModelId?: string;
    };

export interface FallbackState {
  currentModelId: string;
  /** Retries already spent on the current model. */
  retriesOnCurrent: number;
  maxRetries: number;
  /** Models already attempted in this invocation, including the current one. */
  attempted: string[];
  /** Remaining configured chain in order, each pre-evaluated against the hard filters. */
  chain: FallbackOption[];
  budgetAllowsAnotherAttempt: boolean;
}

/**
 * Pure transition function of the fallback state machine:
 * `primary → retry same model (bounded) → next usable fallback → … → halt`.
 */
export function nextFallbackStep(failure: FailureClass, state: FallbackState): FallbackStep {
  if (failure.kind === 'halt') return { action: 'halt', reason: failure.reason, skipped: [] };
  if (!state.budgetAllowsAnotherAttempt) return { action: 'halt', reason: 'budget_exhausted', skipped: [] };
  if (failure.retrySameModel && state.retriesOnCurrent < state.maxRetries) {
    return { action: 'retry', modelId: state.currentModelId };
  }

  const skipped: Array<{ modelId: string; rejections: string[] }> = [];
  let capabilitySkips = 0;
  for (const option of state.chain) {
    if (state.attempted.includes(option.modelId)) continue;
    const r = option.rejections;
    if (r.includes('not_in_allowlist') || r.includes('denied_by_policy') || r.includes('provider_not_allowed_by_policy')) {
      return { action: 'halt', reason: 'fallback_outside_allowlist', skipped };
    }
    if (r.includes('below_min_quality_tier')) {
      return { action: 'halt', reason: 'fallback_below_min_quality_tier', skipped };
    }
    if (r.includes('provider_change_requires_approval')) {
      return { action: 'halt', reason: 'provider_change_requires_approval', skipped, blockedModelId: option.modelId };
    }
    if (r.includes('insufficient_cost_budget') || r.includes('insufficient_token_budget')) {
      return { action: 'halt', reason: 'budget_exhausted', skipped };
    }
    if (r.length > 0) {
      if (r.some((x) => x.startsWith('missing_capability:') || x.startsWith('unverified_capability:'))) capabilitySkips++;
      skipped.push({ modelId: option.modelId, rejections: r });
      continue;
    }
    return { action: 'switch', modelId: option.modelId, skipped };
  }

  return {
    action: 'halt',
    reason: skipped.length > 0 && capabilitySkips === skipped.length ? 'no_capable_fallback' : 'fallback_chain_exhausted',
    skipped,
  };
}
