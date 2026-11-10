import { and, desc, eq, inArray, lte } from 'drizzle-orm';
import {
  aiModelCapabilities,
  aiModelPricing,
  aiModels,
  costRecords,
  type Db,
  type ModelParams,
  modelInvocations,
  playgroundBenchmarks,
  playgroundRuns,
  tokenUsage,
} from '@platform/db';
import { authorize } from '@platform/iam';
import { audit } from '@platform/observability';
import {
  type Actor,
  ForbiddenError,
  NotFoundError,
  UnprocessableError,
  uuidv7,
  ValidationError,
} from '@platform/shared';
import {
  type CapabilitySupport,
  type ModelCapabilityKey,
  type ProviderAdapterRegistry,
  ProviderAdapterError,
} from './adapters/index.js';
import { computeEstimatedCost } from './models.js';
import { requireWorkspaceId, resolveProviderConnectionContext } from './providers.js';
import type { SecretStore } from './secret-store.js';

export const PLAYGROUND_MAX_OUTPUT_TOKENS = 8_192;
export const PLAYGROUND_DEFAULT_OUTPUT_TOKENS = 1_024;
export const PLAYGROUND_MAX_MODELS_PER_COMPARE = 5;
export const PLAYGROUND_COST_WARNING_USD = 0.05;
export const PLAYGROUND_HARD_COST_CAP_USD = 0.5;

export interface PlaygroundRunInput {
  modelId: string;
  simulatedRole?: string;
  systemPrompt?: string;
  userPrompt: string;
  params?: ModelParams;
  maxEstimatedCostUsd?: number;
  acknowledgeCostWarning?: boolean;
  comparisonId?: string;
}

export interface PlaygroundRunResult {
  run: typeof playgroundRuns.$inferSelect;
  providerKey: string;
  modelKey: string;
  durationMs: number;
  usage: {
    inputTokens: number | null;
    outputTokens: number | null;
    cachedTokens: number | null;
    reasoningTokens: number | null;
  };
  estimatedCost: string | null;
  currency: string | null;
  preflightEstimatedCostUsd: string | null;
  costWarningTriggered: boolean;
}

function estimatePromptTokens(text: string): number {
  return Math.max(1, Math.ceil(Buffer.byteLength(text, 'utf8') / 4));
}

async function estimatePreflightModelCostUsd(
  db: Db,
  modelId: string,
  inputTokens: number,
  maxOutputTokens: number,
): Promise<number | null> {
  const [pricing] = await db
    .select()
    .from(aiModelPricing)
    .where(and(eq(aiModelPricing.modelId, modelId), lte(aiModelPricing.effectiveFrom, new Date())))
    .orderBy(desc(aiModelPricing.effectiveFrom), desc(aiModelPricing.createdAt))
    .limit(1);
  if (!pricing) return null;
  const inRate = Number(pricing.inputPerMtok);
  const outRate = Number(pricing.outputPerMtok);
  return (inputTokens * inRate + maxOutputTokens * outRate) / 1_000_000;
}

function requireUserActor(actor: Actor): { userId: string; workspaceId: string } {
  if (actor.type !== 'user') {
    throw new ForbiddenError('AI Playground requires an authenticated human user');
  }
  return { userId: actor.userId, workspaceId: actor.workspaceId };
}

/**
 * Executes a single isolated AI Playground run (Blueprint §4.7, P3-10).
 * Enforces output token ceiling, pre-flight cost cap, and cost warning acknowledgement,
 * and never mutates live `agent_model_configs`.
 */
