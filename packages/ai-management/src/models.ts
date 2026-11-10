import { and, desc, eq, inArray, lte } from 'drizzle-orm';
import {
  aiModelCapabilities,
  aiModelPricing,
  aiModels,
  aiProviders,
  type Db,
  modelCapabilityValues,
} from '@platform/db';
import { authorize } from '@platform/iam';
import { audit, emitEvent } from '@platform/observability';
import {
  type Actor,
  actorId,
  ConflictError,
  NotFoundError,
  ValidationError,
  VersionConflictError,
} from '@platform/shared';
import type {
  CapabilitySupport,
  InvocationUsage,
  ModelCapabilityKey,
  ProviderAdapterRegistry,
} from './adapters/index.js';
import { requireWorkspaceId, resolveProviderConnectionContext } from './providers.js';
import type { SecretStore } from './secret-store.js';

export type ModelAvailability = 'available' | 'unavailable' | 'unknown' | 'deprecated';
export type QualityTier = 'economy' | 'standard' | 'high' | 'frontier' | 'unknown';

export interface ModelPricingView {
  id: string;
  inputPerMtok: string;
  outputPerMtok: string;
  cachedInputPerMtok: string | null;
  currency: string;
  effectiveFrom: Date;
  source: string;
  verified: boolean;
  createdBy: string;
  createdAt: Date;
}

export interface ModelView {
  id: string;
  providerId: string;
  providerKey: string;
  modelKey: string;
  displayName: string;
  availability: ModelAvailability;
  contextWindow: number | null;
  maxOutputTokens: number | null;
  qualityTier: QualityTier;
  metadataVerified: boolean;
  source: 'manual' | 'synced';
  notes: string;
  capabilities: Record<ModelCapabilityKey, CapabilitySupport>;
  activePricing: ModelPricingView | null;
  createdAt: Date;
  updatedAt: Date;
  version: number;
}

function defaultCapabilityMap(
  overrides?: Partial<Record<ModelCapabilityKey, CapabilitySupport>>,
): Record<ModelCapabilityKey, CapabilitySupport> {
  const map = {} as Record<ModelCapabilityKey, CapabilitySupport>;
  for (const key of modelCapabilityValues) {
    map[key] = overrides?.[key] ?? 'unknown';
  }
  return map;
}

export async function buildModelViews(
  db: Db,
  rows: Array<{
    model: typeof aiModels.$inferSelect;
    providerKey: string;
  }>,
): Promise<ModelView[]> {
  if (rows.length === 0) return [];
  const modelIds = rows.map((r) => r.model.id);
  const capRows = await db
    .select()
    .from(aiModelCapabilities)
    .where(inArray(aiModelCapabilities.modelId, modelIds));
  const pricingRows = await db
    .select()
    .from(aiModelPricing)
    .where(inArray(aiModelPricing.modelId, modelIds))
    .orderBy(desc(aiModelPricing.effectiveFrom), desc(aiModelPricing.createdAt));

  const capsByModel = new Map<string, Record<ModelCapabilityKey, CapabilitySupport>>();
  for (const id of modelIds) {
    capsByModel.set(id, defaultCapabilityMap());
  }
  for (const c of capRows) {
    const map = capsByModel.get(c.modelId);
    if (map) map[c.capability] = c.support;
  }

  const now = new Date();
  const pricingByModel = new Map<string, ModelPricingView>();
  for (const p of pricingRows) {
    if (!pricingByModel.has(p.modelId) && p.effectiveFrom <= now) {
      pricingByModel.set(p.modelId, p);
    }
  }

  return rows.map(({ model, providerKey }) => ({
    id: model.id,
    providerId: model.providerId,
    providerKey,
    modelKey: model.modelKey,
    displayName: model.displayName,
    availability: model.availability,
    contextWindow: model.contextWindow,
    maxOutputTokens: model.maxOutputTokens,
    qualityTier: model.qualityTier,
    metadataVerified: model.metadataVerified,
    source: model.source,
    notes: model.notes,
    capabilities: capsByModel.get(model.id) ?? defaultCapabilityMap(),
    activePricing: pricingByModel.get(model.id) ?? null,
    createdAt: model.createdAt,
    updatedAt: model.updatedAt,
    version: model.version,
  }));
}

