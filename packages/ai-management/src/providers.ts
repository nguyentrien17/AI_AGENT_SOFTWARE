import { and, desc, eq } from 'drizzle-orm';
import {
  aiConnectionTests,
  aiModels,
  aiProviderCredentials,
  aiProviders,
  type Db,
  modelInvocations,
} from '@platform/db';
import { authorize } from '@platform/iam';
import { audit, emitEvent } from '@platform/observability';
import {
  type Actor,
  actorId,
  ConflictError,
  NotFoundError,
  UnprocessableError,
  ValidationError,
  VersionConflictError,
} from '@platform/shared';
import type {
  AdapterConnectionContext,
  AdapterType,
  ProbeResponse,
  ProviderAdapterRegistry,
} from './adapters/index.js';
import type { SecretStore } from './secret-store.js';

export interface ProviderCredentialSummary {
  hasCredential: boolean;
  maskedHint: string | null;
  keyVersion: number | null;
  createdAt: Date | null;
}

export interface ProviderView {
  id: string;
  workspaceId: string;
  providerKey: string;
  displayName: string;
  adapterType: AdapterType;
  baseUrl: string;
  enabled: boolean;
  config: Record<string, unknown>;
  healthStatus: 'unknown' | 'healthy' | 'degraded' | 'failing';
  lastCheckedAt: Date | null;
  lastError: string | null;
  createdAt: Date;
  updatedAt: Date;
  version: number;
  credential: ProviderCredentialSummary;
}

const PROVIDER_KEY_RE = /^[a-z0-9][a-z0-9_-]{1,62}$/;

export function requireWorkspaceId(actor: Actor): string {
  if (!actor.workspaceId) {
    throw new ValidationError('Actor is missing workspaceId');
  }
  return actor.workspaceId;
}

function validateBaseUrl(raw: string): string {
  const trimmed = raw.trim();
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new ValidationError('baseUrl must be a valid http:// or https:// URL');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new ValidationError('baseUrl protocol must be http: or https:');
  }
  if (parsed.username || parsed.password || parsed.search) {
    throw new ValidationError('baseUrl must not embed credentials or query parameters');
  }
  return trimmed.replace(/\/+$/, '');
}

async function toProviderView(db: Db, row: typeof aiProviders.$inferSelect): Promise<ProviderView> {
  const [cred] = await db
    .select({
      maskedHint: aiProviderCredentials.maskedHint,
      keyVersion: aiProviderCredentials.keyVersion,
      createdAt: aiProviderCredentials.createdAt,
    })
    .from(aiProviderCredentials)
    .where(and(eq(aiProviderCredentials.providerId, row.id), eq(aiProviderCredentials.active, true)))
    .limit(1);

  return {
    id: row.id,
    workspaceId: row.workspaceId,
    providerKey: row.providerKey,
    displayName: row.displayName,
    adapterType: row.adapterType,
    baseUrl: row.baseUrl,
    enabled: row.enabled,
    config: row.config,
    healthStatus: row.healthStatus,
    lastCheckedAt: row.lastCheckedAt,
    lastError: row.lastError,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    version: row.version,
    credential: {
      hasCredential: Boolean(cred),
      maskedHint: cred?.maskedHint ?? null,
      keyVersion: cred?.keyVersion ?? null,
      createdAt: cred?.createdAt ?? null,
    },
  };
}

export interface CreateProviderInput {
  providerKey: string;
  displayName: string;
  adapterType: AdapterType;
  baseUrl: string;
  enabled?: boolean;
  config?: Record<string, unknown>;
  apiKey?: string;
}