export async function runPlayground(
  db: Db,
  secretStore: SecretStore,
  registry: ProviderAdapterRegistry,
  actor: Actor,
  input: PlaygroundRunInput,
): Promise<PlaygroundRunResult> {
  await authorize(db, actor, 'ai.playground.run');
  const { userId, workspaceId } = requireUserActor(actor);

  const userPrompt = input.userPrompt.trim();
  if (!userPrompt) throw new ValidationError('userPrompt is required');
  const systemPrompt = (input.systemPrompt ?? '').trim();

  const maxOutputTokens = input.params?.maxOutputTokens ?? PLAYGROUND_DEFAULT_OUTPUT_TOKENS;
  if (maxOutputTokens < 1 || maxOutputTokens > PLAYGROUND_MAX_OUTPUT_TOKENS) {
    throw new ValidationError(
      `Playground maxOutputTokens must be between 1 and ${PLAYGROUND_MAX_OUTPUT_TOKENS}`,
    );
  }

  const [modelRow] = await db.select().from(aiModels).where(eq(aiModels.id, input.modelId)).limit(1);
  if (!modelRow) throw new NotFoundError('AIModel', input.modelId);

  const { provider, ctx } = await resolveProviderConnectionContext(
    db,
    secretStore,
    workspaceId,
    modelRow.providerId,
    { requireEnabled: true },
  );

  const approxInputTokens = estimatePromptTokens(`${systemPrompt}\n${userPrompt}`);
  const preflightUsd = await estimatePreflightModelCostUsd(
    db,
    modelRow.id,
    approxInputTokens,
    maxOutputTokens,
  );
  const hardCap = input.maxEstimatedCostUsd ?? PLAYGROUND_HARD_COST_CAP_USD;
  if (preflightUsd !== null && preflightUsd > hardCap) {
    throw new UnprocessableError(
      `Playground run estimated cost ($${preflightUsd.toFixed(6)}) exceeds hard cap ($${hardCap.toFixed(6)})`,
      'playground_cost_cap_exceeded',
      {
        reason: 'playground_cost_cap_exceeded',
        preflightEstimatedCostUsd: preflightUsd.toFixed(6),
        hardCapUsd: hardCap.toFixed(6),
      },
    );
  }
  const costWarningTriggered = preflightUsd !== null && preflightUsd >= PLAYGROUND_COST_WARNING_USD;
  if (costWarningTriggered && !input.acknowledgeCostWarning) {
    throw new UnprocessableError(
      `Playground run estimated cost ($${preflightUsd.toFixed(6)}) requires explicit cost warning acknowledgement`,
      'playground_cost_warning_required',
      {
        reason: 'playground_cost_warning_required',
        preflightEstimatedCostUsd: preflightUsd.toFixed(6),
        warningThresholdUsd: PLAYGROUND_COST_WARNING_USD.toFixed(6),
      },
    );
  }

  const capRows = await db
    .select()
    .from(aiModelCapabilities)
    .where(eq(aiModelCapabilities.modelId, modelRow.id));
  const knownCapabilities: Partial<Record<ModelCapabilityKey, CapabilitySupport>> = {};
  for (const c of capRows) {
    knownCapabilities[c.capability] = c.support;
  }

  const adapter = registry.get(provider.adapterType);
  const started = Date.now();

  try {
    const resp = await adapter.invoke(ctx, {
      modelKey: modelRow.modelKey,
      ...(systemPrompt ? { systemInstruction: systemPrompt } : {}),
      messages: [{ role: 'user', content: userPrompt }],
      ...(input.params?.temperature !== undefined ? { temperature: input.params.temperature } : {}),
      maxOutputTokens,
      ...(input.params?.reasoningEffort !== undefined
        ? { reasoningEffort: input.params.reasoningEffort }
        : {}),
      knownCapabilities,
    });

    const cost = await computeEstimatedCost(db, modelRow.id, resp.usage);
    const runRow = await db.transaction(async (tx) => {
      const [inv] = await tx
        .insert(modelInvocations)
        .values({
          workspaceId,
          purpose: 'playground',
          providerId: provider.id,
          modelId: modelRow.id,
          agentKey: input.simulatedRole ? input.simulatedRole.toLowerCase() : null,
          providerRequestId: resp.providerRequestId,
          status: 'succeeded',
          durationMs: resp.rawLatencyMs,
          routingExplanation: {
            isolatedPlayground: true,
            simulatedRole: input.simulatedRole ?? null,
          },
          actorType: 'user',
          actorId: userId,
        })
        .returning();

      await tx.insert(tokenUsage).values({
        invocationId: inv!.id,
        inputTokens: resp.usage.inputTokens,
        outputTokens: resp.usage.outputTokens,
        cachedTokens: resp.usage.cachedTokens,
        reasoningTokens: resp.usage.reasoningTokens,
      });

      await tx.insert(costRecords).values({
        invocationId: inv!.id,
        estimatedCost: cost.estimatedCost,
        actualCost: cost.actualCost,
        currency: cost.currency,
        pricingId: cost.pricingId,
        note: cost.note,
      });

      const [run] = await tx
        .insert(playgroundRuns)
        .values({
          workspaceId,
          userId,
          invocationId: inv!.id,
          comparisonId: input.comparisonId ?? null,
          modelId: modelRow.id,
          simulatedRole: input.simulatedRole ?? null,
          systemPrompt,
          userPrompt,
          params: { ...input.params, maxOutputTokens },
          output: resp.text,
          error: null,
        })
        .returning();

      return run!;
    });

    return {
      run: runRow,
      providerKey: provider.providerKey,
      modelKey: modelRow.modelKey,
      durationMs: resp.rawLatencyMs,
      usage: resp.usage,
      estimatedCost: cost.estimatedCost,
      currency: cost.currency,
      preflightEstimatedCostUsd: preflightUsd !== null ? preflightUsd.toFixed(6) : null,
      costWarningTriggered,
    };
  } catch (err) {
    const durationMs = Math.max(1, Date.now() - started);
    const errorKind = err instanceof ProviderAdapterError ? err.kind : 'unknown_error';
    const errorMsg = err instanceof Error ? err.message : String(err);

    await db.transaction(async (tx) => {
      const [inv] = await tx
        .insert(modelInvocations)
        .values({
          workspaceId,
          purpose: 'playground',
          providerId: provider.id,
          modelId: modelRow.id,
          agentKey: input.simulatedRole ? input.simulatedRole.toLowerCase() : null,
          status: 'failed',
          errorKind,
          durationMs,
          routingExplanation: { isolatedPlayground: true },
          actorType: 'user',
          actorId: userId,
        })
        .returning();

      await tx.insert(playgroundRuns).values({
        workspaceId,
        userId,
        invocationId: inv!.id,
        comparisonId: input.comparisonId ?? null,
        modelId: modelRow.id,
        simulatedRole: input.simulatedRole ?? null,
        systemPrompt,
        userPrompt,
        params: { ...input.params, maxOutputTokens },
        output: null,
        error: errorMsg,
      });
    });

    throw err;
  }
}