export interface CreateModelInput {
  providerId: string;
  modelKey: string;
  displayName?: string;
  availability?: ModelAvailability;
  contextWindow?: number | null;
  maxOutputTokens?: number | null;
  qualityTier?: QualityTier;
  metadataVerified?: boolean;
  notes?: string;
  capabilities?: Partial<Record<ModelCapabilityKey, CapabilitySupport>>;
  pricing?: {
    inputPerMtok: string;
    outputPerMtok: string;
    cachedInputPerMtok?: string | null;
    currency?: string;
    effectiveFrom?: Date;
    source?: string;
    verified?: boolean;
  };
}

function validatePriceDecimal(label: string, val: string): string {
  const trimmed = val.trim();
  if (!/^\d+(\.\d{1,6})?$/.test(trimmed)) {
    throw new ValidationError(`${label} must be a non-negative decimal with at most 6 decimal places`);
  }
  return trimmed;
}

export async function createModel(db: Db, actor: Actor, input: CreateModelInput): Promise<ModelView> {
  await authorize(db, actor, 'ai.model.manage');
  const workspaceId = requireWorkspaceId(actor);
  const modelKey = input.modelKey.trim();
  if (!modelKey) throw new ValidationError('modelKey is required');
  const displayName = (input.displayName ?? modelKey).trim();
  if (!displayName) throw new ValidationError('displayName is required');

  return db.transaction(async (tx) => {
    const [provider] = await tx
      .select()
      .from(aiProviders)
      .where(and(eq(aiProviders.id, input.providerId), eq(aiProviders.workspaceId, workspaceId)))
      .limit(1);
    if (!provider) throw new NotFoundError('AIProvider', input.providerId);

    const [dup] = await tx
      .select({ id: aiModels.id })
      .from(aiModels)
      .where(and(eq(aiModels.providerId, provider.id), eq(aiModels.modelKey, modelKey)))
      .limit(1);
    if (dup) {
      throw new ConflictError(
        `Model '${modelKey}' is already registered for provider '${provider.providerKey}'`,
        'model_exists',
      );
    }

    const [created] = await tx
      .insert(aiModels)
      .values({
        providerId: provider.id,
        modelKey,
        displayName,
        availability: input.availability ?? 'unknown',
        contextWindow: input.contextWindow ?? null,
        maxOutputTokens: input.maxOutputTokens ?? null,
        qualityTier: input.qualityTier ?? 'unknown',
        metadataVerified: input.metadataVerified ?? false,
        source: 'manual',
        notes: input.notes ?? '',
      })
      .returning();

    const caps = defaultCapabilityMap(input.capabilities);
    const verifier = input.metadataVerified ? actorId(actor) : null;
    await tx.insert(aiModelCapabilities).values(
      modelCapabilityValues.map((cap) => ({
        modelId: created!.id,
        capability: cap,
        support: caps[cap],
        verifiedBy: caps[cap] !== 'unknown' ? verifier : null,
      })),
    );

    if (input.pricing) {
      await tx.insert(aiModelPricing).values({
        modelId: created!.id,
        inputPerMtok: validatePriceDecimal('inputPerMtok', input.pricing.inputPerMtok),
        outputPerMtok: validatePriceDecimal('outputPerMtok', input.pricing.outputPerMtok),
        cachedInputPerMtok:
          input.pricing.cachedInputPerMtok != null
            ? validatePriceDecimal('cachedInputPerMtok', input.pricing.cachedInputPerMtok)
            : null,
        currency: (input.pricing.currency ?? 'USD').toUpperCase(),
        effectiveFrom: input.pricing.effectiveFrom ?? new Date(),
        source: input.pricing.source ?? 'manual',
        verified: input.pricing.verified ?? false,
        createdBy: actorId(actor),
      });
    }

    await audit(tx, actor, {
      action: 'ai.model.created',
      targetType: 'ai_model',
      targetId: created!.id,
      payload: {
        providerId: provider.id,
        modelKey,
        qualityTier: created!.qualityTier,
        metadataVerified: created!.metadataVerified,
      },
    });
    await emitEvent(tx, {
      type: 'ai.model.created',
      aggregateType: 'ai_model',
      aggregateId: created!.id,
      workspaceId,
      payload: { modelId: created!.id, providerId: provider.id, modelKey },
    });

    const [view] = await buildModelViews(tx, [{ model: created!, providerKey: provider.providerKey }]);
    return view!;
  });
}

