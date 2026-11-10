import type { FastifyInstance } from 'fastify';
import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import { Type } from '@sinclair/typebox';
import {
  createDefaultAdapterRegistry,
  EnvelopeSecretStore,
  ProviderAdapterError,
} from '@platform/ai-management';
import {
  COST_GROUP_BY,
  getCostBreakdown,
  listBudgetEvents,
  listBudgets,
  upsertBudget,
} from '@platform/budget';
import {
  listFallbackEvents,
  previewRoute,
  readRoutingPolicy,
  routeAndInvoke,
  upsertRoutingPolicy,
} from '@platform/model-router';
import { AppError, ValidationError } from '@platform/shared';
import { actorOf } from '../auth-plugin.js';
import { createBudgetHaltHandler } from '../budget-halt.js';
import type { AppDeps } from '../deps.js';
import { ComplexitySchema, IdParams, strict, Uuid } from '../schemas.js';

const literals = <T extends string>(values: readonly T[]) => Type.Union(values.map((v) => Type.Literal(v)));

const CapabilitySchema = literals([
  'tool_calling',
  'structured_output',
  'vision',
  'streaming',
  'reasoning',
  'prompt_caching',
  'embeddings',
] as const);
const RiskSchema = literals(['low', 'medium', 'high', 'critical'] as const);
const BudgetLevelSchema = literals(['system', 'project', 'workflow', 'task', 'invocation'] as const);
const ReasoningEffortSchema = literals(['low', 'medium', 'high'] as const);

/** Routing inputs shared by the dry-run and the real invocation (Blueprint §5.1). */
const routeQueryProps = {
  agentKey: Type.String({ minLength: 1, maxLength: 60 }),
  projectId: Type.Optional(Uuid),
  workflowId: Type.Optional(Uuid),
  taskId: Type.Optional(Uuid),
  requiredCapabilities: Type.Optional(Type.Array(CapabilitySchema, { maxItems: 7 })),
  estimatedInputTokens: Type.Optional(Type.Integer({ minimum: 0, maximum: 10_000_000 })),
  expectedOutputTokens: Type.Optional(Type.Integer({ minimum: 1, maximum: 2_000_000 })),
  maxOutputTokens: Type.Optional(Type.Integer({ minimum: 1, maximum: 2_000_000 })),
  reasoningEffort: Type.Optional(ReasoningEffortSchema),
  complexity: Type.Optional(ComplexitySchema),
  riskLevel: Type.Optional(RiskSchema),
  taskKind: Type.Optional(Type.String({ minLength: 1, maxLength: 60 })),
  qualityGateCritical: Type.Optional(Type.Boolean()),
  essential: Type.Optional(Type.Boolean()),
};

function parseDate(value: string | undefined, field: string): Date | undefined {
  if (value === undefined) return undefined;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) throw new ValidationError(`${field} must be an ISO-8601 date-time`);
  return d;
}

