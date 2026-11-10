import { and, desc, eq, inArray, lte } from 'drizzle-orm';
import {
  type AgentModelConfigView,
  type CapabilitySupport,
  type ChatMessage,
  computeEstimatedCost,
  type InvocationResponse,
  type ModelCapabilityKey,
  type ProviderAdapterRegistry,
  ProviderAdapterError,
  requireWorkspaceId,
  resolveEffectiveModelConfig,
  resolveProviderConnectionContext,
  type SecretStore,
  type ToolDefinition,
} from '@platform/ai-management';
import {
  type BudgetBand,
  type BudgetDecision,
  type BudgetHaltHandler,
  type BudgetScope,
  type BudgetTransition,
  checkBudgets,
  recordConsumption,
} from '@platform/budget';
import {
  aiModelCapabilities,
  aiModelPricing,
  aiModels,
  aiProviders,
  costRecords,
  type Db,
  fallbackEvents,
  modelInvocations,
  tokenUsage,
} from '@platform/db';
import { authorize } from '@platform/iam';
import { audit } from '@platform/observability';
import { type Actor, actorId, AppError, UnprocessableError } from '@platform/shared';
import { classifyFailure, type FallbackOption, nextFallbackStep } from './fallback.js';
import { getRoutingPolicy, type RiskLevel, type RoutingPolicy } from './policy.js';
import {
  type RoutingCandidate,
  type RoutingDecision,
  RoutingHaltError,
  type RoutingRequirements,
  selectModel,
  type TaskComplexity,
} from './selection.js';

/** Worst-case output assumed for budget and cost pre-checks when nothing configures or estimates it. */
export const DEFAULT_OUTPUT_TOKEN_BUDGET = 2048;

/** Raised when the token / cost budget forbids the invocation; a human must raise the limit or cut scope. */
export class BudgetBlockedError extends UnprocessableError {
  readonly decision: BudgetDecision;
  constructor(decision: BudgetDecision) {
    super(
      `Invocation blocked by ${decision.blockingLevel ?? 'a'} budget: ${decision.reason}`,
      'budget_blocked',
      {
        reason: decision.reason,
        budgetId: decision.blockingBudgetId,
        level: decision.blockingLevel,
        band: decision.worstBand,
        requiresHumanApproval: true,
      },
    );
    this.decision = decision;
  }
}

/** Raised when the fallback state machine stops after provider failures. */
export class InvocationHaltedError extends AppError {
  readonly haltReason: string;
  constructor(haltReason: string, detail: string, extensions: Record<string, unknown>) {
    super({
      status: 502,
      code: 'invocation_halted',
      title: 'AI invocation halted',
      detail,
      extensions: { haltReason, requiresHumanIntervention: true, ...extensions },
    });
    this.haltReason = haltReason;
  }
}

export interface RouteQuery {
  agentKey: string;
  projectId?: string;
  workflowId?: string;
  taskId?: string;
  requiredCapabilities?: ModelCapabilityKey[];
  estimatedInputTokens?: number;
  expectedOutputTokens?: number;
  maxOutputTokens?: number;
  reasoningEffort?: 'low' | 'medium' | 'high';
  complexity?: TaskComplexity;
  riskLevel?: RiskLevel;
  taskKind?: string;
  qualityGateCritical?: boolean;
  /** Mandatory verification / testing work that must keep running in the restricted budget band. */
  essential?: boolean;
}

export interface EffectiveParams {
  temperature?: number;
  maxOutputTokens?: number;
  reasoningEffort?: 'low' | 'medium' | 'high';
}

export interface RoutePlan {
  workspaceId: string;
  scope: BudgetScope;
  config: AgentModelConfigView;
  policy: RoutingPolicy;
  requirements: RoutingRequirements;
  decision: RoutingDecision;
  candidates: Map<string, RoutingCandidate>;
  effectiveParams: EffectiveParams;
  budget: BudgetDecision;
  essential: boolean;
  /** Structured, audit-ready rationale for the decision (Blueprint §5.1 output). */
  explanation: Record<string, unknown>;
}