export async function listModels(
  db: Db,
  actor: Actor,
  filter: { providerId?: string; availability?: ModelAvailability } = {},
): Promise<ModelView[]> {
  await authorize(db, actor, 'ai.model.read');
  const workspaceId = requireWorkspaceId(actor);
  const rows = await db
    .select({
      model: aiModels,
      providerKey: aiProviders.providerKey,
    })
    .from(aiModels)
    .innerJoin(aiProviders, eq(aiModels.providerId, aiProviders.id))
    .where(
      and(
        eq(aiProviders.workspaceId, workspaceId),
        filter.providerId ? eq(aiModels.providerId, filter.providerId) : undefined,
        filter.availability ? eq(aiModels.availability, filter.availability) : undefined,
      ),
    )
    .orderBy(aiProviders.providerKey, aiModels.modelKey);

  return buildModelViews(db, rows);
}

export async function getModel(db: Db, actor: Actor, modelId: string): Promise<ModelView> {
  await authorize(db, actor, 'ai.model.read');
  const workspaceId = requireWorkspaceId(actor);
  const [row] = await db
    .select({
      model: aiModels,
      providerKey: aiProviders.providerKey,
    })
    .from(aiModels)
    .innerJoin(aiProviders, eq(aiModels.providerId, aiProviders.id))
    .where(and(eq(aiModels.id, modelId), eq(aiProviders.workspaceId, workspaceId)))
    .limit(1);
  if (!row) throw new NotFoundError('AIModel', modelId);
  const [view] = await buildModelViews(db, [row]);
  return view!;
}

export interface UpdateModelInput {
  displayName?: string;
  availability?: ModelAvailability;
  contextWindow?: number | null;
  maxOutputTokens?: number | null;
  qualityTier?: QualityTier;
  metadataVerified?: boolean;
  notes?: string;
  capabilities?: Partial<Record<ModelCapabilityKey, CapabilitySupport>>;
  expectedVersion?: number;
}

export async function updateModel(
  db: Db,
  actor: Actor,
  modelId: string,
  input: UpdateModelInput,
): Promise<ModelView> {
  await authorize(db, actor, 'ai.model.manage');
  const workspaceId = requireWorkspaceId(actor);
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select({
        model: aiModels,
        providerKey: aiProviders.providerKey,
      })
      .from(aiModels)
      .innerJoin(aiProviders, eq(aiModels.providerId, aiProviders.id))
      .where(and(eq(aiModels.id, modelId), eq(aiProviders.workspaceId, workspaceId)))
      .limit(1);
    if (!row) throw new NotFoundError('AIModel', modelId);
    if (input.expectedVersion !== undefined && row.model.version !== input.expectedVersion) {
      throw new VersionConflictError('AIModel', input.expectedVersion, row.model.version);
    }

    const patch: Partial<typeof aiModels.$inferInsert> = {
      updatedAt: new Date(),
      version: row.model.version + 1,
    };
    if (input.displayName !== undefined) {
      const dn = input.displayName.trim();
      if (!dn) throw new ValidationError('displayName cannot be empty');
      patch.displayName = dn;
    }
    if (input.availability !== undefined) patch.availability = input.availability;
    if (input.contextWindow !== undefined) patch.contextWindow = input.contextWindow;
    if (input.maxOutputTokens !== undefined) patch.maxOutputTokens = input.maxOutputTokens;
    if (input.qualityTier !== undefined) patch.qualityTier = input.qualityTier;
    if (input.metadataVerified !== undefined) patch.metadataVerified = input.metadataVerified;
    if (input.notes !== undefined) patch.notes = input.notes;

    const [updated] = await tx.update(aiModels).set(patch).where(eq(aiModels.id, modelId)).returning();

    if (input.capabilities) {
      const verifier = actorId(actor);
      for (const [capKey, support] of Object.entries(input.capabilities) as Array<
        [ModelCapabilityKey, CapabilitySupport]
      >) {
        if (!support) continue;
        await tx
          .insert(aiModelCapabilities)
          .values({
            modelId,
            capability: capKey,
            support,
            verifiedBy: support !== 'unknown' ? verifier : null,
            updatedAt: new Date(),
          })
          .onConflictDoUpdate({
            target: [aiModelCapabilities.modelId, aiModelCapabilities.capability],
            set: {
              support,
              verifiedBy: support !== 'unknown' ? verifier : null,
              updatedAt: new Date(),
            },
          });
      }
    }

    await audit(tx, actor, {
      action: 'ai.model.updated',
      targetType: 'ai_model',
      targetId: modelId,
      payload: {
        before: {
          availability: row.model.availability,
          qualityTier: row.model.qualityTier,
          metadataVerified: row.model.metadataVerified,
        },
        after: {
          availability: updated!.availability,
          qualityTier: updated!.qualityTier,
          metadataVerified: updated!.metadataVerified,
          capabilities: input.capabilities ?? null,
        },
      },
    });

    const [view] = await buildModelViews(tx, [{ model: updated!, providerKey: row.providerKey }]);
    return view!;
  });
}