export async function createProvider(
  db: Db,
  secretStore: SecretStore,
  actor: Actor,
  input: CreateProviderInput,
): Promise<ProviderView> {
  await authorize(db, actor, 'ai.provider.manage');
  const workspaceId = requireWorkspaceId(actor);
  const providerKey = input.providerKey.trim().toLowerCase();
  if (!PROVIDER_KEY_RE.test(providerKey)) {
    throw new ValidationError('providerKey must match /^[a-z0-9][a-z0-9_-]{1,62}$/');
  }
  const displayName = input.displayName.trim();
  if (!displayName) throw new ValidationError('displayName is required');
  const baseUrl = validateBaseUrl(input.baseUrl);

  const envelope = input.apiKey ? secretStore.encrypt(input.apiKey) : null;

  return db.transaction(async (tx) => {
    const [existing] = await tx
      .select({ id: aiProviders.id })
      .from(aiProviders)
      .where(and(eq(aiProviders.workspaceId, workspaceId), eq(aiProviders.providerKey, providerKey)))
      .limit(1);
    if (existing) {
      throw new ConflictError(`Provider '${providerKey}' already exists in workspace`, 'provider_exists');
    }

    const [created] = await tx
      .insert(aiProviders)
      .values({
        workspaceId,
        providerKey,
        displayName,
        adapterType: input.adapterType,
        baseUrl,
        enabled: input.enabled ?? true,
        config: input.config ?? {},
      })
      .returning();

    if (envelope) {
      await tx.insert(aiProviderCredentials).values({
        providerId: created!.id,
        scope: 'workspace',
        ciphertext: envelope.ciphertext,
        iv: envelope.iv,
        authTag: envelope.authTag,
        wrappedDek: envelope.wrappedDek,
        keyVersion: envelope.keyVersion,
        maskedHint: envelope.maskedHint,
        active: true,
        createdBy: actor.type === 'user' ? actor.userId : null,
      });
    }

    await audit(tx, actor, {
      action: 'ai.provider.created',
      targetType: 'ai_provider',
      targetId: created!.id,
      payload: {
        providerKey,
        displayName,
        adapterType: input.adapterType,
        baseUrl,
        enabled: created!.enabled,
        hasCredential: Boolean(envelope),
        maskedHint: envelope?.maskedHint ?? null,
      },
    });
    await emitEvent(tx, {
      type: 'ai.provider.created',
      aggregateType: 'ai_provider',
      aggregateId: created!.id,
      workspaceId,
      payload: { providerId: created!.id, providerKey, adapterType: input.adapterType },
    });

    return toProviderView(tx, created!);
  });
}

export async function listProviders(db: Db, actor: Actor): Promise<ProviderView[]> {
  await authorize(db, actor, 'ai.provider.read');
  const workspaceId = requireWorkspaceId(actor);
  const rows = await db
    .select()
    .from(aiProviders)
    .where(eq(aiProviders.workspaceId, workspaceId))
    .orderBy(aiProviders.providerKey);
  const views: ProviderView[] = [];
  for (const row of rows) {
    views.push(await toProviderView(db, row));
  }
  return views;
}

export async function getProvider(db: Db, actor: Actor, providerId: string): Promise<ProviderView> {
  await authorize(db, actor, 'ai.provider.read');
  const workspaceId = requireWorkspaceId(actor);
  const [row] = await db
    .select()
    .from(aiProviders)
    .where(and(eq(aiProviders.id, providerId), eq(aiProviders.workspaceId, workspaceId)))
    .limit(1);
  if (!row) throw new NotFoundError('AIProvider', providerId);
  return toProviderView(db, row);
}

export interface UpdateProviderInput {
  displayName?: string;
  baseUrl?: string;
  enabled?: boolean;
  config?: Record<string, unknown>;
  expectedVersion?: number;
}

export async function updateProvider(
  db: Db,
  actor: Actor,
  providerId: string,
  input: UpdateProviderInput,
): Promise<ProviderView> {
  await authorize(db, actor, 'ai.provider.manage');
  const workspaceId = requireWorkspaceId(actor);
  return db.transaction(async (tx) => {
    const [existing] = await tx
      .select()
      .from(aiProviders)
      .where(and(eq(aiProviders.id, providerId), eq(aiProviders.workspaceId, workspaceId)))
      .limit(1);
    if (!existing) throw new NotFoundError('AIProvider', providerId);
    if (input.expectedVersion !== undefined && existing.version !== input.expectedVersion) {
      throw new VersionConflictError('AIProvider', input.expectedVersion, existing.version);
    }

    const patch: Partial<typeof aiProviders.$inferInsert> = {
      updatedAt: new Date(),
      version: existing.version + 1,
    };
    if (input.displayName !== undefined) {
      const dn = input.displayName.trim();
      if (!dn) throw new ValidationError('displayName cannot be empty');
      patch.displayName = dn;
    }
    if (input.baseUrl !== undefined) {
      patch.baseUrl = validateBaseUrl(input.baseUrl);
    }
    if (input.enabled !== undefined) {
      patch.enabled = input.enabled;
    }
    if (input.config !== undefined) {
      patch.config = input.config;
    }

    const [updated] = await tx
      .update(aiProviders)
      .set(patch)
      .where(eq(aiProviders.id, providerId))
      .returning();

    await audit(tx, actor, {
      action: 'ai.provider.updated',
      targetType: 'ai_provider',
      targetId: providerId,
      payload: {
        before: {
          displayName: existing.displayName,
          baseUrl: existing.baseUrl,
          enabled: existing.enabled,
        },
        after: {
          displayName: updated!.displayName,
          baseUrl: updated!.baseUrl,
          enabled: updated!.enabled,
        },
      },
    });
    return toProviderView(tx, updated!);
  });
}

/**
 * Sets or rotates the active credential for a provider (Blueprint §3.2).
 * Deactivates any previous active credential, inserts a new envelope-encrypted row, and logs only the masked hint.
 */