async function loadCandidates(db: Db, workspaceId: string, modelIds: string[]): Promise<Map<string, RoutingCandidate>> {
  const out = new Map<string, RoutingCandidate>();
  if (modelIds.length === 0) return out;
  const rows = await db
    .select({ model: aiModels, provider: aiProviders })
    .from(aiModels)
    .innerJoin(aiProviders, eq(aiModels.providerId, aiProviders.id))
    .where(and(eq(aiProviders.workspaceId, workspaceId), inArray(aiModels.id, modelIds)));
  const caps = await db.select().from(aiModelCapabilities).where(inArray(aiModelCapabilities.modelId, modelIds));
  const prices = await db
    .select()
    .from(aiModelPricing)
    .where(and(inArray(aiModelPricing.modelId, modelIds), lte(aiModelPricing.effectiveFrom, new Date())))
    .orderBy(desc(aiModelPricing.effectiveFrom), desc(aiModelPricing.createdAt));

  const capsByModel = new Map<string, Partial<Record<ModelCapabilityKey, CapabilitySupport>>>();
  for (const c of caps) {
    const entry = capsByModel.get(c.modelId) ?? {};
    entry[c.capability] = c.support;
    capsByModel.set(c.modelId, entry);
  }
  const priceByModel = new Map<string, (typeof prices)[number]>();
  for (const p of prices) if (!priceByModel.has(p.modelId)) priceByModel.set(p.modelId, p);

  for (const { model, provider } of rows) {
    const price = priceByModel.get(model.id);
    out.set(model.id, {
      modelId: model.id,
      modelKey: model.modelKey,
      providerId: provider.id,
      providerKey: provider.providerKey,
      providerEnabled: provider.enabled,
      providerHealth: provider.healthStatus,
      availability: model.availability,
      contextWindow: model.contextWindow,
      maxOutputTokens: model.maxOutputTokens,
      qualityTier: model.qualityTier,
      capabilities: capsByModel.get(model.id) ?? {},
      pricing: price
        ? { inputPerMtok: Number(price.inputPerMtok), outputPerMtok: Number(price.outputPerMtok) }
        : null,
    });
  }
  return out;
}

function minDefined(...values: Array<number | null | undefined>): number | null {
  const defined = values.filter((v): v is number => v != null && Number.isFinite(v));
  return defined.length ? Math.min(...defined) : null;
}

/**
 * Resolves provider, model, validated parameters, fallback chain and rationale for one invocation without
 * calling any provider (Blueprint §5.1). Throws {@link RoutingHaltError} or {@link BudgetBlockedError} when
 * nothing valid can be dispatched.
 */
