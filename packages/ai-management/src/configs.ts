import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import {
  agentModelAllowlist,
  agentModelConfigHistory,
  agentModelConfigs,
  agentModelFallbacks,
  aiModelCapabilities,
  aiModels,
  aiProviders,
  costRecords,
  type Db,
  type ModelLimits,
  type ModelParams,
  modelInvocations,
  type RoutingPolicy,
  tokenUsage,
} from '@platform/db';
import { authorize } from '@platform/iam';
import { audit, emitEvent } from '@platform/observability';
import {
  type Actor,
  actorId,
  ForbiddenError,
  NotFoundError,
  UnprocessableError,
  ValidationError,
} from '@platform/shared';
import {
  type CapabilitySupport,
  type ChatMessage,
  type InvocationResponse,
  type ModelCapabilityKey,
  type ProviderAdapterRegistry,
  ProviderAdapterError,
  type ToolDefinition,
} from './adapters/index.js';
import { computeEstimatedCost } from './models.js';
import { requireWorkspaceId, resolveProviderConnectionContext } from './providers.js';
import type { SecretStore } from './secret-store.js';

export type ConfigScope = 'global' | 'project' | 'workflow' | 'agent' | 'task';
export type RoutingMode = 'fixed' | 'adaptive' | 'hybrid';

export interface AgentModelConfigView {
  id: string;
  workspaceId: string;
  scope: ConfigScope;
  scopeRefId: string | null;
  agentKey: string | null;
  scopeKey: string;
  mode: RoutingMode;
  primaryModelId: string | null;
  allowlistModelIds: string[];
  fallbackModelIds: string[];
  params: ModelParams;
  limits: ModelLimits;
  routingPolicy: RoutingPolicy;
  configVersion: number;
  active: boolean;
  createdAt: Date;
  updatedAt: Date;
  version: number;
}

export function computeScopeKey(
  scope: ConfigScope,
  scopeRefId?: string | null,
  agentKey?: string | null,
): { scopeRefId: string | null; agentKey: string | null; scopeKey: string } {
  const cleanAgent = agentKey?.trim().toLowerCase() || null;
  const cleanRef = scopeRefId?.trim() || null;

  switch (scope) {
    case 'global':
      if (cleanRef || cleanAgent) {
        throw new ValidationError('global scope must not specify scopeRefId or agentKey');
      }
      return { scopeRefId: null, agentKey: null, scopeKey: '__global__' };
    case 'agent':
      if (!cleanAgent) {
        throw new ValidationError('agent scope requires agentKey');
      }
      if (cleanRef) {
        throw new ValidationError('agent scope must not specify scopeRefId');
      }
      return { scopeRefId: null, agentKey: cleanAgent, scopeKey: cleanAgent };
    case 'project':
    case 'workflow':
    case 'task':
      if (!cleanRef) {
        throw new ValidationError(`${scope} scope requires scopeRefId`);
      }
      return {
        scopeRefId: cleanRef,
        agentKey: cleanAgent,
        scopeKey: `${cleanRef}:${cleanAgent ?? '*'}`,
      };
  }
}

async function buildConfigViews(
  db: Db,
  rows: Array<typeof agentModelConfigs.$inferSelect>,
): Promise<AgentModelConfigView[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const allowRows = await db
    .select()
    .from(agentModelAllowlist)
    .where(inArray(agentModelAllowlist.configId, ids));
  const fallbackRows = await db
    .select()
    .from(agentModelFallbacks)
    .where(inArray(agentModelFallbacks.configId, ids))
    .orderBy(agentModelFallbacks.position);

  const allowByConfig = new Map<string, string[]>();
  const fallbackByConfig = new Map<string, string[]>();
  for (const id of ids) {
    allowByConfig.set(id, []);
    fallbackByConfig.set(id, []);
  }
  for (const a of allowRows) {
    allowByConfig.get(a.configId)?.push(a.modelId);
  }
  for (const f of fallbackRows) {
    fallbackByConfig.get(f.configId)?.push(f.modelId);
  }

  return rows.map((r) => ({
    id: r.id,
    workspaceId: r.workspaceId,
    scope: r.scope,
    scopeRefId: r.scopeRefId,
    agentKey: r.agentKey,
    scopeKey: r.scopeKey,
    mode: r.mode,
    primaryModelId: r.primaryModelId,
    allowlistModelIds: allowByConfig.get(r.id) ?? [],
    fallbackModelIds: fallbackByConfig.get(r.id) ?? [],
    params: r.params,
    limits: r.limits,
    routingPolicy: r.routingPolicy,
    configVersion: r.configVersion,
    active: r.active,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    version: r.version,
  }));
}