export async function rotateProviderCredential(
  db: Db,
  secretStore: SecretStore,
  actor: Actor,
  providerId: string,
  apiKey: string,
): Promise<ProviderView> {
  await authorize(db, actor, 'ai.provider.manage');
  const workspaceId = requireWorkspaceId(actor);
  const envelope = secretStore.encrypt(apiKey);

  return db.transaction(async (tx) => {
    const [existing] = await tx
      .select()
      .from(aiProviders)
      .where(and(eq(aiProviders.id, providerId), eq(aiProviders.workspaceId, workspaceId)))
      .limit(1);
    if (!existing) throw new NotFoundError('AIProvider', providerId);

    const [prevCred] = await tx
      .select({ id: aiProviderCredentials.id, maskedHint: aiProviderCredentials.maskedHint })
      .from(aiProviderCredentials)
      .where(and(eq(aiProviderCredentials.providerId, providerId), eq(aiProviderCredentials.active, true)))
      .limit(1);

    if (prevCred) {
      await tx
        .update(aiProviderCredentials)
        .set({ active: false, revokedAt: new Date() })
        .where(eq(aiProviderCredentials.id, prevCred.id));
    }

    await tx.insert(aiProviderCredentials).values({
      providerId,
      scope: 'workspace',
      ciphertext: envelope.ciphertext,
      iv: envelope.iv,
      authTag: envelope.authTag,
      wrappedDek: envelope.wrappedDek,
      keyVersion: envelope.keyVersion,
      maskedHint: envelope.maskedHint,
      active: true,
      createdBy: actor.type === 'user' ? actor.userId : null,
    });

    await audit(tx, actor, {
      action: prevCred ? 'ai.provider.credential.rotated' : 'ai.provider.credential.set',
      targetType: 'ai_provider',
      targetId: providerId,
      payload: {
        previousMaskedHint: prevCred?.maskedHint ?? null,
        maskedHint: envelope.maskedHint,
        keyVersion: envelope.keyVersion,
      },
    });

    return toProviderView(tx, existing);
  });
}

export async function revokeProviderCredential(
  db: Db,
  actor: Actor,
  providerId: string,
): Promise<ProviderView> {
  await authorize(db, actor, 'ai.provider.manage');
  const workspaceId = requireWorkspaceId(actor);
  return db.transaction(async (tx) => {
    const [existing] = await tx
      .select()
      .from(aiProviders)
      .where(and(eq(aiProviders.id, providerId), eq(aiProviders.workspaceId, workspaceId)))
      .limit(1);
    if (!existing) throw new NotFoundError('AIProvider', providerId);

    const [prevCred] = await tx
      .select({ id: aiProviderCredentials.id, maskedHint: aiProviderCredentials.maskedHint })
      .from(aiProviderCredentials)
      .where(and(eq(aiProviderCredentials.providerId, providerId), eq(aiProviderCredentials.active, true)))
      .limit(1);

    if (prevCred) {
      await tx
        .update(aiProviderCredentials)
        .set({ active: false, revokedAt: new Date() })
        .where(eq(aiProviderCredentials.id, prevCred.id));

      await audit(tx, actor, {
        action: 'ai.provider.credential.revoked',
        targetType: 'ai_provider',
        targetId: providerId,
        payload: { previousMaskedHint: prevCred.maskedHint, active: false },
      });
    }

    return toProviderView(tx, existing);
  });
}

/**
 * Internal helper — resolves the decrypted connection context for a provider.
 * Plaintext key stays in memory only for the duration of the outbound adapter request.
 */