export async function resolveRoute(db: Db, workspaceId: string, query: RouteQuery): Promise<RoutePlan> {
  const resolution = await resolveEffectiveModelConfig(db, {
    workspaceId,
    agentKey: query.agentKey,
    ...(query.projectId ? { projectId: query.projectId } : {}),
    ...(query.workflowId ? { workflowId: query.workflowId } : {}),
    ...(query.taskId ? { taskId: query.taskId } : {}),
  });
  const config = resolution.config;
  const policy = await getRoutingPolicy(db, workspaceId);
  const ceilings = policy.hardCeilings;
  const ceilingsApplied: string[] = [];

  // Generation parameters: the request overrides configuration, hard ceilings clamp both (§4.3).
  let maxOutputTokens = query.maxOutputTokens ?? config.params.maxOutputTokens;
  if (ceilings.maxOutputTokens !== undefined && (maxOutputTokens ?? Infinity) > ceilings.maxOutputTokens) {
    ceilingsApplied.push(`maxOutputTokens:${maxOutputTokens ?? 'unset'}->${ceilings.maxOutputTokens}`);
    maxOutputTokens = ceilings.maxOutputTokens;
  }
  const reasoningEffort = query.reasoningEffort ?? config.params.reasoningEffort;

  const required = new Set<ModelCapabilityKey>(query.requiredCapabilities ?? []);
  if (config.params.toolCalling) required.add('tool_calling');
  if (config.params.streaming) required.add('streaming');
  if (reasoningEffort !== undefined) required.add('reasoning');

  const requirements: RoutingRequirements = {
    requiredCapabilities: [...required].sort(),
    estimatedInputTokens: Math.max(0, Math.trunc(query.estimatedInputTokens ?? 0)),
    outputTokenBudget: maxOutputTokens ?? query.expectedOutputTokens ?? DEFAULT_OUTPUT_TOKEN_BUDGET,
    expectedOutputTokens: query.expectedOutputTokens ?? null,
    complexity: query.complexity ?? 'medium',
    riskLevel: query.riskLevel ?? 'low',
    taskKind: query.taskKind?.trim().toLowerCase() || null,
    qualityGateCritical: query.qualityGateCritical ?? false,
  };

  const scope: BudgetScope = {
    workspaceId,
    projectId: query.projectId ?? null,
    workflowId: query.workflowId ?? null,
    taskId: query.taskId ?? null,
  };
  const essential = query.essential ?? false;
  const estimatedTokens = requirements.estimatedInputTokens + requirements.outputTokenBudget;
  const preliminary = await checkBudgets(db, scope, { estimatedTokens, estimatedCostUsd: 0, essential });
  if (!preliminary.allowed) throw new BudgetBlockedError(preliminary);

  const invocationBudget = preliminary.budgets.find((b) => b.level === 'invocation');
  const modelIds = [
    ...new Set([
      ...(config.primaryModelId ? [config.primaryModelId] : []),
      ...config.allowlistModelIds,
      ...config.fallbackModelIds,
    ]),
  ];
  const candidates = await loadCandidates(db, workspaceId, modelIds);

  const decision = selectModel({
    config: {
      mode: config.mode,
      primaryModelId: config.primaryModelId,
      allowlistModelIds: config.allowlistModelIds,
      fallbackModelIds: config.fallbackModelIds,
      allowAutoUpgrade: config.routingPolicy.allowAutoUpgrade ?? false,
      allowAutoDowngrade: config.routingPolicy.allowAutoDowngrade ?? false,
      requireApprovalForProviderChange: config.routingPolicy.requireApprovalForProviderChange ?? false,
      maxCostUsd: minDefined(
        config.limits.maxCostPerTask !== undefined ? Number(config.limits.maxCostPerTask) : null,
        invocationBudget?.costLimitUsd != null ? Number(invocationBudget.costLimitUsd) : null,
      ),
    },
    candidates: [...candidates.values()],
    requirements,
    ceilings,
    rules: policy.rules,
    limits: { remainingTokens: preliminary.remainingTokens, remainingCostUsd: preliminary.remainingCostUsd },
  });

  const budget = await checkBudgets(db, scope, {
    estimatedTokens,
    estimatedCostUsd: decision.estimatedCostUsd,
    essential,
  });
  if (!budget.allowed) throw new BudgetBlockedError(budget);

  const effectiveParams: EffectiveParams = {};
  const temperature = config.params.temperature;
  if (temperature !== undefined) effectiveParams.temperature = temperature;
  if (maxOutputTokens !== undefined) effectiveParams.maxOutputTokens = maxOutputTokens;
  if (reasoningEffort !== undefined) effectiveParams.reasoningEffort = reasoningEffort;

  const keyOf = (id: string) => candidates.get(id)?.modelKey ?? id;
  const explanation: Record<string, unknown> = {
    router: 'model-router/1',
    mode: config.mode,
    resolvedScope: config.scope,
    resolvedScopeKey: config.scopeKey,
    configId: config.id,
    configVersion: config.configVersion,
    precedenceChain: resolution.precedenceChain,
    selectedProviderKey: decision.selected.providerKey,
    selectedModelKey: decision.selected.modelKey,
    selectionReason: decision.selectionReason,
    minTier: decision.minTier,
    desiredTier: decision.desiredTier,
    requirements,
    effectiveParams,
    ceilingsApplied,
    estimatedCostUsd: decision.estimatedCostUsd !== null ? decision.estimatedCostUsd.toFixed(6) : null,
    candidates: decision.candidates.map((c) => ({
      modelKey: c.modelKey,
      providerKey: c.providerKey,
      qualityTier: c.qualityTier,
      eligible: c.eligible,
      rejections: c.rejections,
      score: c.score,
    })),
    fallbackChain: decision.fallbackChain.map(keyOf),
    warnings: decision.warnings,
    budget: {
      worstBand: budget.worstBand,
      optimizeContext: budget.optimizeContext,
      remainingTokens: budget.remainingTokens,
      remainingCostUsd: budget.remainingCostUsd,
      notes: budget.notes,
    },
  };

  return {
    workspaceId,
    scope,
    config,
    policy,
    requirements,
    decision,
    candidates,
    effectiveParams,
    budget,
    essential,
    explanation,
  };
}

/** Dry-run of the router for the configuration UI and for debugging (no provider is called). */
export async function previewRoute(db: Db, actor: Actor, query: RouteQuery) {
  await authorize(db, actor, 'ai.config.read');
  const plan = await resolveRoute(db, requireWorkspaceId(actor), query);
  return {
    providerKey: plan.decision.selected.providerKey,
    modelId: plan.decision.selected.modelId,
    modelKey: plan.decision.selected.modelKey,
    effectiveParams: plan.effectiveParams,
    fallbackModelIds: plan.decision.fallbackChain,
    explanation: plan.explanation,
  };
}