export interface UpsertAgentModelConfigInput {
  scope: ConfigScope;
  scopeRefId?: string | null;
  agentKey?: string | null;
  mode: RoutingMode;
  primaryModelId?: string | null;
  allowlistModelIds?: string[];
  fallbackModelIds?: string[];
  params?: ModelParams;
  limits?: ModelLimits;
  routingPolicy?: RoutingPolicy;
  active?: boolean;
}

async function validateReferencedModels(
  db: Db,
  workspaceId: string,
  modelIds: string[],
  params: ModelParams,
): Promise<void> {
  const uniqueIds = [...new Set(modelIds)];
  if (uniqueIds.length === 0) return;

  const found = await db
    .select({
      id: aiModels.id,
      modelKey: aiModels.modelKey,
      availability: aiModels.availability,
    })
    .from(aiModels)
    .innerJoin(aiProviders, eq(aiModels.providerId, aiProviders.id))
    .where(and(eq(aiProviders.workspaceId, workspaceId), inArray(aiModels.id, uniqueIds)));

  if (found.length !== uniqueIds.length) {
    const foundSet = new Set(found.map((m) => m.id));
    const missing = uniqueIds.find((id) => !foundSet.has(id))!;
    throw new NotFoundError('AIModel', missing);
  }

  const caps = await db
    .select()
    .from(aiModelCapabilities)
    .where(inArray(aiModelCapabilities.modelId, uniqueIds));
  const capMap = new Map<string, Partial<Record<ModelCapabilityKey, CapabilitySupport>>>();
  for (const c of caps) {
    const entry = capMap.get(c.modelId) ?? {};
    entry[c.capability] = c.support;
    capMap.set(c.modelId, entry);
  }

  for (const m of found) {
    const mc = capMap.get(m.id) ?? {};
    if (params.toolCalling === true && mc.tool_calling === 'no') {
      throw new UnprocessableError(
        `Model '${m.modelKey}' explicitly does not support tool_calling required by configuration`,
        'capability_mismatch',
        { reason: 'capability_mismatch', modelId: m.id, capability: 'tool_calling' },
      );
    }
    if (params.reasoningEffort !== undefined && mc.reasoning === 'no') {
      throw new UnprocessableError(
        `Model '${m.modelKey}' explicitly does not support reasoning required by configuration`,
        'capability_mismatch',
        { reason: 'capability_mismatch', modelId: m.id, capability: 'reasoning' },
      );
    }
    if (params.streaming === true && mc.streaming === 'no') {
      throw new UnprocessableError(
        `Model '${m.modelKey}' explicitly does not support streaming required by configuration`,
        'capability_mismatch',
        { reason: 'capability_mismatch', modelId: m.id, capability: 'streaming' },
      );
    }
  }
}

