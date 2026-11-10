import type { FastifyInstance } from 'fastify';
import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import { Type } from '@sinclair/typebox';
import {
  addModelPricing,
  comparePlaygroundModels,
  createDefaultAdapterRegistry,
  createModel,
  createProvider,
  EnvelopeSecretStore,
  getAgentModelConfigHistory,
  getCostSummary,
  getModel,
  getProvider,
  invokeForAgent,
  listAgentModelConfigs,
  listConnectionTests,
  listModels,
  listModelUsage,
  listPlaygroundBenchmarks,
  listProviders,
  probeProviderConnection,
  ProviderAdapterError,
  requireWorkspaceId,
  resolveEffectiveModelConfig,
  revokeProviderCredential,
  rotateProviderCredential,
  runPlayground,
  savePlaygroundBenchmark,
  syncModelsFromProvider,
  updateModel,
  updateProvider,
  upsertAgentModelConfig,
} from '@platform/ai-management';
import { AppError } from '@platform/shared';
import { actorOf } from '../auth-plugin.js';
import type { AppDeps } from '../deps.js';
import { IdParams, strict, Uuid } from '../schemas.js';

const AdapterTypeSchema = Type.Union([
  Type.Literal('openai_compatible'),
  Type.Literal('gemini'),
  Type.Literal('anthropic'),
]);

const AvailabilitySchema = Type.Union([
  Type.Literal('available'),
  Type.Literal('unavailable'),
  Type.Literal('unknown'),
  Type.Literal('deprecated'),
]);

const QualityTierSchema = Type.Union([
  Type.Literal('economy'),
  Type.Literal('standard'),
  Type.Literal('high'),
  Type.Literal('frontier'),
  Type.Literal('unknown'),
]);

const CapabilitySupportSchema = Type.Union([
  Type.Literal('yes'),
  Type.Literal('no'),
  Type.Literal('unknown'),
]);

const CapabilitiesMapSchema = Type.Partial(
  Type.Object(
    {
      tool_calling: CapabilitySupportSchema,
      structured_output: CapabilitySupportSchema,
      vision: CapabilitySupportSchema,
      streaming: CapabilitySupportSchema,
      reasoning: CapabilitySupportSchema,
      prompt_caching: CapabilitySupportSchema,
      embeddings: CapabilitySupportSchema,
    },
    strict,
  ),
);

const ConfigScopeSchema = Type.Union([
  Type.Literal('global'),
  Type.Literal('project'),
  Type.Literal('workflow'),
  Type.Literal('agent'),
  Type.Literal('task'),
]);

const RoutingModeSchema = Type.Union([
  Type.Literal('fixed'),
  Type.Literal('adaptive'),
  Type.Literal('hybrid'),
]);

const ModelParamsSchema = Type.Object(
  {
    temperature: Type.Optional(Type.Number({ minimum: 0, maximum: 2 })),
    maxOutputTokens: Type.Optional(Type.Integer({ minimum: 1, maximum: 2_000_000 })),
    reasoningEffort: Type.Optional(
      Type.Union([Type.Literal('low'), Type.Literal('medium'), Type.Literal('high')]),
    ),
    streaming: Type.Optional(Type.Boolean()),
    toolCalling: Type.Optional(Type.Boolean()),
  },
  strict,
);

const ModelLimitsSchema = Type.Object(
  {
    contextBudgetTokens: Type.Optional(Type.Integer({ minimum: 1 })),
    timeoutSeconds: Type.Optional(Type.Integer({ minimum: 1, maximum: 600 })),
    maxRetries: Type.Optional(Type.Integer({ minimum: 0, maximum: 10 })),
    maxCostPerTask: Type.Optional(Type.String()),
    maxCostPerWorkflow: Type.Optional(Type.String()),
  },
  strict,
);

const RoutingPolicySchema = Type.Object(
  {
    allowAutoUpgrade: Type.Optional(Type.Boolean()),
    allowAutoDowngrade: Type.Optional(Type.Boolean()),
    requireApprovalForProviderChange: Type.Optional(Type.Boolean()),
  },
  strict,
);

function mapAdapterError<T>(promise: Promise<T>): Promise<T> {
  return promise.catch((err) => {
    if (err instanceof ProviderAdapterError) {
      throw new AppError({
        status: err.kind === 'unsupported_capability' ? 422 : 502,
        code: err.kind,
        title: 'AI Provider Error',
        detail: err.message,
        extensions: {
          retryable: err.retryable,
          providerHttpStatus: err.httpStatus,
          diagnostics: err.diagnostics,
        },
      });
    }
    throw err;
  });
}