export interface RouterDeps {
  db: Db;
  secretStore: SecretStore;
  registry: ProviderAdapterRegistry;
  /** Saves a checkpoint when a budget halts (Blueprint §10.4). */
  onBudgetHalt?: BudgetHaltHandler;
  /** Backoff between retries on the same model; injectable so tests do not wait. */
  sleep?: (ms: number) => Promise<void>;
}

export interface RoutedInvocationInput extends RouteQuery {
  agentVersion?: number;
  systemInstruction?: string;
  untrustedContext?: string;
  messages: ChatMessage[];
  tools?: ToolDefinition[];
  jsonSchema?: { name: string; schema: Record<string, unknown> };
  temperature?: number;
}

export interface RoutedInvocationResult {
  invocationId: string;
  providerId: string;
  providerKey: string;
  modelId: string;
  modelKey: string;
  configId: string;
  configVersion: number;
  response: InvocationResponse;
  estimatedCost: string | null;
  currency: string | null;
  routing: {
    mode: string;
    selectionReason: string;
    fallbackUsed: boolean;
    attempts: number;
    explanation: Record<string, unknown>;
  };
  budget: {
    worstBand: BudgetBand;
    optimizeContext: boolean;
    haltTriggered: boolean;
    transitions: BudgetTransition[];
  };
}