export async function upsertAgentModelConfig(
  db: Db,
  actor: Actor,
  input: UpsertAgentModelConfigInput,
): Promise<AgentModelConfigView> {
  const workspaceId = requireWorkspaceId(actor);
  const { scopeRefId, agentKey, scopeKey } = computeScopeKey(
    input.scope,
    input.scopeRefId,
    input.agentKey,
  );
  const authScope = input.scope === 'project' && scopeRefId ? { projectId: scopeRefId } : {};
  const { role } = await authorize(db, actor, 'ai.config.manage', authScope);
  if (
    (input.scope === 'global' || input.scope === 'agent') &&
    role !== 'owner' &&
    role !== 'administrator' &&
    role !== 'system'
  ) {
    throw new ForbiddenError(`Scope '${input.scope}' can only be modified by workspace administrators`);
  }

  if (input.mode === 'fixed' && !input.primaryModelId) {
    throw new ValidationError('fixed routing mode requires primaryModelId');
  }
  const allowlist = [...new Set(input.allowlistModelIds ?? [])];
  const fallbacks = [...new Set(input.fallbackModelIds ?? [])];
  if ((input.mode === 'adaptive' || input.mode === 'hybrid') && !input.primaryModelId && allowlist.length === 0) {
    throw new ValidationError(`${input.mode} routing mode requires primaryModelId or non-empty allowlistModelIds`);
  }

  const params = input.params ?? {};
  const limits = input.limits ?? {};
  const routingPolicy = input.routingPolicy ?? {};

  const allModelIds = [
    ...(input.primaryModelId ? [input.primaryModelId] : []),
    ...allowlist,
    ...fallbacks,
  ];
  await validateReferencedModels(db, workspaceId, allModelIds, params);

  return db.transaction(async (tx) => {
    const [existing] = await tx
      .select()
      .from(agentModelConfigs)
      .where(
        and(
          eq(agentModelConfigs.workspaceId, workspaceId),
          eq(agentModelConfigs.scope, input.scope),
          eq(agentModelConfigs.scopeKey, scopeKey),
        ),
      )
      .limit(1);

    const nextConfigVersion = existing ? existing.configVersion + 1 : 1;
    let configRow: typeof agentModelConfigs.$inferSelect;

    if (existing) {
      const [updated] = await tx
        .update(agentModelConfigs)
        .set({
          mode: input.mode,
          primaryModelId: input.primaryModelId ?? null,
          params,
          limits,
          routingPolicy,
          configVersion: nextConfigVersion,
          active: input.active ?? true,
          updatedAt: new Date(),
          version: existing.version + 1,
        })
        .where(eq(agentModelConfigs.id, existing.id))
        .returning();
      configRow = updated!;
      await tx.delete(agentModelAllowlist).where(eq(agentModelAllowlist.configId, existing.id));
      await tx.delete(agentModelFallbacks).where(eq(agentModelFallbacks.configId, existing.id));
    } else {
      const [created] = await tx
        .insert(agentModelConfigs)
        .values({
          workspaceId,
          scope: input.scope,
          scopeRefId,
          agentKey,
          scopeKey,
          mode: input.mode,
          primaryModelId: input.primaryModelId ?? null,
          params,
          limits,
          routingPolicy,
          configVersion: 1,
          active: input.active ?? true,
        })
        .returning();
      configRow = created!;
    }

    if (allowlist.length > 0) {
      await tx.insert(agentModelAllowlist).values(
        allowlist.map((modelId) => ({
          configId: configRow.id,
          modelId,
        })),
      );
    }
    if (fallbacks.length > 0) {
      await tx.insert(agentModelFallbacks).values(
        fallbacks.map((modelId, idx) => ({
          configId: configRow.id,
          position: idx,
          modelId,
        })),
      );
    }

    const snapshot = {
      scope: configRow.scope,
      scopeRefId: configRow.scopeRefId,
      agentKey: configRow.agentKey,
      mode: configRow.mode,
      primaryModelId: configRow.primaryModelId,
      allowlistModelIds: allowlist,
      fallbackModelIds: fallbacks,
      params,
      limits,
      routingPolicy,
      active: configRow.active,
    };

    await tx.insert(agentModelConfigHistory).values({
      configId: configRow.id,
      configVersion: nextConfigVersion,
      snapshot,
      changedByType: actor.type,
      changedById: actorId(actor),
    });

    await audit(tx, actor, {
      action: existing ? 'ai.config.updated' : 'ai.config.created',
      targetType: 'agent_model_config',
      targetId: configRow.id,
      payload: {
        before: existing
          ? {
              mode: existing.mode,
              primaryModelId: existing.primaryModelId,
              configVersion: existing.configVersion,
            }
          : null,
        after: {
          scope: configRow.scope,
          scopeKey: configRow.scopeKey,
          mode: configRow.mode,
          primaryModelId: configRow.primaryModelId,
          configVersion: configRow.configVersion,
        },
      },
    });
    await emitEvent(tx, {
      type: 'ai.config.updated',
      aggregateType: 'agent_model_config',
      aggregateId: configRow.id,
      workspaceId,
      payload: {
        configId: configRow.id,
        scope: configRow.scope,
        scopeKey: configRow.scopeKey,
        configVersion: configRow.configVersion,
      },
    });

    const [view] = await buildConfigViews(tx, [configRow]);
    return view!;
  });
}