export interface PlaygroundCompareInput {
  modelIds: string[];
  simulatedRole?: string;
  systemPrompt?: string;
  userPrompt: string;
  params?: ModelParams;
  maxEstimatedCostUsd?: number;
  acknowledgeCostWarning?: boolean;
}

export interface PlaygroundCompareResult {
  comparisonId: string;
  results: PlaygroundRunResult[];
  totalEstimatedCostUsd: string;
}

/**
 * Runs side-by-side multi-model comparison in the AI Playground (Blueprint §4.7, P3-10).
 * Validates total aggregate pre-flight cost across all selected models before executing any request.
 */
export async function comparePlaygroundModels(
  db: Db,
  secretStore: SecretStore,
  registry: ProviderAdapterRegistry,
  actor: Actor,
  input: PlaygroundCompareInput,
): Promise<PlaygroundCompareResult> {
  await authorize(db, actor, 'ai.playground.run');
  requireUserActor(actor);

  const modelIds = [...new Set(input.modelIds)];
  if (modelIds.length < 2 || modelIds.length > PLAYGROUND_MAX_MODELS_PER_COMPARE) {
    throw new ValidationError(
      `Playground comparison requires between 2 and ${PLAYGROUND_MAX_MODELS_PER_COMPARE} distinct models`,
    );
  }

  const maxOutputTokens = input.params?.maxOutputTokens ?? PLAYGROUND_DEFAULT_OUTPUT_TOKENS;
  const approxInputTokens = estimatePromptTokens(`${input.systemPrompt ?? ''}\n${input.userPrompt}`);

  let aggregatePreflight = 0;
  let anyKnown = false;
  for (const modelId of modelIds) {
    const est = await estimatePreflightModelCostUsd(db, modelId, approxInputTokens, maxOutputTokens);
    if (est !== null) {
      aggregatePreflight += est;
      anyKnown = true;
    }
  }

  const hardCap = input.maxEstimatedCostUsd ?? PLAYGROUND_HARD_COST_CAP_USD;
  if (anyKnown && aggregatePreflight > hardCap) {
    throw new UnprocessableError(
      `Playground comparison estimated cost ($${aggregatePreflight.toFixed(6)}) exceeds hard cap ($${hardCap.toFixed(6)})`,
      'playground_cost_cap_exceeded',
      {
        reason: 'playground_cost_cap_exceeded',
        preflightEstimatedCostUsd: aggregatePreflight.toFixed(6),
        hardCapUsd: hardCap.toFixed(6),
      },
    );
  }
  if (anyKnown && aggregatePreflight >= PLAYGROUND_COST_WARNING_USD && !input.acknowledgeCostWarning) {
    throw new UnprocessableError(
      `Playground comparison estimated cost ($${aggregatePreflight.toFixed(6)}) requires explicit cost warning acknowledgement`,
      'playground_cost_warning_required',
      {
        reason: 'playground_cost_warning_required',
        preflightEstimatedCostUsd: aggregatePreflight.toFixed(6),
        warningThresholdUsd: PLAYGROUND_COST_WARNING_USD.toFixed(6),
      },
    );
  }

  const comparisonId = uuidv7();
  const results: PlaygroundRunResult[] = [];
  let totalCost = 0;

  for (const modelId of modelIds) {
    const res = await runPlayground(db, secretStore, registry, actor, {
      modelId,
      ...(input.simulatedRole !== undefined ? { simulatedRole: input.simulatedRole } : {}),
      ...(input.systemPrompt !== undefined ? { systemPrompt: input.systemPrompt } : {}),
      userPrompt: input.userPrompt,
      ...(input.params !== undefined ? { params: input.params } : {}),
      maxEstimatedCostUsd: hardCap,
      acknowledgeCostWarning: true,
      comparisonId,
    });
    results.push(res);
    if (res.estimatedCost) {
      totalCost += Number(res.estimatedCost);
    }
  }

  return {
    comparisonId,
    results,
    totalEstimatedCostUsd: totalCost.toFixed(6),
  };
}

