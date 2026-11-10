import { and, eq } from 'drizzle-orm';
import { type Db, modelRoutingPolicies } from '@platform/db';
import { authorize } from '@platform/iam';
import { audit, emitEvent } from '@platform/observability';
import { type Actor, ForbiddenError, ValidationError } from '@platform/shared';

export type QualityTier = 'economy' | 'standard' | 'high' | 'frontier' | 'unknown';
export type RiskLevel = 'low' | 'medium' | 'high' | 'critical';

export const TIER_RANK: Readonly<Record<QualityTier, number>> = {
  unknown: 0,
  economy: 1,
  standard: 2,
  high: 3,
  frontier: 4,
};
const TIERS = Object.keys(TIER_RANK) as QualityTier[];
const RISKS: RiskLevel[] = ['low', 'medium', 'high', 'critical'];

/** The workspace policy row every routing decision is overlaid with. */
export const DEFAULT_POLICY_NAME = 'default';

/**
 * Hard ceilings (Blueprint §4.3 constraint): security and cost boundaries that no configuration scope —
 * not even a task override — can loosen.
 */
export interface HardCeilings {
  maxOutputTokens?: number;
  maxCostPerInvocationUsd?: number;
  minQualityTier?: QualityTier;
  deniedModelIds?: string[];
  allowedProviderIds?: string[];
  requireApprovalForProviderChange?: boolean;
}

export interface RoutingRules {
  /** When true a capability marked `unknown` is treated like `no`. */
  requireVerifiedCapabilities?: boolean;
  /** Task kinds that need a high-reasoning model (Blueprint §5.3). */
  highReasoningTaskKinds?: string[];
  highReasoningMinTier?: QualityTier;
  minTierByRisk?: Partial<Record<RiskLevel, QualityTier>>;
}

export interface RoutingPolicy {
  hardCeilings: HardCeilings;
  rules: Required<RoutingRules>;
}

export const DEFAULT_ROUTING_RULES: Required<RoutingRules> = {
  requireVerifiedCapabilities: false,
  highReasoningTaskKinds: ['architecture', 'security_analysis', 'complex_debugging', 'critical_review'],
  highReasoningMinTier: 'high',
  minTierByRisk: { high: 'standard', critical: 'high' },
};

function asTier(value: unknown, field: string): QualityTier {
  if (typeof value !== 'string' || !TIERS.includes(value as QualityTier) || value === 'unknown') {
    throw new ValidationError(`${field} must be one of economy, standard, high, frontier`);
  }
  return value as QualityTier;
}

function asStringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string' || !v.trim())) {
    throw new ValidationError(`${field} must be an array of non-empty strings`);
  }
  return [...new Set(value as string[])];
}

function asPositive(value: unknown, field: string, integer: boolean): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || (integer && !Number.isInteger(value))) {
    throw new ValidationError(`${field} must be a positive ${integer ? 'integer' : 'number'}`);
  }
  return value;
}

export function parseHardCeilings(raw: Record<string, unknown>): HardCeilings {
  const out: HardCeilings = {};
  const known = new Set([
    'maxOutputTokens',
    'maxCostPerInvocationUsd',
    'minQualityTier',
    'deniedModelIds',
    'allowedProviderIds',
    'requireApprovalForProviderChange',
  ]);
  for (const key of Object.keys(raw)) {
    if (!known.has(key)) throw new ValidationError(`Unknown hard ceiling '${key}'`);
  }
  if (raw['maxOutputTokens'] != null) out.maxOutputTokens = asPositive(raw['maxOutputTokens'], 'maxOutputTokens', true);
  if (raw['maxCostPerInvocationUsd'] != null) {
    out.maxCostPerInvocationUsd = asPositive(raw['maxCostPerInvocationUsd'], 'maxCostPerInvocationUsd', false);
  }
  if (raw['minQualityTier'] != null) out.minQualityTier = asTier(raw['minQualityTier'], 'minQualityTier');
  if (raw['deniedModelIds'] != null) out.deniedModelIds = asStringArray(raw['deniedModelIds'], 'deniedModelIds');
  if (raw['allowedProviderIds'] != null) {
    out.allowedProviderIds = asStringArray(raw['allowedProviderIds'], 'allowedProviderIds');
  }
  if (raw['requireApprovalForProviderChange'] != null) {
    if (typeof raw['requireApprovalForProviderChange'] !== 'boolean') {
      throw new ValidationError('requireApprovalForProviderChange must be a boolean');
    }
    out.requireApprovalForProviderChange = raw['requireApprovalForProviderChange'];
  }
  return out;
}