export async function listAgentModelConfigs(
  db: Db,
  actor: Actor,
  filter: { scope?: ConfigScope; scopeRefId?: string; agentKey?: string } = {},
): Promise<AgentModelConfigView[]> {
  await authorize(db, actor, 'ai.config.read');
  const workspaceId = requireWorkspaceId(actor);
  const rows = await db
    .select()
    .from(agentModelConfigs)
    .where(
      and(
        eq(agentModelConfigs.workspaceId, workspaceId),
        filter.scope ? eq(agentModelConfigs.scope, filter.scope) : undefined,
        filter.scopeRefId ? eq(agentModelConfigs.scopeRefId, filter.scopeRefId) : undefined,
        filter.agentKey ? eq(agentModelConfigs.agentKey, filter.agentKey.toLowerCase()) : undefined,
      ),
    )
    .orderBy(agentModelConfigs.scope, agentModelConfigs.scopeKey);
  return buildConfigViews(db, rows);
}

export async function getAgentModelConfigHistory(
  db: Db,
  actor: Actor,
  configId: string,
): Promise<Array<typeof agentModelConfigHistory.$inferSelect>> {
  await authorize(db, actor, 'ai.config.read');
  const workspaceId = requireWorkspaceId(actor);
  const [cfg] = await db
    .select({ id: agentModelConfigs.id })
    .from(agentModelConfigs)
    .where(and(eq(agentModelConfigs.id, configId), eq(agentModelConfigs.workspaceId, workspaceId)))
    .limit(1);
  if (!cfg) throw new NotFoundError('AgentModelConfig', configId);

  return db
    .select()
    .from(agentModelConfigHistory)
    .where(eq(agentModelConfigHistory.configId, configId))
    .orderBy(desc(agentModelConfigHistory.configVersion));
}

export interface ResolutionQuery {
  workspaceId: string;
  agentKey: string;
  projectId?: string;
  workflowId?: string;
  taskId?: string;
}

export interface ResolvedAgentModelConfig {
  config: AgentModelConfigView;
  selectedModelId: string;
  precedenceChain: Array<{ scope: ConfigScope; scopeKey: string; matched: boolean; configId?: string }>;
}

/**
 * Resolves the effective model configuration for an agent using the 5-level precedence hierarchy
 * (Blueprint §4.3): `Task > Workflow > Project > Agent > Global`.
 */