export async function savePlaygroundBenchmark(
  db: Db,
  actor: Actor,
  input: { name: string; runIds: string[]; notes?: string },
): Promise<typeof playgroundBenchmarks.$inferSelect> {
  await authorize(db, actor, 'ai.playground.run');
  const { userId, workspaceId } = requireUserActor(actor);

  const name = input.name.trim();
  if (!name) throw new ValidationError('Benchmark name is required');
  const runIds = [...new Set(input.runIds)];
  if (runIds.length === 0) throw new ValidationError('runIds must not be empty');

  const foundRuns = await db
    .select({ id: playgroundRuns.id })
    .from(playgroundRuns)
    .where(and(eq(playgroundRuns.workspaceId, workspaceId), inArray(playgroundRuns.id, runIds)));
  if (foundRuns.length !== runIds.length) {
    throw new NotFoundError('PlaygroundRun', runIds.find((id) => !foundRuns.some((r) => r.id === id))!);
  }

  return db.transaction(async (tx) => {
    const [created] = await tx
      .insert(playgroundBenchmarks)
      .values({
        workspaceId,
        name,
        runIds,
        notes: input.notes ?? '',
        createdBy: userId,
      })
      .returning();

    await audit(tx, actor, {
      action: 'ai.playground.benchmark.saved',
      targetType: 'playground_benchmark',
      targetId: created!.id,
      payload: { name, runCount: runIds.length },
    });

    return created!;
  });
}

export async function listPlaygroundBenchmarks(
  db: Db,
  actor: Actor,
): Promise<Array<typeof playgroundBenchmarks.$inferSelect>> {
  await authorize(db, actor, 'ai.config.read');
  const workspaceId = requireWorkspaceId(actor);
  return db
    .select()
    .from(playgroundBenchmarks)
    .where(eq(playgroundBenchmarks.workspaceId, workspaceId))
    .orderBy(desc(playgroundBenchmarks.createdAt));
}