export function parseRoutingRules(raw: Record<string, unknown>): Required<RoutingRules> {
  const known = new Set(['requireVerifiedCapabilities', 'highReasoningTaskKinds', 'highReasoningMinTier', 'minTierByRisk']);
  for (const key of Object.keys(raw)) {
    if (!known.has(key)) throw new ValidationError(`Unknown routing rule '${key}'`);
  }
  const rules: Required<RoutingRules> = {
    ...DEFAULT_ROUTING_RULES,
    minTierByRisk: { ...DEFAULT_ROUTING_RULES.minTierByRisk },
  };
  if (raw['requireVerifiedCapabilities'] != null) {
    if (typeof raw['requireVerifiedCapabilities'] !== 'boolean') {
      throw new ValidationError('requireVerifiedCapabilities must be a boolean');
    }
    rules.requireVerifiedCapabilities = raw['requireVerifiedCapabilities'];
  }
  if (raw['highReasoningTaskKinds'] != null) {
    rules.highReasoningTaskKinds = asStringArray(raw['highReasoningTaskKinds'], 'highReasoningTaskKinds');
  }
  if (raw['highReasoningMinTier'] != null) {
    rules.highReasoningMinTier = asTier(raw['highReasoningMinTier'], 'highReasoningMinTier');
  }
  if (raw['minTierByRisk'] != null) {
    const m = raw['minTierByRisk'];
    if (typeof m !== 'object' || Array.isArray(m)) throw new ValidationError('minTierByRisk must be an object');
    const parsed: Partial<Record<RiskLevel, QualityTier>> = {};
    for (const [risk, tier] of Object.entries(m as Record<string, unknown>)) {
      if (!RISKS.includes(risk as RiskLevel)) throw new ValidationError(`Unknown risk level '${risk}'`);
      parsed[risk as RiskLevel] = asTier(tier, `minTierByRisk.${risk}`);
    }
    rules.minTierByRisk = parsed;
  }
  return rules;
}

/** Loads the workspace routing policy; a workspace without one gets the documented defaults. */
export async function getRoutingPolicy(db: Db, workspaceId: string): Promise<RoutingPolicy> {
  const [row] = await db
    .select()
    .from(modelRoutingPolicies)
    .where(and(eq(modelRoutingPolicies.workspaceId, workspaceId), eq(modelRoutingPolicies.name, DEFAULT_POLICY_NAME)))
    .limit(1);
  if (!row) return { hardCeilings: {}, rules: { ...DEFAULT_ROUTING_RULES } };
  return { hardCeilings: parseHardCeilings(row.hardCeilings), rules: parseRoutingRules(row.rules) };
}

export async function readRoutingPolicy(db: Db, actor: Actor): Promise<RoutingPolicy> {
  await authorize(db, actor, 'ai.config.read');
  if (!actor.workspaceId) throw new ValidationError('A workspace context is required');
  return getRoutingPolicy(db, actor.workspaceId);
}

/** Replaces the workspace routing policy. Workspace-wide boundary, so administrators only. */
export async function upsertRoutingPolicy(
  db: Db,
  actor: Actor,
  input: { hardCeilings?: Record<string, unknown>; rules?: Record<string, unknown> },
): Promise<RoutingPolicy> {
  const { role } = await authorize(db, actor, 'ai.config.manage');
  if (role !== 'owner' && role !== 'administrator' && role !== 'system') {
    throw new ForbiddenError('Routing policies can only be changed by workspace administrators');
  }
  const workspaceId = actor.workspaceId;
  if (!workspaceId) throw new ValidationError('A workspace context is required');
  const hardCeilings = parseHardCeilings(input.hardCeilings ?? {});
  const rules = parseRoutingRules(input.rules ?? {});

  return db.transaction(async (tx) => {
    const [existing] = await tx
      .select()
      .from(modelRoutingPolicies)
      .where(
        and(eq(modelRoutingPolicies.workspaceId, workspaceId), eq(modelRoutingPolicies.name, DEFAULT_POLICY_NAME)),
      )
      .limit(1);
    const values = {
      hardCeilings: hardCeilings as Record<string, unknown>,
      rules: rules as unknown as Record<string, unknown>,
    };
    let policyId: string;
    if (existing) {
      await tx
        .update(modelRoutingPolicies)
        .set({ ...values, updatedAt: new Date(), version: existing.version + 1 })
        .where(eq(modelRoutingPolicies.id, existing.id));
      policyId = existing.id;
    } else {
      const [created] = await tx
        .insert(modelRoutingPolicies)
        .values({ workspaceId, name: DEFAULT_POLICY_NAME, ...values })
        .returning();
      policyId = created!.id;
    }
    await audit(tx, actor, {
      action: 'ai.routing_policy.updated',
      targetType: 'model_routing_policy',
      targetId: policyId,
      payload: { before: existing ? { hardCeilings: existing.hardCeilings, rules: existing.rules } : null, after: values },
    });
    await emitEvent(tx, {
      type: 'ai.routing_policy.updated',
      aggregateType: 'model_routing_policy',
      aggregateId: policyId,
      workspaceId,
      payload: { policyId },
    });
    return { hardCeilings, rules };
  });
}