export async function resolveEffectiveModelConfig(
  db: Db,
  query: ResolutionQuery,
): Promise<ResolvedAgentModelConfig> {
  const cleanAgent = query.agentKey.trim().toLowerCase();
  const candidates: Array<{ scope: ConfigScope; scopeKey: string }> = [];

  if (query.taskId) {
    candidates.push({ scope: 'task', scopeKey: `${query.taskId}:${cleanAgent}` });
    candidates.push({ scope: 'task', scopeKey: `${query.taskId}:*` });
  }
  if (query.workflowId) {
    candidates.push({ scope: 'workflow', scopeKey: `${query.workflowId}:${cleanAgent}` });
    candidates.push({ scope: 'workflow', scopeKey: `${query.workflowId}:*` });
  }
  if (query.projectId) {
    candidates.push({ scope: 'project', scopeKey: `${query.projectId}:${cleanAgent}` });
    candidates.push({ scope: 'project', scopeKey: `${query.projectId}:*` });
  }
  candidates.push({ scope: 'agent', scopeKey: cleanAgent });
  candidates.push({ scope: 'global', scopeKey: '__global__' });

  const allConfigs = await db
    .select()
    .from(agentModelConfigs)
    .where(and(eq(agentModelConfigs.workspaceId, query.workspaceId), eq(agentModelConfigs.active, true)));
  const views = await buildConfigViews(db, allConfigs);
  const byScopeAndKey = new Map<string, AgentModelConfigView>();
  for (const v of views) {
    byScopeAndKey.set(`${v.scope}::${v.scopeKey}`, v);
  }

  let winner: AgentModelConfigView | null = null;
  const precedenceChain = candidates.map((c) => {
    const found = byScopeAndKey.get(`${c.scope}::${c.scopeKey}`);
    const matched = Boolean(found) && winner === null;
    if (matched && found) {
      winner = found;
    }
    return {
      scope: c.scope,
      scopeKey: c.scopeKey,
      matched: Boolean(found),
      ...(found ? { configId: found.id } : {}),
    };
  });

  if (!winner) {
    throw new UnprocessableError(
      `No active model configuration found for agent '${cleanAgent}' in workspace`,
      'model_config_not_found',
      { reason: 'model_config_not_found', agentKey: cleanAgent },
    );
  }

  const resolvedConfig = winner as AgentModelConfigView;
  const selectedModelId =
    resolvedConfig.primaryModelId ??
    resolvedConfig.allowlistModelIds[0] ??
    resolvedConfig.fallbackModelIds[0] ??
    null;

  if (!selectedModelId) {
    throw new UnprocessableError(
      `Configuration '${resolvedConfig.id}' has no primary or allowed model assigned`,
      'no_model_assigned',
      { reason: 'no_model_assigned', configId: resolvedConfig.id },
    );
  }

  return {
    config: resolvedConfig,
    selectedModelId,
    precedenceChain,
  };
}

export interface AgentInvocationInput {
  agentKey: string;
  agentVersion?: number;
  projectId?: string;
  workflowId?: string;
  taskId?: string;
  systemInstruction?: string;
  untrustedContext?: string;
  messages: ChatMessage[];
  tools?: ToolDefinition[];
  jsonSchema?: { name: string; schema: Record<string, unknown> };
  temperature?: number;
  maxOutputTokens?: number;
  reasoningEffort?: 'low' | 'medium' | 'high';
}

export interface AgentInvocationResult {
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
}

/**
 * Dynamically resolves the agent's model configuration at runtime and dispatches the invocation
 * through the assigned provider adapter, recording immutable telemetry (`model_invocations`,
 * `token_usage`, `cost_records`).
 *
 * Agents never hard-code a provider or model (Blueprint §1, §4, Phase 3 Gate).
 */
