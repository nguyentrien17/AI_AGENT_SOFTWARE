import {
  boolean,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { createdAt, id, updatedAt, version } from './columns.js';
import { users, workspaces } from './iam.js';

export const adapterType = pgEnum('adapter_type', ['openai_compatible', 'gemini', 'anthropic']);
export const providerHealth = pgEnum('provider_health', ['unknown', 'healthy', 'degraded', 'failing']);

export const aiProviders = pgTable(
  'ai_providers',
  {
    id: id(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    providerKey: text('provider_key').notNull(),
    displayName: text('display_name').notNull(),
    adapterType: adapterType('adapter_type').notNull(),
    baseUrl: text('base_url').notNull(),
    enabled: boolean('enabled').notNull().default(true),
    /** Non-secret adapter options (e.g. API version, max-tokens parameter name). */
    config: jsonb('config').$type<Record<string, unknown>>().notNull().default({}),
    healthStatus: providerHealth('health_status').notNull().default('unknown'),
    lastCheckedAt: timestamp('last_checked_at', { withTimezone: true }),
    lastError: text('last_error'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    version: version(),
  },
  (t) => [uniqueIndex('ai_providers_ws_key_uq').on(t.workspaceId, t.providerKey)],
);

/**
 * Envelope-encrypted credentials (ADR-008). Plaintext is never stored; only a masked hint is displayable.
 * At most one active credential per provider.
 */
export const aiProviderCredentials = pgTable(
  'ai_provider_credentials',
  {
    id: id(),
    providerId: uuid('provider_id')
      .notNull()
      .references(() => aiProviders.id, { onDelete: 'cascade' }),
    scope: text('scope').notNull().default('workspace'),
    ciphertext: text('ciphertext').notNull(),
    iv: text('iv').notNull(),
    authTag: text('auth_tag').notNull(),
    wrappedDek: text('wrapped_dek').notNull(),
    keyVersion: integer('key_version').notNull(),
    maskedHint: text('masked_hint').notNull(),
    active: boolean('active').notNull().default(true),
    createdBy: uuid('created_by').references(() => users.id),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('ai_provider_credentials_active_uq').on(t.providerId).where(sql`${t.active}`),
    index('ai_provider_credentials_provider_idx').on(t.providerId),
  ],
);

export const modelAvailability = pgEnum('model_availability', ['available', 'unavailable', 'unknown', 'deprecated']);
export const qualityTier = pgEnum('quality_tier', ['economy', 'standard', 'high', 'frontier', 'unknown']);
export const modelSource = pgEnum('model_source', ['manual', 'synced']);

export const aiModels = pgTable(
  'ai_models',
  {
    id: id(),
    providerId: uuid('provider_id')
      .notNull()
      .references(() => aiProviders.id, { onDelete: 'cascade' }),
    modelKey: text('model_key').notNull(),
    displayName: text('display_name').notNull(),
    availability: modelAvailability('availability').notNull().default('unknown'),
    contextWindow: integer('context_window'),
    maxOutputTokens: integer('max_output_tokens'),
    qualityTier: qualityTier('quality_tier').notNull().default('unknown'),
    /** False until an administrator confirms metadata (Blueprint §3.3: never guess capabilities/pricing). */
    metadataVerified: boolean('metadata_verified').notNull().default(false),
    source: modelSource('source').notNull().default('manual'),
    notes: text('notes').notNull().default(''),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    version: version(),
  },
  (t) => [uniqueIndex('ai_models_provider_key_uq').on(t.providerId, t.modelKey)],
);

export const modelCapabilityValues = [
  'tool_calling',
  'structured_output',
  'vision',
  'streaming',
  'reasoning',
  'prompt_caching',
  'embeddings',
] as const;
export const modelCapability = pgEnum('model_capability', modelCapabilityValues);
export const capabilitySupport = pgEnum('capability_support', ['yes', 'no', 'unknown']);

export const aiModelCapabilities = pgTable(
  'ai_model_capabilities',
  {
    modelId: uuid('model_id')
      .notNull()
      .references(() => aiModels.id, { onDelete: 'cascade' }),
    capability: modelCapability('capability').notNull(),
    support: capabilitySupport('support').notNull().default('unknown'),
    verifiedBy: text('verified_by'),
    updatedAt: updatedAt(),
  },
  (t) => [primaryKey({ columns: [t.modelId, t.capability] })],
);

/** Append-only price history; the latest row with effective_from <= now applies. */
export const aiModelPricing = pgTable(
  'ai_model_pricing',
  {
    id: id(),
    modelId: uuid('model_id')
      .notNull()
      .references(() => aiModels.id, { onDelete: 'cascade' }),
    inputPerMtok: numeric('input_per_mtok', { precision: 14, scale: 6 }).notNull(),
    outputPerMtok: numeric('output_per_mtok', { precision: 14, scale: 6 }).notNull(),
    cachedInputPerMtok: numeric('cached_input_per_mtok', { precision: 14, scale: 6 }),
    currency: text('currency').notNull().default('USD'),
    effectiveFrom: timestamp('effective_from', { withTimezone: true }).notNull(),
    source: text('source').notNull(),
    verified: boolean('verified').notNull().default(false),
    createdBy: text('created_by').notNull(),
    createdAt: createdAt(),
  },
  (t) => [index('ai_model_pricing_model_idx').on(t.modelId, t.effectiveFrom)],
);

export const configScope = pgEnum('config_scope', ['global', 'project', 'workflow', 'agent', 'task']);
export const routingMode = pgEnum('routing_mode', ['fixed', 'adaptive', 'hybrid']);

export interface ModelParams {
  temperature?: number;
  maxOutputTokens?: number;
  reasoningEffort?: 'low' | 'medium' | 'high';
  streaming?: boolean;
  toolCalling?: boolean;
}
export interface ModelLimits {
  contextBudgetTokens?: number;
  timeoutSeconds?: number;
  maxRetries?: number;
  maxCostPerTask?: string;
  maxCostPerWorkflow?: string;
}
export interface RoutingPolicy {
  allowAutoUpgrade?: boolean;
  allowAutoDowngrade?: boolean;
  requireApprovalForProviderChange?: boolean;
}

/**
 * Model configuration at one of five scopes (Blueprint §4.3). `scope_key` uniquely identifies the
 * (scope_ref_id, agent_key) pair so each scope target has exactly one configuration row.
 */
export const agentModelConfigs = pgTable(
  'agent_model_configs',
  {
    id: id(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    scope: configScope('scope').notNull(),
    scopeRefId: uuid('scope_ref_id'),
    agentKey: text('agent_key'),
    scopeKey: text('scope_key').notNull(),
    mode: routingMode('mode').notNull(),
    primaryModelId: uuid('primary_model_id').references(() => aiModels.id, { onDelete: 'restrict' }),
    params: jsonb('params').$type<ModelParams>().notNull().default({}),
    limits: jsonb('limits').$type<ModelLimits>().notNull().default({}),
    routingPolicy: jsonb('routing_policy').$type<RoutingPolicy>().notNull().default({}),
    configVersion: integer('config_version').notNull().default(1),
    active: boolean('active').notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    version: version(),
  },
  (t) => [uniqueIndex('agent_model_configs_scope_uq').on(t.workspaceId, t.scope, t.scopeKey)],
);

export const agentModelAllowlist = pgTable(
  'agent_model_allowlist',
  {
    configId: uuid('config_id')
      .notNull()
      .references(() => agentModelConfigs.id, { onDelete: 'cascade' }),
    modelId: uuid('model_id')
      .notNull()
      .references(() => aiModels.id, { onDelete: 'restrict' }),
  },
  (t) => [primaryKey({ columns: [t.configId, t.modelId] })],
);

export const agentModelFallbacks = pgTable(
  'agent_model_fallbacks',
  {
    configId: uuid('config_id')
      .notNull()
      .references(() => agentModelConfigs.id, { onDelete: 'cascade' }),
    position: integer('position').notNull(),
    modelId: uuid('model_id')
      .notNull()
      .references(() => aiModels.id, { onDelete: 'restrict' }),
  },
  (t) => [primaryKey({ columns: [t.configId, t.position] })],
);

/** Append-only snapshots of every configuration version (Blueprint §4.5 configuration versioning). */
export const agentModelConfigHistory = pgTable(
  'agent_model_config_history',
  {
    id: id(),
    configId: uuid('config_id')
      .notNull()
      .references(() => agentModelConfigs.id, { onDelete: 'cascade' }),
    configVersion: integer('config_version').notNull(),
    snapshot: jsonb('snapshot').$type<Record<string, unknown>>().notNull(),
    changedByType: text('changed_by_type').notNull(),
    changedById: text('changed_by_id').notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('agent_model_config_history_uq').on(t.configId, t.configVersion)],
);

/** Reserved for Phase 4 routing policies; persisted now so configurations can reference them. */
export const modelRoutingPolicies = pgTable('model_routing_policies', {
  id: id(),
  workspaceId: uuid('workspace_id')
    .notNull()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  rules: jsonb('rules').$type<Record<string, unknown>>().notNull().default({}),
  hardCeilings: jsonb('hard_ceilings').$type<Record<string, unknown>>().notNull().default({}),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
  version: version(),
});

export const probeResult = pgEnum('probe_result', [
  'connection_successful',
  'authentication_failed',
  'model_unavailable',
  'rate_limited',
  'timeout',
  'unsupported_capability',
  'unknown_error',
]);

export const aiConnectionTests = pgTable(
  'ai_connection_tests',
  {
    id: id(),
    providerId: uuid('provider_id')
      .notNull()
      .references(() => aiProviders.id, { onDelete: 'cascade' }),
    modelId: uuid('model_id').references(() => aiModels.id, { onDelete: 'cascade' }),
    result: probeResult('result').notNull(),
    latencyMs: integer('latency_ms'),
    httpStatus: integer('http_status'),
    diagnostics: jsonb('diagnostics').$type<Record<string, unknown>>().notNull().default({}),
    createdBy: text('created_by').notNull(),
    createdAt: createdAt(),
  },
  (t) => [index('ai_connection_tests_provider_idx').on(t.providerId, t.createdAt)],
);

export const invocationPurpose = pgEnum('invocation_purpose', ['agent', 'playground', 'probe']);
export const invocationStatus = pgEnum('invocation_status', ['succeeded', 'failed']);

/** Telemetry per model invocation (Blueprint §10.2). Append-only. */
export const modelInvocations = pgTable(
  'model_invocations',
  {
    id: id(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    purpose: invocationPurpose('purpose').notNull(),
    providerId: uuid('provider_id')
      .notNull()
      .references(() => aiProviders.id, { onDelete: 'cascade' }),
    modelId: uuid('model_id')
      .notNull()
      .references(() => aiModels.id, { onDelete: 'cascade' }),
    agentKey: text('agent_key'),
    agentVersion: integer('agent_version'),
    projectId: uuid('project_id'),
    workflowId: uuid('workflow_id'),
    taskId: uuid('task_id'),
    configId: uuid('config_id'),
    configVersion: integer('config_version'),
    providerRequestId: text('provider_request_id'),
    status: invocationStatus('status').notNull(),
    errorKind: text('error_kind'),
    retryCount: integer('retry_count').notNull().default(0),
    durationMs: integer('duration_ms').notNull(),
    routingExplanation: jsonb('routing_explanation').$type<Record<string, unknown>>().notNull().default({}),
    actorType: text('actor_type').notNull(),
    actorId: text('actor_id').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    index('model_invocations_ws_created_idx').on(t.workspaceId, t.createdAt),
    index('model_invocations_task_idx').on(t.taskId, t.createdAt),
    index('model_invocations_project_idx').on(t.projectId, t.createdAt),
  ],
);

export const tokenUsage = pgTable('token_usage', {
  invocationId: uuid('invocation_id')
    .primaryKey()
    .references(() => modelInvocations.id, { onDelete: 'cascade' }),
  inputTokens: integer('input_tokens'),
  outputTokens: integer('output_tokens'),
  cachedTokens: integer('cached_tokens'),
  reasoningTokens: integer('reasoning_tokens'),
  createdAt: createdAt(),
});

/** `actual_cost` stays NULL unless a verified billing source provides it (Blueprint §10.2). */
export const costRecords = pgTable('cost_records', {
  invocationId: uuid('invocation_id')
    .primaryKey()
    .references(() => modelInvocations.id, { onDelete: 'cascade' }),
  estimatedCost: numeric('estimated_cost', { precision: 14, scale: 6 }),
  actualCost: numeric('actual_cost', { precision: 14, scale: 6 }),
  currency: text('currency'),
  pricingId: uuid('pricing_id').references(() => aiModelPricing.id),
  note: text('note'),
  createdAt: createdAt(),
});

/** AI Playground runs — isolated from production configuration. */
export const playgroundRuns = pgTable(
  'playground_runs',
  {
    id: id(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    invocationId: uuid('invocation_id').references(() => modelInvocations.id),
    comparisonId: uuid('comparison_id'),
    modelId: uuid('model_id')
      .notNull()
      .references(() => aiModels.id, { onDelete: 'cascade' }),
    simulatedRole: text('simulated_role'),
    systemPrompt: text('system_prompt').notNull().default(''),
    userPrompt: text('user_prompt').notNull(),
    params: jsonb('params').$type<ModelParams>().notNull().default({}),
    output: text('output'),
    error: text('error'),
    createdAt: createdAt(),
  },
  (t) => [index('playground_runs_ws_created_idx').on(t.workspaceId, t.createdAt)],
);

export const playgroundBenchmarks = pgTable('playground_benchmarks', {
  id: id(),
  workspaceId: uuid('workspace_id')
    .notNull()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  runIds: jsonb('run_ids').$type<string[]>().notNull(),
  notes: text('notes').notNull().default(''),
  createdBy: uuid('created_by')
    .notNull()
    .references(() => users.id),
  createdAt: createdAt(),
});