/** Phase 4 HTTP surface: routed invocations, router dry-run, routing policy, budgets, cost analytics. */
export function routerRoutes(app: FastifyInstance, deps: AppDeps) {
  const r = app.withTypeProvider<TypeBoxTypeProvider>();
  const { db } = deps;
  const secretStore = deps.secretStore ?? EnvelopeSecretStore.fromEnv();
  const registry = deps.adapterRegistry ?? createDefaultAdapterRegistry();

  const onBudgetHalt = createBudgetHaltHandler(db, deps.storage);

  // ------------------------------------------------------------------ Routed invocation
  r.post(
    '/ai/invocations',
    {
      schema: {
        body: Type.Object(
          {
            ...routeQueryProps,
            agentVersion: Type.Optional(Type.Integer({ minimum: 1 })),
            systemInstruction: Type.Optional(Type.String()),
            untrustedContext: Type.Optional(Type.String()),
            messages: Type.Array(
              Type.Object(
                {
                  role: literals(['user', 'assistant', 'tool'] as const),
                  content: Type.String(),
                  toolCallId: Type.Optional(Type.String()),
                  toolName: Type.Optional(Type.String()),
                },
                strict,
              ),
              { minItems: 1 },
            ),
            temperature: Type.Optional(Type.Number({ minimum: 0, maximum: 2 })),
          },
          strict,
        ),
      },
    },
    async (req) => {
      try {
        return await routeAndInvoke(
          { db, secretStore, registry, onBudgetHalt },
          actorOf(req),
          req.body as never,
        );
      } catch (err) {
        if (err instanceof ProviderAdapterError) {
          throw new AppError({
            status: err.kind === 'unsupported_capability' ? 422 : 502,
            code: err.kind,
            title: 'AI Provider Error',
            detail: err.message,
            extensions: { retryable: err.retryable, providerHttpStatus: err.httpStatus },
          });
        }
        throw err;
      }
    },
  );

  r.post('/ai/router/resolve', { schema: { body: Type.Object(routeQueryProps, strict) } }, async (req) =>
    previewRoute(db, actorOf(req), req.body as never),
  );

  r.get(
    '/ai/fallback-events',
    {
      schema: {
        querystring: Type.Object({
          agentKey: Type.Optional(Type.String()),
          projectId: Type.Optional(Uuid),
          taskId: Type.Optional(Uuid),
          limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
        }),
      },
    },
    async (req) => ({ items: await listFallbackEvents(db, actorOf(req), req.query as never) }),
  );

  // ------------------------------------------------------------------ Routing policy (hard ceilings)
  r.get('/ai/routing-policies', async (req) => readRoutingPolicy(db, actorOf(req)));

  r.put(
    '/ai/routing-policies',
    {
      schema: {
        body: Type.Object(
          {
            hardCeilings: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
            rules: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
          },
          strict,
        ),
      },
    },
    async (req) => upsertRoutingPolicy(db, actorOf(req), req.body),
  );

  // ------------------------------------------------------------------ Budgets
  r.get(
    '/budgets',
    {
      schema: {
        querystring: Type.Object({
          level: Type.Optional(BudgetLevelSchema),
          scopeRefId: Type.Optional(Uuid),
        }),
      },
    },
    async (req) => ({ items: await listBudgets(db, actorOf(req), req.query as never) }),
  );

  r.put(
    '/budgets',
    {
      schema: {
        body: Type.Object(
          {
            level: BudgetLevelSchema,
            scopeRefId: Type.Optional(Type.Union([Uuid, Type.Null()])),
            tokenLimit: Type.Optional(Type.Union([Type.Integer({ minimum: 1 }), Type.Null()])),
            costLimitUsd: Type.Optional(Type.Union([Type.String({ maxLength: 20 }), Type.Null()])),
            thresholds: Type.Optional(
              Type.Object(
                {
                  optimizePct: Type.Optional(Type.Number({ exclusiveMinimum: 0, exclusiveMaximum: 100 })),
                  warningPct: Type.Optional(Type.Number({ exclusiveMinimum: 0, exclusiveMaximum: 100 })),
                  restrictPct: Type.Optional(Type.Number({ exclusiveMinimum: 0, exclusiveMaximum: 100 })),
                  haltPct: Type.Optional(Type.Number({ exclusiveMinimum: 0, exclusiveMaximum: 100 })),
                },
                strict,
              ),
            ),
          },
          strict,
        ),
      },
    },
    async (req) => upsertBudget(db, actorOf(req), req.body as never),
  );

  r.get('/budgets/:id/events', { schema: { params: IdParams } }, async (req) => ({
    items: await listBudgetEvents(db, actorOf(req), req.params.id),
  }));

  // ------------------------------------------------------------------ Cost analytics
  r.get(
    '/ai/costs/breakdown',
    {
      schema: {
        querystring: Type.Object({
          providerId: Type.Optional(Uuid),
          modelId: Type.Optional(Uuid),
          agentKey: Type.Optional(Type.String()),
          projectId: Type.Optional(Uuid),
          workflowId: Type.Optional(Uuid),
          taskId: Type.Optional(Uuid),
          from: Type.Optional(Type.String()),
          to: Type.Optional(Type.String()),
          groupBy: Type.Optional(literals(COST_GROUP_BY)),
        }),
      },
    },
    async (req) => {
      const { from, to, ...rest } = req.query;
      const fromDate = parseDate(from, 'from');
      const toDate = parseDate(to, 'to');
      return getCostBreakdown(db, actorOf(req), {
        ...rest,
        ...(fromDate ? { from: fromDate } : {}),
        ...(toDate ? { to: toDate } : {}),
      } as never);
    },
  );
}