export async function invokeForAgent(
  db: Db,
  secretStore: SecretStore,
  registry: ProviderAdapterRegistry,
  actor: Actor,
  input: AgentInvocationInput,
): Promise<AgentInvocationResult> {
  const workspaceId = requireWorkspaceId(actor);
  const resolution = await resolveEffectiveModelConfig(db, {
    workspaceId,
    agentKey: input.agentKey,
    ...(input.projectId ? { projectId: input.projectId } : {}),
    ...(input.workflowId ? { workflowId: input.workflowId } : {}),
    ...(input.taskId ? { taskId: input.taskId } : {}),
  });

  const [modelRow] = await db
    .select()
    .from(aiModels)
    .where(eq(aiModels.id, resolution.selectedModelId))
    .limit(1);
  if (!modelRow) throw new NotFoundError('AIModel', resolution.selectedModelId);

  const capRows = await db
    .select()
    .from(aiModelCapabilities)
    .where(eq(aiModelCapabilities.modelId, modelRow.id));
  const knownCapabilities: Partial<Record<ModelCapabilityKey, CapabilitySupport>> = {};
  for (const c of capRows) {
    knownCapabilities[c.capability] = c.support;
  }

  const timeoutMs =
    resolution.config.limits.timeoutSeconds !== undefined
      ? resolution.config.limits.timeoutSeconds * 1000
      : 60_000;
  const { provider, ctx } = await resolveProviderConnectionContext(
    db,
    secretStore,
    workspaceId,
    modelRow.providerId,
    { requireEnabled: true, timeoutMs },
  );

  const adapter = registry.get(provider.adapterType);
  const cfgParams = resolution.config.params;

  const routingExplanation = {
    mode: resolution.config.mode,
    resolvedScope: resolution.config.scope,
    resolvedScopeKey: resolution.config.scopeKey,
    configId: resolution.config.id,
    configVersion: resolution.config.configVersion,
    selectedProviderKey: provider.providerKey,
    selectedModelKey: modelRow.modelKey,
    precedenceChain: resolution.precedenceChain,
  };

  const started = Date.now();
  try {
    const temperature = input.temperature ?? cfgParams.temperature;
    const maxOutputTokens = input.maxOutputTokens ?? cfgParams.maxOutputTokens;
    const reasoningEffort = input.reasoningEffort ?? cfgParams.reasoningEffort;

    const response = await adapter.invoke(ctx, {
      modelKey: modelRow.modelKey,
      ...(input.systemInstruction !== undefined ? { systemInstruction: input.systemInstruction } : {}),
      ...(input.untrustedContext !== undefined ? { untrustedContext: input.untrustedContext } : {}),
      messages: input.messages,
      ...(input.tools !== undefined ? { tools: input.tools } : {}),
      ...(input.jsonSchema !== undefined ? { jsonSchema: input.jsonSchema } : {}),
      ...(temperature !== undefined ? { temperature } : {}),
      ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
      ...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
      knownCapabilities,
    });

    const cost = await computeEstimatedCost(db, modelRow.id, response.usage);
    const invRow = await db.transaction(async (tx) => {
      const [inv] = await tx
        .insert(modelInvocations)
        .values({
          workspaceId,
          purpose: 'agent',
          providerId: provider.id,
          modelId: modelRow.id,
          agentKey: input.agentKey.toLowerCase(),
          agentVersion: input.agentVersion ?? 1,
          projectId: input.projectId ?? null,
          workflowId: input.workflowId ?? null,
          taskId: input.taskId ?? null,
          configId: resolution.config.id,
          configVersion: resolution.config.configVersion,
          providerRequestId: response.providerRequestId,
          status: 'succeeded',
          durationMs: response.rawLatencyMs,
          routingExplanation,
          actorType: actor.type,
          actorId: actorId(actor),
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

      return inv!;
    });

    return {
      invocationId: invRow.id,
      providerId: provider.id,
      providerKey: provider.providerKey,
      modelId: modelRow.id,
      modelKey: modelRow.modelKey,
      configId: resolution.config.id,
      configVersion: resolution.config.configVersion,
      response,
      estimatedCost: cost.estimatedCost,
      currency: cost.currency,
    };
  } catch (err) {
    const durationMs = Math.max(1, Date.now() - started);
    const errorKind = err instanceof ProviderAdapterError ? err.kind : 'unknown_error';
    await db.insert(modelInvocations).values({
      workspaceId,
      purpose: 'agent',
      providerId: provider.id,
      modelId: modelRow.id,
      agentKey: input.agentKey.toLowerCase(),
      agentVersion: input.agentVersion ?? 1,
      projectId: input.projectId ?? null,
      workflowId: input.workflowId ?? null,
      taskId: input.taskId ?? null,
      configId: resolution.config.id,
      configVersion: resolution.config.configVersion,
      status: 'failed',
      errorKind,
      durationMs,
      routingExplanation,
      actorType: actor.type,
      actorId: actorId(actor),
    });
    throw err;
  }
}

export interface ModelUsageEntry {
  invocationId: string;
  purpose: 'agent' | 'playground' | 'probe';
  providerId: string;
  providerKey: string;
  modelId: string;
  modelKey: string;
  agentKey: string | null;
  projectId: string | null;
  taskId: string | null;
  configId: string | null;
  configVersion: number | null;
  status: 'succeeded' | 'failed';
  errorKind: string | null;
  durationMs: number;
  inputTokens: number | null;
  outputTokens: number | null;
  cachedTokens: number | null;
  reasoningTokens: number | null;
  estimatedCost: string | null;
  actualCost: string | null;
  currency: string | null;
  createdAt: Date;
}

export async function listModelUsage(
  db: Db,
  actor: Actor,
  filter: { projectId?: string; agentKey?: string; modelId?: string; limit?: number } = {},
): Promise<ModelUsageEntry[]> {
  await authorize(db, actor, 'ai.config.read');
  const workspaceId = requireWorkspaceId(actor);
  const limit = Math.min(Math.max(1, filter.limit ?? 50), 200);

  const rows = await db
    .select({
      inv: modelInvocations,
      providerKey: aiProviders.providerKey,
      modelKey: aiModels.modelKey,
      tok: tokenUsage,
      cost: costRecords,
    })
    .from(modelInvocations)
    .innerJoin(aiProviders, eq(modelInvocations.providerId, aiProviders.id))
    .innerJoin(aiModels, eq(modelInvocations.modelId, aiModels.id))
    .leftJoin(tokenUsage, eq(tokenUsage.invocationId, modelInvocations.id))
    .leftJoin(costRecords, eq(costRecords.invocationId, modelInvocations.id))
    .where(
      and(
        eq(modelInvocations.workspaceId, workspaceId),
        filter.projectId ? eq(modelInvocations.projectId, filter.projectId) : undefined,
        filter.agentKey ? eq(modelInvocations.agentKey, filter.agentKey.toLowerCase()) : undefined,
        filter.modelId ? eq(modelInvocations.modelId, filter.modelId) : undefined,
      ),
    )
    .orderBy(desc(modelInvocations.createdAt))
    .limit(limit);

  return rows.map((r) => ({
    invocationId: r.inv.id,
    purpose: r.inv.purpose,
    providerId: r.inv.providerId,
    providerKey: r.providerKey,
    modelId: r.inv.modelId,
    modelKey: r.modelKey,
    agentKey: r.inv.agentKey,
    projectId: r.inv.projectId,
    taskId: r.inv.taskId,
    configId: r.inv.configId,
    configVersion: r.inv.configVersion,
    status: r.inv.status,
    errorKind: r.inv.errorKind,
    durationMs: r.inv.durationMs,
    inputTokens: r.tok?.inputTokens ?? null,
    outputTokens: r.tok?.outputTokens ?? null,
    cachedTokens: r.tok?.cachedTokens ?? null,
    reasoningTokens: r.tok?.reasoningTokens ?? null,
    estimatedCost: r.cost?.estimatedCost ?? null,
    actualCost: r.cost?.actualCost ?? null,
    currency: r.cost?.currency ?? null,
    createdAt: r.inv.createdAt,
  }));
}

export interface CostSummary {
  totalInvocations: number;
  succeededInvocations: number;
  failedInvocations: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalEstimatedCostUsd: string;
  byAgent: Array<{
    agentKey: string;
    invocations: number;
    inputTokens: number;
    outputTokens: number;
    estimatedCostUsd: string;
  }>;
  byModel: Array<{
    modelId: string;
    modelKey: string;
    invocations: number;
    inputTokens: number;
    outputTokens: number;
    estimatedCostUsd: string;
  }>;
}

export async function getCostSummary(
  db: Db,
  actor: Actor,
  filter: { projectId?: string } = {},
): Promise<CostSummary> {
  await authorize(db, actor, 'ai.config.read');
  const workspaceId = requireWorkspaceId(actor);
  const rows = await db
    .select({
      inv: modelInvocations,
      modelKey: aiModels.modelKey,
      tok: tokenUsage,
      cost: costRecords,
    })
    .from(modelInvocations)
    .innerJoin(aiModels, eq(modelInvocations.modelId, aiModels.id))
    .leftJoin(tokenUsage, eq(tokenUsage.invocationId, modelInvocations.id))
    .leftJoin(costRecords, eq(costRecords.invocationId, modelInvocations.id))
    .where(
      and(
        eq(modelInvocations.workspaceId, workspaceId),
        filter.projectId ? eq(modelInvocations.projectId, filter.projectId) : undefined,
      ),
    );

  let succeededInvocations = 0;
  let failedInvocations = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalEstimatedCost = 0;

  const agentMap = new Map<
    string,
    { invocations: number; inputTokens: number; outputTokens: number; cost: number }
  >();
  const modelMap = new Map<
    string,
    { modelKey: string; invocations: number; inputTokens: number; outputTokens: number; cost: number }
  >();

  for (const r of rows) {
    if (r.inv.status === 'succeeded') succeededInvocations++;
    else failedInvocations++;

    const inTok = r.tok?.inputTokens ?? 0;
    const outTok = (r.tok?.outputTokens ?? 0) + (r.tok?.reasoningTokens ?? 0);
    const est = r.cost?.estimatedCost ? Number(r.cost.estimatedCost) : 0;

    totalInputTokens += inTok;
    totalOutputTokens += outTok;
    totalEstimatedCost += est;

    const ak = r.inv.agentKey ?? '__unassigned__';
    const ag = agentMap.get(ak) ?? { invocations: 0, inputTokens: 0, outputTokens: 0, cost: 0 };
    ag.invocations++;
    ag.inputTokens += inTok;
    ag.outputTokens += outTok;
    ag.cost += est;
    agentMap.set(ak, ag);

    const mg = modelMap.get(r.inv.modelId) ?? {
      modelKey: r.modelKey,
      invocations: 0,
      inputTokens: 0,
      outputTokens: 0,
      cost: 0,
    };
    mg.invocations++;
    mg.inputTokens += inTok;
    mg.outputTokens += outTok;
    mg.cost += est;
    modelMap.set(r.inv.modelId, mg);
  }

  return {
    totalInvocations: rows.length,
    succeededInvocations,
    failedInvocations,
    totalInputTokens,
    totalOutputTokens,
    totalEstimatedCostUsd: totalEstimatedCost.toFixed(6),
    byAgent: [...agentMap.entries()].map(([agentKey, v]) => ({
      agentKey,
      invocations: v.invocations,
      inputTokens: v.inputTokens,
      outputTokens: v.outputTokens,
      estimatedCostUsd: v.cost.toFixed(6),
    })),
    byModel: [...modelMap.entries()].map(([modelId, v]) => ({
      modelId,
      modelKey: v.modelKey,
      invocations: v.invocations,
      inputTokens: v.inputTokens,
      outputTokens: v.outputTokens,
      estimatedCostUsd: v.cost.toFixed(6),
    })),
  };
}

export { sql };