function approximateTokens(input: RoutedInvocationInput): number {
  const chars =
    (input.systemInstruction?.length ?? 0) +
    (input.untrustedContext?.length ?? 0) +
    input.messages.reduce((n, m) => n + m.content.length, 0) +
    (input.tools ? JSON.stringify(input.tools).length : 0) +
    (input.jsonSchema ? JSON.stringify(input.jsonSchema).length : 0);
  return Math.ceil(chars / 4);
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * The single entry point for agent model calls: routes, enforces budgets, dispatches through the provider
 * adapter with the fallback state machine, and writes the invocation ledger, fallback log, budget
 * consumption and the routing rationale to the audit log.
 */
export async function routeAndInvoke(
  deps: RouterDeps,
  actor: Actor,
  input: RoutedInvocationInput,
): Promise<RoutedInvocationResult> {
  const { db, secretStore, registry } = deps;
  const workspaceId = requireWorkspaceId(actor);
  const agentKey = input.agentKey.trim().toLowerCase();

  const required = new Set<ModelCapabilityKey>(input.requiredCapabilities ?? []);
  if (input.tools?.length) required.add('tool_calling');
  if (input.jsonSchema) required.add('structured_output');

  let plan: RoutePlan;
  try {
    plan = await resolveRoute(db, workspaceId, {
      ...input,
      agentKey,
      requiredCapabilities: [...required],
      estimatedInputTokens: input.estimatedInputTokens ?? approximateTokens(input),
    });
  } catch (err) {
    if (err instanceof RoutingHaltError || err instanceof BudgetBlockedError) {
      await audit(db, actor, {
        action: 'ai.routing.halted',
        targetType: 'agent',
        targetId: null,
        projectId: input.projectId ?? null,
        payload: {
          agentKey,
          taskId: input.taskId ?? null,
          workflowId: input.workflowId ?? null,
          stage: 'pre_dispatch',
          code: err.code,
          ...err.extensions,
        },
      });
    }
    throw err;
  }

  const { config, decision } = plan;
  const timeoutMs = config.limits.timeoutSeconds !== undefined ? config.limits.timeoutSeconds * 1000 : 60_000;
  const maxRetries = config.limits.maxRetries ?? 0;
  const sleep = deps.sleep ?? defaultSleep;
  const rejectionsOf = new Map(decision.candidates.map((c) => [c.modelId, c.rejections]));
  const chain: FallbackOption[] = decision.fallbackChain.map((modelId) => ({
    modelId,
    // A fallback that is not even a registered candidate can only be treated as outside the allowlist.
    rejections: plan.candidates.has(modelId) ? (rejectionsOf.get(modelId) ?? []) : ['not_in_allowlist'],
  }));

  const baseRow = {
    workspaceId,
    purpose: 'agent' as const,
    agentKey,
    agentVersion: input.agentVersion ?? 1,
    projectId: input.projectId ?? null,
    workflowId: input.workflowId ?? null,
    taskId: input.taskId ?? null,
    configId: config.id,
    configVersion: config.configVersion,
    actorType: actor.type,
    actorId: actorId(actor),
  };

  const attempted: string[] = [];
  const trail: Array<Record<string, unknown>> = [];
  let current = decision.selected;
  let retriesOnCurrent = 0;
  let attempts = 0;

  for (;;) {
    attempts++;
    if (!attempted.includes(current.modelId)) attempted.push(current.modelId);
    const started = Date.now();
    const explanation = { ...plan.explanation, dispatchedModelKey: current.modelKey, attempts: trail };

    let response: InvocationResponse;
    try {
      const { provider, ctx } = await resolveProviderConnectionContext(db, secretStore, workspaceId, current.providerId, {
        requireEnabled: true,
        timeoutMs,
      });
      const params = plan.effectiveParams;
      const temperature = input.temperature ?? params.temperature;
      const maxOutputTokens =
        params.maxOutputTokens !== undefined && current.maxOutputTokens !== null
          ? Math.min(params.maxOutputTokens, current.maxOutputTokens)
          : params.maxOutputTokens;

      response = await registry.get(provider.adapterType).invoke(ctx, {
        modelKey: current.modelKey,
        ...(input.systemInstruction !== undefined ? { systemInstruction: input.systemInstruction } : {}),
        ...(input.untrustedContext !== undefined ? { untrustedContext: input.untrustedContext } : {}),
        messages: input.messages,
        ...(input.tools !== undefined ? { tools: input.tools } : {}),
        ...(input.jsonSchema !== undefined ? { jsonSchema: input.jsonSchema } : {}),
        ...(temperature !== undefined ? { temperature } : {}),
        ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
        ...(params.reasoningEffort !== undefined ? { reasoningEffort: params.reasoningEffort } : {}),
        knownCapabilities: current.capabilities,
      });

    } catch (err) {
      const errorKind = err instanceof ProviderAdapterError ? err.kind : 'unknown_error';
      const [failed] = await db
        .insert(modelInvocations)
        .values({
          ...baseRow,
          providerId: current.providerId,
          modelId: current.modelId,
          status: 'failed',
          errorKind,
          retryCount: attempts - 1,
          durationMs: Math.max(1, Date.now() - started),
          routingExplanation: explanation,
        })
        .returning();
      // Anything that is not a provider failure is a platform error: never mask it with a model switch.
      if (!(err instanceof ProviderAdapterError)) throw err;

      const failure = classifyFailure(err);
      const budgetNow =
        failure.kind === 'fallback'
          ? await checkBudgets(db, plan.scope, {
              estimatedTokens: plan.requirements.estimatedInputTokens + plan.requirements.outputTokenBudget,
              estimatedCostUsd: 0,
              essential: plan.essential,
            })
          : null;
      const step = nextFallbackStep(failure, {
        currentModelId: current.modelId,
        retriesOnCurrent,
        maxRetries,
        attempted,
        chain,
        budgetAllowsAnotherAttempt: budgetNow?.allowed ?? true,
      });
      const trigger = failure.kind === 'fallback' ? failure.trigger : errorKind;
      trail.push({
        attempt: attempts,
        modelKey: current.modelKey,
        errorKind,
        trigger,
        next: step.action,
        ...(step.action === 'halt' ? { haltReason: step.reason } : {}),
        ...(step.action !== 'retry' && step.skipped.length
          ? { skipped: step.skipped.map((s) => ({ modelKey: plan.candidates.get(s.modelId)?.modelKey ?? s.modelId, rejections: s.rejections })) }
          : {}),
      });

      if (step.action === 'retry') {
        await sleep(Math.min(2000, 250 * 2 ** retriesOnCurrent));
        retriesOnCurrent++;
        continue;
      }

      const next = step.action === 'switch' ? plan.candidates.get(step.modelId)! : null;
      await db.transaction(async (tx) => {
        await tx.insert(fallbackEvents).values({
          workspaceId,
          invocationId: failed!.id,
          agentKey,
          projectId: input.projectId ?? null,
          taskId: input.taskId ?? null,
          originalModelId: current.modelId,
          fallbackModelId: next?.modelId ?? null,
          attemptCount: attempts,
          triggerKind: trigger,
          allowed: step.action === 'switch',
          haltReason: step.action === 'halt' ? step.reason : null,
        });
        await audit(tx, actor, {
          action: step.action === 'switch' ? 'ai.routing.fallback' : 'ai.routing.halted',
          targetType: 'model_invocation',
          targetId: failed!.id,
          projectId: input.projectId ?? null,
          payload: {
            agentKey,
            taskId: input.taskId ?? null,
            stage: 'dispatch',
            failureCause: trigger,
            originalModelKey: current.modelKey,
            fallbackModelKey: next?.modelKey ?? null,
            attemptCount: attempts,
            ...(step.action === 'halt' ? { haltReason: step.reason } : {}),
            ...explanation,
          },
        });
      });

      if (step.action === 'halt') {
        throw new InvocationHaltedError(
          step.reason,
          `Invocation for agent '${agentKey}' halted after ${attempts} attempt(s): ${step.reason} (${err.message})`,
          { providerErrorKind: errorKind, attempts, trail },
        );
      }
      current = next!;
      retriesOnCurrent = 0;
      continue;
    }

    const cost = await computeEstimatedCost(db, current.modelId, response.usage);
    const invocation = await db.transaction(async (tx) => {
      const [inv] = await tx
        .insert(modelInvocations)
        .values({
          ...baseRow,
          providerId: current.providerId,
          modelId: current.modelId,
          providerRequestId: response.providerRequestId,
          status: 'succeeded',
          retryCount: attempts - 1,
          durationMs: response.rawLatencyMs,
          routingExplanation: explanation,
        })
        .returning();
      await tx.insert(tokenUsage).values({
        invocationId: inv!.id,
        inputTokens: response.usage.inputTokens,
        outputTokens: response.usage.outputTokens,
        cachedTokens: response.usage.cachedTokens,
        reasoningTokens: response.usage.reasoningTokens,
      });
      await tx.insert(costRecords).values({
        invocationId: inv!.id,
        estimatedCost: cost.estimatedCost,
        actualCost: cost.actualCost,
        currency: cost.currency,
        pricingId: cost.pricingId,
        note: cost.note,
      });
      await audit(tx, actor, {
        action: 'ai.routing.decided',
        targetType: 'model_invocation',
        targetId: inv!.id,
        projectId: input.projectId ?? null,
        payload: { agentKey, taskId: input.taskId ?? null, workflowId: input.workflowId ?? null, ...explanation },
      });
      return inv!;
    });

    const consumption = await recordConsumption(
      db,
      actor,
      plan.scope,
      {
        tokens:
          (response.usage.inputTokens ?? 0) +
          (response.usage.outputTokens ?? 0) +
          (response.usage.reasoningTokens ?? 0),
        costUsd: cost.estimatedCost !== null ? Number(cost.estimatedCost) : null,
      },
      deps.onBudgetHalt ? { onHalt: deps.onBudgetHalt } : {},
    );
    const worstBand = consumption.transitions.length ? consumption.worstBand : plan.budget.worstBand;

    return {
      invocationId: invocation.id,
      providerId: current.providerId,
      providerKey: current.providerKey,
      modelId: current.modelId,
      modelKey: current.modelKey,
      configId: config.id,
      configVersion: config.configVersion,
      response,
      estimatedCost: cost.estimatedCost,
      currency: cost.currency,
      routing: {
        mode: decision.mode,
        selectionReason: decision.selectionReason,
        fallbackUsed: current.modelId !== decision.selected.modelId,
        attempts,
        explanation,
      },
      budget: {
        worstBand,
        optimizeContext: worstBand !== 'normal',
        haltTriggered: consumption.haltTriggered,
        transitions: consumption.transitions,
      },
    };
  }
}

export async function listFallbackEvents(
  db: Db,
  actor: Actor,
  filter: { agentKey?: string; projectId?: string; taskId?: string; limit?: number } = {},
) {
  await authorize(db, actor, 'ai.config.read');
  const workspaceId = requireWorkspaceId(actor);
  const limit = Math.min(Math.max(1, filter.limit ?? 50), 200);
  return db
    .select()
    .from(fallbackEvents)
    .where(
      and(
        eq(fallbackEvents.workspaceId, workspaceId),
        filter.agentKey ? eq(fallbackEvents.agentKey, filter.agentKey.toLowerCase()) : undefined,
        filter.projectId ? eq(fallbackEvents.projectId, filter.projectId) : undefined,
        filter.taskId ? eq(fallbackEvents.taskId, filter.taskId) : undefined,
      ),
    )
    .orderBy(desc(fallbackEvents.createdAt), desc(fallbackEvents.id))
    .limit(limit);
}