export async function addModelPricing(
  db: Db,
  actor: Actor,
  modelId: string,
  input: {
    inputPerMtok: string;
    outputPerMtok: string;
    cachedInputPerMtok?: string | null;
    currency?: string;
    effectiveFrom?: Date;
    source?: string;
    verified?: boolean;
  },
): Promise<ModelPricingView> {
  await authorize(db, actor, 'ai.model.manage');
  const workspaceId = requireWorkspaceId(actor);
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select({ id: aiModels.id })
      .from(aiModels)
      .innerJoin(aiProviders, eq(aiModels.providerId, aiProviders.id))
      .where(and(eq(aiModels.id, modelId), eq(aiProviders.workspaceId, workspaceId)))
      .limit(1);
    if (!row) throw new NotFoundError('AIModel', modelId);

    const [created] = await tx
      .insert(aiModelPricing)
      .values({
        modelId,
        inputPerMtok: validatePriceDecimal('inputPerMtok', input.inputPerMtok),
        outputPerMtok: validatePriceDecimal('outputPerMtok', input.outputPerMtok),
        cachedInputPerMtok:
          input.cachedInputPerMtok != null
            ? validatePriceDecimal('cachedInputPerMtok', input.cachedInputPerMtok)
            : null,
        currency: (input.currency ?? 'USD').toUpperCase(),
        effectiveFrom: input.effectiveFrom ?? new Date(),
        source: input.source ?? 'manual',
        verified: input.verified ?? false,
        createdBy: actorId(actor),
      })
      .returning();

    await audit(tx, actor, {
      action: 'ai.model.pricing.added',
      targetType: 'ai_model',
      targetId: modelId,
      payload: {
        pricingId: created!.id,
        inputPerMtok: created!.inputPerMtok,
        outputPerMtok: created!.outputPerMtok,
        verified: created!.verified,
      },
    });

    return created!;
  });
}

/**
 * Syncs models from a provider endpoint (Blueprint §3.3, P3-07).
 * Never guesses unknown capabilities or pricing (`metadataVerified: false`, capabilities `'unknown'`),
 * and preserves already-verified metadata on existing models.
 */