export function aiRoutes(app: FastifyInstance, deps: AppDeps) {
  const r = app.withTypeProvider<TypeBoxTypeProvider>();
  const { db } = deps;
  const secretStore = deps.secretStore ?? EnvelopeSecretStore.fromEnv();
  const registry = deps.adapterRegistry ?? createDefaultAdapterRegistry();

  // ------------------------------------------------------------------ Providers
  r.get('/ai/providers', async (req) => ({
    items: await listProviders(db, actorOf(req)),
  }));

  r.post(
    '/ai/providers',
    {
      schema: {
        body: Type.Object(
          {
            providerKey: Type.String({ minLength: 2, maxLength: 63 }),
            displayName: Type.String({ minLength: 1, maxLength: 120 }),
            adapterType: AdapterTypeSchema,
            baseUrl: Type.String({ minLength: 4, maxLength: 500 }),
            enabled: Type.Optional(Type.Boolean()),
            config: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
            apiKey: Type.Optional(Type.String({ minLength: 4, maxLength: 2000 })),
          },
          strict,
        ),
      },
    },
    async (req, reply) =>
      reply.code(201).send(await createProvider(db, secretStore, actorOf(req), req.body as never)),
  );

  r.get('/ai/providers/:id', { schema: { params: IdParams } }, async (req) =>
    getProvider(db, actorOf(req), req.params.id),
  );

  r.patch(
    '/ai/providers/:id',
    {
      schema: {
        params: IdParams,
        body: Type.Object(
          {
            displayName: Type.Optional(Type.String({ minLength: 1, maxLength: 120 })),
            baseUrl: Type.Optional(Type.String({ minLength: 4, maxLength: 500 })),
            enabled: Type.Optional(Type.Boolean()),
            config: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
            expectedVersion: Type.Optional(Type.Integer({ minimum: 1 })),
          },
          strict,
        ),
      },
    },
    async (req) => updateProvider(db, actorOf(req), req.params.id, req.body as never),
  );

  r.put(
    '/ai/providers/:id/credential',
    {
      schema: {
        params: IdParams,
        body: Type.Object({ apiKey: Type.String({ minLength: 4, maxLength: 2000 }) }, strict),
      },
    },
    async (req) =>
      rotateProviderCredential(db, secretStore, actorOf(req), req.params.id, req.body.apiKey),
  );

  r.delete('/ai/providers/:id/credential', { schema: { params: IdParams } }, async (req) =>
    revokeProviderCredential(db, actorOf(req), req.params.id),
  );

  r.post(
    '/ai/providers/:id/test',
    {
      schema: {
        params: IdParams,
        body: Type.Optional(
          Type.Object(
            {
              modelId: Type.Optional(Uuid),
              timeoutMs: Type.Optional(Type.Integer({ minimum: 100, maximum: 60_000 })),
            },
            strict,
          ),
        ),
      },
    },
    async (req) =>
      probeProviderConnection(db, secretStore, registry, actorOf(req), {
        providerId: req.params.id,
        ...(req.body?.modelId ? { modelId: req.body.modelId } : {}),
        ...(req.body?.timeoutMs ? { timeoutMs: req.body.timeoutMs } : {}),
      }),
  );

  r.get('/ai/providers/:id/tests', { schema: { params: IdParams } }, async (req) => ({
    items: await listConnectionTests(db, actorOf(req), req.params.id),
  }));

  r.post('/ai/providers/:id/sync-models', { schema: { params: IdParams } }, async (req) =>
    mapAdapterError(syncModelsFromProvider(db, secretStore, registry, actorOf(req), req.params.id)),
  );

  // ------------------------------------------------------------------ Models
  r.get(
    '/ai/models',
    {
      schema: {
        querystring: Type.Object({
          providerId: Type.Optional(Uuid),
          availability: Type.Optional(AvailabilitySchema),
        }),
      },
    },
    async (req) => ({
      items: await listModels(db, actorOf(req), req.query as never),
    }),
  );

  r.post(
    '/ai/models',
    {
      schema: {
        body: Type.Object(
          {
            providerId: Uuid,
            modelKey: Type.String({ minLength: 1, maxLength: 200 }),
            displayName: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
            availability: Type.Optional(AvailabilitySchema),
            contextWindow: Type.Optional(Type.Union([Type.Integer({ minimum: 1 }), Type.Null()])),
            maxOutputTokens: Type.Optional(Type.Union([Type.Integer({ minimum: 1 }), Type.Null()])),
            qualityTier: Type.Optional(QualityTierSchema),
            metadataVerified: Type.Optional(Type.Boolean()),
            notes: Type.Optional(Type.String({ maxLength: 2000 })),
            capabilities: Type.Optional(CapabilitiesMapSchema),
            pricing: Type.Optional(
              Type.Object(
                {
                  inputPerMtok: Type.String(),
                  outputPerMtok: Type.String(),
                  cachedInputPerMtok: Type.Optional(Type.Union([Type.String(), Type.Null()])),
                  currency: Type.Optional(Type.String({ minLength: 3, maxLength: 3 })),
                  source: Type.Optional(Type.String()),
                  verified: Type.Optional(Type.Boolean()),
                },
                strict,
              ),
            ),
          },
          strict,
        ),
      },
    },
    async (req, reply) => reply.code(201).send(await createModel(db, actorOf(req), req.body as never)),
  );

  r.get('/ai/models/:id', { schema: { params: IdParams } }, async (req) =>
    getModel(db, actorOf(req), req.params.id),
  );

  r.patch(
    '/ai/models/:id',
    {
      schema: {
        params: IdParams,
        body: Type.Object(
          {
            displayName: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
            availability: Type.Optional(AvailabilitySchema),
            contextWindow: Type.Optional(Type.Union([Type.Integer({ minimum: 1 }), Type.Null()])),
            maxOutputTokens: Type.Optional(Type.Union([Type.Integer({ minimum: 1 }), Type.Null()])),
            qualityTier: Type.Optional(QualityTierSchema),
            metadataVerified: Type.Optional(Type.Boolean()),
            notes: Type.Optional(Type.String({ maxLength: 2000 })),
            capabilities: Type.Optional(CapabilitiesMapSchema),
            expectedVersion: Type.Optional(Type.Integer({ minimum: 1 })),
          },
          strict,
        ),
      },
    },
    async (req) => updateModel(db, actorOf(req), req.params.id, req.body as never),
  );

  r.post(
    '/ai/models/:id/pricing',
    {
      schema: {
        params: IdParams,
        body: Type.Object(
          {
            inputPerMtok: Type.String(),
            outputPerMtok: Type.String(),
            cachedInputPerMtok: Type.Optional(Type.Union([Type.String(), Type.Null()])),
            currency: Type.Optional(Type.String({ minLength: 3, maxLength: 3 })),
            source: Type.Optional(Type.String()),
            verified: Type.Optional(Type.Boolean()),
          },
          strict,
        ),
      },
    },
    async (req, reply) =>
      reply.code(201).send(await addModelPricing(db, actorOf(req), req.params.id, req.body as never)),
  );

  r.post('/ai/models/:id/test', { schema: { params: IdParams } }, async (req) => {
    const model = await getModel(db, actorOf(req), req.params.id);
    return probeProviderConnection(db, secretStore, registry, actorOf(req), {
      providerId: model.providerId,
      modelId: model.id,
    });
  });

  // ------------------------------------------------------------------ Configurations & Runtime Dispatch
  r.get(
    '/ai/configurations',
    {
      schema: {
        querystring: Type.Object({
          scope: Type.Optional(ConfigScopeSchema),
          scopeRefId: Type.Optional(Uuid),
          agentKey: Type.Optional(Type.String()),
        }),
      },
    },
    async (req) => ({
      items: await listAgentModelConfigs(db, actorOf(req), req.query as never),
    }),
  );

  r.put(
    '/ai/configurations',
    {
      schema: {
        body: Type.Object(
          {
            scope: ConfigScopeSchema,
            scopeRefId: Type.Optional(Type.Union([Uuid, Type.Null()])),
            agentKey: Type.Optional(Type.Union([Type.String({ minLength: 1, maxLength: 60 }), Type.Null()])),
            mode: RoutingModeSchema,
            primaryModelId: Type.Optional(Type.Union([Uuid, Type.Null()])),
            allowlistModelIds: Type.Optional(Type.Array(Uuid)),
            fallbackModelIds: Type.Optional(Type.Array(Uuid)),
            params: Type.Optional(ModelParamsSchema),
            limits: Type.Optional(ModelLimitsSchema),
            routingPolicy: Type.Optional(RoutingPolicySchema),
            active: Type.Optional(Type.Boolean()),
          },
          strict,
        ),
      },
    },
    async (req) => upsertAgentModelConfig(db, actorOf(req), req.body as never),
  );

  r.get('/ai/configurations/:id/history', { schema: { params: IdParams } }, async (req) => ({
    items: await getAgentModelConfigHistory(db, actorOf(req), req.params.id),
  }));

  r.post(
    '/ai/configurations/resolve',
    {
      schema: {
        body: Type.Object(
          {
            agentKey: Type.String({ minLength: 1, maxLength: 60 }),
            projectId: Type.Optional(Uuid),
            workflowId: Type.Optional(Uuid),
            taskId: Type.Optional(Uuid),
          },
          strict,
        ),
      },
    },
    async (req) => {
      const actor = actorOf(req);
      return resolveEffectiveModelConfig(db, {
        workspaceId: requireWorkspaceId(actor),
        ...req.body,
      });
    },
  );

  r.post(
    '/ai/invocations',
    {
      schema: {
        body: Type.Object(
          {
            agentKey: Type.String({ minLength: 1, maxLength: 60 }),
            agentVersion: Type.Optional(Type.Integer({ minimum: 1 })),
            projectId: Type.Optional(Uuid),
            workflowId: Type.Optional(Uuid),
            taskId: Type.Optional(Uuid),
            systemInstruction: Type.Optional(Type.String()),
            untrustedContext: Type.Optional(Type.String()),
            messages: Type.Array(
              Type.Object(
                {
                  role: Type.Union([
                    Type.Literal('user'),
                    Type.Literal('assistant'),
                    Type.Literal('tool'),
                  ]),
                  content: Type.String(),
                  toolCallId: Type.Optional(Type.String()),
                  toolName: Type.Optional(Type.String()),
                },
                strict,
              ),
              { minItems: 1 },
            ),
            temperature: Type.Optional(Type.Number({ minimum: 0, maximum: 2 })),
            maxOutputTokens: Type.Optional(Type.Integer({ minimum: 1, maximum: 2_000_000 })),
          },
          strict,
        ),
      },
    },
    async (req) =>
      mapAdapterError(invokeForAgent(db, secretStore, registry, actorOf(req), req.body as never)),
  );

  // ------------------------------------------------------------------ Playground
  r.post(
    '/ai/playground/run',
    {
      schema: {
        body: Type.Object(
          {
            modelId: Uuid,
            simulatedRole: Type.Optional(Type.String({ maxLength: 60 })),
            systemPrompt: Type.Optional(Type.String({ maxLength: 100_000 })),
            userPrompt: Type.String({ minLength: 1, maxLength: 100_000 }),
            params: Type.Optional(ModelParamsSchema),
            maxEstimatedCostUsd: Type.Optional(Type.Number({ minimum: 0.000001, maximum: 10 })),
            acknowledgeCostWarning: Type.Optional(Type.Boolean()),
          },
          strict,
        ),
      },
    },
    async (req) =>
      mapAdapterError(runPlayground(db, secretStore, registry, actorOf(req), req.body as never)),
  );

  r.post(
    '/ai/playground/compare',
    {
      schema: {
        body: Type.Object(
          {
            modelIds: Type.Array(Uuid, { minItems: 2, maxItems: 5 }),
            simulatedRole: Type.Optional(Type.String({ maxLength: 60 })),
            systemPrompt: Type.Optional(Type.String({ maxLength: 100_000 })),
            userPrompt: Type.String({ minLength: 1, maxLength: 100_000 }),
            params: Type.Optional(ModelParamsSchema),
            maxEstimatedCostUsd: Type.Optional(Type.Number({ minimum: 0.000001, maximum: 10 })),
            acknowledgeCostWarning: Type.Optional(Type.Boolean()),
          },
          strict,
        ),
      },
    },
    async (req) =>
      mapAdapterError(comparePlaygroundModels(db, secretStore, registry, actorOf(req), req.body as never)),
  );

  r.post(
    '/ai/playground/benchmarks',
    {
      schema: {
        body: Type.Object(
          {
            name: Type.String({ minLength: 1, maxLength: 200 }),
            runIds: Type.Array(Uuid, { minItems: 1, maxItems: 20 }),
            notes: Type.Optional(Type.String({ maxLength: 2000 })),
          },
          strict,
        ),
      },
    },
    async (req, reply) =>
      reply.code(201).send(await savePlaygroundBenchmark(db, actorOf(req), req.body)),
  );

  r.get('/ai/playground/benchmarks', async (req) => ({
    items: await listPlaygroundBenchmarks(db, actorOf(req)),
  }));

  // ------------------------------------------------------------------ Usage & Costs
  r.get(
    '/ai/usage',
    {
      schema: {
        querystring: Type.Object({
          projectId: Type.Optional(Uuid),
          agentKey: Type.Optional(Type.String()),
          modelId: Type.Optional(Uuid),
          limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
        }),
      },
    },
    async (req) => ({
      items: await listModelUsage(db, actorOf(req), req.query as never),
    }),
  );

  r.get(
    '/ai/costs',
    {
      schema: {
        querystring: Type.Object({
          projectId: Type.Optional(Uuid),
        }),
      },
    },
    async (req) => getCostSummary(db, actorOf(req), req.query as never),
  );
}