export async function resolveProviderConnectionContext(
  db: Db,
  secretStore: SecretStore,
  workspaceId: string,
  providerId: string,
  opts: { requireEnabled?: boolean; timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<{
  provider: typeof aiProviders.$inferSelect;
  ctx: AdapterConnectionContext;
}> {
  const [provider] = await db
    .select()
    .from(aiProviders)
    .where(and(eq(aiProviders.id, providerId), eq(aiProviders.workspaceId, workspaceId)))
    .limit(1);
  if (!provider) throw new NotFoundError('AIProvider', providerId);
  if (opts.requireEnabled !== false && !provider.enabled) {
    throw new UnprocessableError(
      `AI provider '${provider.providerKey}' is disabled`,
      'provider_disabled',
      { reason: 'provider_disabled', providerId: provider.id },
    );
  }

  const [cred] = await db
    .select()
    .from(aiProviderCredentials)
    .where(and(eq(aiProviderCredentials.providerId, provider.id), eq(aiProviderCredentials.active, true)))
    .limit(1);

  const apiKey = cred ? secretStore.decrypt(cred) : null;
  const ctx: AdapterConnectionContext = {
    baseUrl: provider.baseUrl,
    apiKey,
    config: provider.config,
  };
  if (opts.timeoutMs !== undefined) ctx.timeoutMs = opts.timeoutMs;
  if (opts.signal !== undefined) ctx.signal = opts.signal;

  return { provider, ctx };
}

function mapProbeToHealth(result: ProbeResponse['result']): 'healthy' | 'degraded' | 'failing' {
  switch (result) {
    case 'connection_successful':
      return 'healthy';
    case 'rate_limited':
    case 'timeout':
      return 'degraded';
    default:
      return 'failing';
  }
}

/**
 * Probes a provider or specific model (Blueprint §3.4, P3-06).
 * Persists an `ai_connection_tests` row, updates `ai_providers.healthStatus`, and records a `probe` invocation
 * when a model is targeted.
 */
export async function probeProviderConnection(
  db: Db,
  secretStore: SecretStore,
  registry: ProviderAdapterRegistry,
  actor: Actor,
  input: { providerId: string; modelId?: string; timeoutMs?: number },
): Promise<typeof aiConnectionTests.$inferSelect> {
  await authorize(db, actor, 'ai.provider.manage');
  const workspaceId = requireWorkspaceId(actor);

  const { provider, ctx } = await resolveProviderConnectionContext(
    db,
    secretStore,
    workspaceId,
    input.providerId,
    { requireEnabled: false, ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}) },
  );

  let modelKey: string | undefined;
  if (input.modelId) {
    const [m] = await db
      .select()
      .from(aiModels)
      .where(and(eq(aiModels.id, input.modelId), eq(aiModels.providerId, provider.id)))
      .limit(1);
    if (!m) throw new NotFoundError('AIModel', input.modelId);
    modelKey = m.modelKey;
  }

  const adapter = registry.get(provider.adapterType);
  const probeResp = await adapter.probe(ctx, modelKey);
  const healthStatus = mapProbeToHealth(probeResp.result);
  const lastError =
    probeResp.result === 'connection_successful'
      ? null
      : typeof probeResp.diagnostics['message'] === 'string'
        ? probeResp.diagnostics['message']
        : probeResp.result;

  return db.transaction(async (tx) => {
    const [testRow] = await tx
      .insert(aiConnectionTests)
      .values({
        providerId: provider.id,
        modelId: input.modelId ?? null,
        result: probeResp.result,
        latencyMs: probeResp.latencyMs,
        httpStatus: probeResp.httpStatus,
        diagnostics: probeResp.diagnostics,
        createdBy: actorId(actor),
      })
      .returning();

    await tx
      .update(aiProviders)
      .set({
        healthStatus,
        lastCheckedAt: new Date(),
        lastError,
        updatedAt: new Date(),
      })
      .where(eq(aiProviders.id, provider.id));

    if (input.modelId) {
      if (probeResp.result === 'connection_successful') {
        await tx
          .update(aiModels)
          .set({ availability: 'available', updatedAt: new Date() })
          .where(eq(aiModels.id, input.modelId));
      } else if (probeResp.result === 'model_unavailable') {
        await tx
          .update(aiModels)
          .set({ availability: 'unavailable', updatedAt: new Date() })
          .where(eq(aiModels.id, input.modelId));
      }

      await tx.insert(modelInvocations).values({
        workspaceId,
        purpose: 'probe',
        providerId: provider.id,
        modelId: input.modelId,
        status: probeResp.result === 'connection_successful' ? 'succeeded' : 'failed',
        errorKind: probeResp.result === 'connection_successful' ? null : probeResp.result,
        durationMs: probeResp.latencyMs,
        actorType: actor.type,
        actorId: actorId(actor),
      });
    }

    await audit(tx, actor, {
      action: 'ai.provider.probed',
      targetType: 'ai_provider',
      targetId: provider.id,
      payload: {
        modelId: input.modelId ?? null,
        result: probeResp.result,
        latencyMs: probeResp.latencyMs,
        healthStatus,
      },
    });

    return testRow!;
  });
}

export async function listConnectionTests(
  db: Db,
  actor: Actor,
  providerId: string,
  limit = 20,
): Promise<Array<typeof aiConnectionTests.$inferSelect>> {
  await authorize(db, actor, 'ai.provider.read');
  const workspaceId = requireWorkspaceId(actor);
  const [provider] = await db
    .select({ id: aiProviders.id })
    .from(aiProviders)
    .where(and(eq(aiProviders.id, providerId), eq(aiProviders.workspaceId, workspaceId)))
    .limit(1);
  if (!provider) throw new NotFoundError('AIProvider', providerId);

  return db
    .select()
    .from(aiConnectionTests)
    .where(eq(aiConnectionTests.providerId, providerId))
    .orderBy(desc(aiConnectionTests.createdAt))
    .limit(Math.min(Math.max(1, limit), 100));
}