export async function syncModelsFromProvider(
  db: Db,
  secretStore: SecretStore,
  registry: ProviderAdapterRegistry,
  actor: Actor,
  providerId: string,
): Promise<{ added: ModelView[]; existingCount: number }> {
  await authorize(db, actor, 'ai.model.manage');
  const workspaceId = requireWorkspaceId(actor);
  const { provider, ctx } = await resolveProviderConnectionContext(
    db,
    secretStore,
    workspaceId,
    providerId,
    { requireEnabled: false },
  );
  const adapter = registry.get(provider.adapterType);
  const discovered = await adapter.listModels(ctx);

  return db.transaction(async (tx) => {
    const existingRows = await tx
      .select()
      .from(aiModels)
      .where(eq(aiModels.providerId, provider.id));
    const existingKeys = new Set(existingRows.map((m) => m.modelKey));

    const addedRows: Array<typeof aiModels.$inferSelect> = [];
    for (const d of discovered) {
      if (existingKeys.has(d.modelKey)) continue;
      const [created] = await tx
        .insert(aiModels)
        .values({
          providerId: provider.id,
          modelKey: d.modelKey,
          displayName: d.displayName || d.modelKey,
          availability: 'available',
          contextWindow: d.contextWindow ?? null,
          maxOutputTokens: d.maxOutputTokens ?? null,
          qualityTier: 'unknown',
          metadataVerified: false,
          source: 'synced',
        })
        .returning();
      addedRows.push(created!);

      const caps = defaultCapabilityMap(d.capabilities);
      await tx.insert(aiModelCapabilities).values(
        modelCapabilityValues.map((cap) => ({
          modelId: created!.id,
          capability: cap,
          support: caps[cap],
          verifiedBy: null,
        })),
      );
    }

    await audit(tx, actor, {
      action: 'ai.models.synced',
      targetType: 'ai_provider',
      targetId: provider.id,
      payload: {
        discoveredCount: discovered.length,
        addedCount: addedRows.length,
        existingCount: existingRows.length,
      },
    });

    const added = await buildModelViews(
      tx,
      addedRows.map((model) => ({ model, providerKey: provider.providerKey })),
    );
    return { added, existingCount: existingRows.length };
  });
}

export interface EstimatedCostComputation {
  estimatedCost: string | null;
  actualCost: null;
  currency: string | null;
  pricingId: string | null;
  note: string;
}

/**
 * Computes estimated invocation cost from `ai_model_pricing` (Blueprint §3.3 & §10.2).
 * Never fabricates cost when pricing or token usage is unknown, and always leaves `actualCost` null.
 */
export async function computeEstimatedCost(
  db: Db,
  modelId: string,
  usage: InvocationUsage,
  at: Date = new Date(),
): Promise<EstimatedCostComputation> {
  if (usage.inputTokens === null && usage.outputTokens === null) {
    return {
      estimatedCost: null,
      actualCost: null,
      currency: null,
      pricingId: null,
      note: 'token_usage_unavailable',
    };
  }

  const [pricing] = await db
    .select()
    .from(aiModelPricing)
    .where(and(eq(aiModelPricing.modelId, modelId), lte(aiModelPricing.effectiveFrom, at)))
    .orderBy(desc(aiModelPricing.effectiveFrom), desc(aiModelPricing.createdAt))
    .limit(1);

  if (!pricing) {
    return {
      estimatedCost: null,
      actualCost: null,
      currency: null,
      pricingId: null,
      note: 'pricing_not_configured',
    };
  }

  const inputTotal = Math.max(0, usage.inputTokens ?? 0);
  const cached = Math.min(inputTotal, Math.max(0, usage.cachedTokens ?? 0));
  const uncachedInput = inputTotal - cached;
  const outputTotal = Math.max(0, (usage.outputTokens ?? 0) + (usage.reasoningTokens ?? 0));

  const inRate = Number(pricing.inputPerMtok);
  const outRate = Number(pricing.outputPerMtok);
  const cacheRate = pricing.cachedInputPerMtok !== null ? Number(pricing.cachedInputPerMtok) : inRate;

  const usd = (uncachedInput * inRate + cached * cacheRate + outputTotal * outRate) / 1_000_000;
  return {
    estimatedCost: usd.toFixed(6),
    actualCost: null,
    currency: pricing.currency,
    pricingId: pricing.id,
    note: pricing.verified ? 'verified_pricing' : 'unverified_pricing',
  };
}
