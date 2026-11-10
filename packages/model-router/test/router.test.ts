import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, desc, eq } from 'drizzle-orm';
import {
  createModel,
  createProvider,
  EnvelopeSecretStore,
  OpenAiCompatibleAdapter,
  ProviderAdapterRegistry,
  upsertAgentModelConfig,
} from '@platform/ai-management';
import { listBudgets, upsertBudget } from '@platform/budget';
import {
  auditLogs,
  createTestDatabase,
  type DatabaseConnection,
  fallbackEvents,
  modelInvocations,
} from '@platform/db';
import { bootstrapOwner } from '@platform/iam';
import { type Actor, uuidv7 } from '@platform/shared';
import {
  BudgetBlockedError,
  InvocationHaltedError,
  previewRoute,
  type RouterDeps,
  routeAndInvoke,
  upsertRoutingPolicy,
} from '../src/index.js';

type Scripted = 'ok' | 'timeout' | 429 | 500 | 401 | 400;

/**
 * TEST-ONLY mock provider HTTP endpoint (Blueprint §20.3). Each model key has a queue of scripted
 * outcomes; an empty queue answers successfully with 1 000 input / 500 output tokens.
 */
function createScriptedFetch() {
  const script = new Map<string, Scripted[]>();
  const calls: Array<{ model: string; maxTokens: unknown }> = [];
  const fetchImpl: typeof fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    const model = String(body['model']);
    calls.push({ model, maxTokens: body['max_tokens'] });
    const outcome = script.get(model)?.shift() ?? 'ok';
    switch (outcome) {
      case 'timeout':
        throw new Error('timeout');
      case 429:
        return new Response('{"error":{"code":"rate_limit_exceeded"}}', { status: 429 });
      case 500:
        return new Response('{"error":"internal"}', { status: 500 });
      case 401:
        return new Response('{"error":{"code":"invalid_api_key"}}', { status: 401 });
      case 400:
        return new Response('{"error":"tools is not supported by this model"}', { status: 400 });
      default:
        return new Response(
          JSON.stringify({
            id: `cmpl-${model}`,
            choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: `ok from ${model}` } }],
            usage: { prompt_tokens: 1000, completion_tokens: 500 },
          }),
          { status: 200 },
        );
    }
  };
  return { fetchImpl, script, calls };
}

describe('model router — routed invocation (P4-06, P4-07) [integration]', () => {
  let conn: DatabaseConnection;
  let owner: Actor;
  let workspaceId: string;
  let deps: RouterDeps;
  const mock = createScriptedFetch();
  const sleeps: number[] = [];
  const haltCheckpoints: string[] = [];
  const models: Record<'economy' | 'standard' | 'high' | 'frontier', string> = {
    economy: '',
    standard: '',
    high: '',
    frontier: '',
  };
  const messages = [{ role: 'user' as const, content: 'Summarise the design.' }];

  beforeAll(async () => {
    conn = await createTestDatabase();
    const b = await bootstrapOwner(conn.db, {
      email: 'router-admin@example.com',
      password: 'Password-12345!',
      displayName: 'Router Admin',
    });
    workspaceId = b.workspaceId;
    owner = { type: 'user', userId: b.user.id, workspaceId };
    const secretStore = EnvelopeSecretStore.fromKey(randomBytes(32).toString('base64'), 1);
    deps = {
      db: conn.db,
      secretStore,
      registry: new ProviderAdapterRegistry([new OpenAiCompatibleAdapter(mock.fetchImpl)]),
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      onBudgetHalt: async () => {
        const id = uuidv7();
        haltCheckpoints.push(id);
        return id;
      },
    };

    const provA = await createProvider(conn.db, secretStore, owner, {
      providerKey: 'prov-a',
      displayName: 'Provider A',
      adapterType: 'openai_compatible',
      baseUrl: 'https://a.local/v1',
      apiKey: 'sk-router-test-aaaa1111',
    });
    const provB = await createProvider(conn.db, secretStore, owner, {
      providerKey: 'prov-b',
      displayName: 'Provider B',
      adapterType: 'openai_compatible',
      baseUrl: 'https://b.local/v1',
      apiKey: 'sk-router-test-bbbb2222',
    });
    const mk = async (key: keyof typeof models, providerId: string, inPrice: string, outPrice: string) => {
      const m = await createModel(conn.db, owner, {
        providerId,
        modelKey: key,
        availability: 'available',
        contextWindow: 100_000,
        maxOutputTokens: 4_000,
        qualityTier: key,
        metadataVerified: true,
        capabilities: { tool_calling: 'yes', structured_output: 'yes', reasoning: 'no' },
        pricing: { inputPerMtok: inPrice, outputPerMtok: outPrice, verified: true },
      });
      models[key] = m.id;
    };
    await mk('economy', provA.id, '0.10', '0.40');
    await mk('standard', provA.id, '1.00', '4.00');
    await mk('high', provA.id, '3.00', '12.00');
    await mk('frontier', provB.id, '10.00', '40.00');
  });

  afterAll(async () => conn.close());

  beforeEach(() => {
    mock.calls.length = 0;
    mock.script.clear();
    sleeps.length = 0;
  });

  const configure = (agentKey: string, over: Record<string, unknown> = {}) =>
    upsertAgentModelConfig(conn.db, owner, {
      scope: 'agent',
      agentKey,
      mode: 'fixed',
      primaryModelId: models.standard,
      params: { maxOutputTokens: 512 },
      ...over,
    } as never);

  const fallbackLog = (agentKey: string) =>
    conn.db
      .select()
      .from(fallbackEvents)
      .where(eq(fallbackEvents.agentKey, agentKey))
      .orderBy(fallbackEvents.createdAt, fallbackEvents.id);

  const audits = (action: string) =>
    conn.db.select().from(auditLogs).where(eq(auditLogs.action, action)).orderBy(desc(auditLogs.createdAt), desc(auditLogs.id));

  it('routes, records the ledger and writes the routing rationale to the audit log', async () => {
    await configure('writer');
    const r = await routeAndInvoke(deps, owner, { agentKey: 'Writer', messages });

    expect(r).toMatchObject({ modelKey: 'standard', providerKey: 'prov-a', estimatedCost: '0.003000' });
    expect(r.routing).toMatchObject({ mode: 'fixed', selectionReason: 'fixed_primary', fallbackUsed: false, attempts: 1 });
    expect(mock.calls).toEqual([{ model: 'standard', maxTokens: 512 }]);

    const [inv] = await conn.db.select().from(modelInvocations).where(eq(modelInvocations.id, r.invocationId));
    expect(inv).toMatchObject({ status: 'succeeded', retryCount: 0, agentKey: 'writer' });
    expect(inv!.routingExplanation).toMatchObject({
      router: 'model-router/1',
      selectedModelKey: 'standard',
      resolvedScope: 'agent',
      selectionReason: 'fixed_primary',
    });

    const [decided] = await audits('ai.routing.decided');
    expect(decided).toMatchObject({ targetType: 'model_invocation', targetId: r.invocationId });
    expect(decided!.payload).toMatchObject({ agentKey: 'writer', selectedModelKey: 'standard', mode: 'fixed' });
    expect((decided!.payload as { candidates: unknown[] }).candidates.length).toBe(1);
  });

  it('resolves a task override over the agent default and reports the precedence chain', async () => {
    const taskId = uuidv7();
    await configure('planner');
    await upsertAgentModelConfig(conn.db, owner, {
      scope: 'task',
      scopeRefId: taskId,
      agentKey: 'planner',
      mode: 'fixed',
      primaryModelId: models.high,
    });
    const viaTask = await previewRoute(conn.db, owner, { agentKey: 'planner', taskId });
    expect(viaTask.modelKey).toBe('high');
    expect(viaTask.explanation['resolvedScope']).toBe('task');
    expect((await previewRoute(conn.db, owner, { agentKey: 'planner' })).modelKey).toBe('standard');
    expect(mock.calls).toEqual([]);
  });

  it('clamps generation parameters to the workspace hard ceiling regardless of scope', async () => {
    await configure('verbose', { params: { maxOutputTokens: 3_000 } });
    await upsertRoutingPolicy(conn.db, owner, { hardCeilings: { maxOutputTokens: 1_000 } });
    try {
      const r = await routeAndInvoke(deps, owner, { agentKey: 'verbose', messages, maxOutputTokens: 3_500 });
      expect(mock.calls[0]).toEqual({ model: 'standard', maxTokens: 1_000 });
      expect(r.routing.explanation['ceilingsApplied']).toEqual(['maxOutputTokens:3500->1000']);
    } finally {
      await upsertRoutingPolicy(conn.db, owner, {});
    }
  });

  it('adaptive mode never dispatches outside the allowlist', async () => {
    await configure('analyst', {
      mode: 'adaptive',
      primaryModelId: null,
      allowlistModelIds: [models.economy, models.standard],
    });
    const r = await routeAndInvoke(deps, owner, { agentKey: 'analyst', messages, complexity: 'critical' });
    expect(r.modelKey).toBe('standard');
    expect(mock.calls.map((c) => c.model)).toEqual(['standard']);
    expect(r.routing.explanation['desiredTier']).toBe('frontier');

    // A task that requires a tier nothing in the allowlist offers halts instead of escaping the list.
    await expect(
      routeAndInvoke(deps, owner, { agentKey: 'analyst', messages, riskLevel: 'critical' }),
    ).rejects.toMatchObject({ code: 'routing_halted', haltReason: 'no_valid_model' });
    expect(mock.calls.length).toBe(1);
    const [halted] = await audits('ai.routing.halted');
    expect(halted!.payload).toMatchObject({ agentKey: 'analyst', stage: 'pre_dispatch', haltReason: 'no_valid_model' });
  });

  it('falls back on each valid trigger and logs cause, original model, fallback model and attempt count', async () => {
    await configure('coder', { fallbackModelIds: [models.high] });
    const triggers: Array<[Scripted, string, string]> = [
      [429, 'rate_limited', 'rate_limited'],
      ['timeout', 'timeout', 'timeout'],
      [500, 'unknown_error', 'model_unavailable'],
      [400, 'unsupported_capability', 'capability_mismatch'],
    ];
    for (const [outcome, errorKind, trigger] of triggers) {
      mock.calls.length = 0;
      mock.script.set('standard', [outcome]);
      const r = await routeAndInvoke(deps, owner, { agentKey: 'coder', messages });
      expect(r.modelKey, trigger).toBe('high');
      expect(r.routing, trigger).toMatchObject({ fallbackUsed: true, attempts: 2 });
      expect(mock.calls.map((c) => c.model), trigger).toEqual(['standard', 'high']);

      const log = await fallbackLog('coder');
      expect(log.at(-1), trigger).toMatchObject({
        originalModelId: models.standard,
        fallbackModelId: models.high,
        attemptCount: 1,
        triggerKind: trigger,
        allowed: true,
        haltReason: null,
      });
      const failed = await conn.db
        .select()
        .from(modelInvocations)
        .where(and(eq(modelInvocations.id, log.at(-1)!.invocationId!), eq(modelInvocations.status, 'failed')));
      expect(failed[0], trigger).toMatchObject({ errorKind, modelId: models.standard });
      const [ok] = await conn.db.select().from(modelInvocations).where(eq(modelInvocations.id, r.invocationId));
      expect(ok!.retryCount, trigger).toBe(1);
    }
    expect((await fallbackLog('coder')).length).toBe(4);
    const [fb] = await audits('ai.routing.fallback');
    expect(fb!.payload).toMatchObject({ originalModelKey: 'standard', fallbackModelKey: 'high', attemptCount: 1 });
  });

  it('retries the same model within maxRetries before any switch', async () => {
    await configure('patient', { fallbackModelIds: [models.high], limits: { maxRetries: 2 } });
    mock.script.set('standard', ['timeout', 429]);
    const r = await routeAndInvoke(deps, owner, { agentKey: 'patient', messages });
    expect(r.modelKey).toBe('standard');
    expect(r.routing).toMatchObject({ fallbackUsed: false, attempts: 3 });
    expect(sleeps).toEqual([250, 500]);
    expect(await fallbackLog('patient')).toEqual([]);
  });

  it('halts without switching on authentication failure', async () => {
    await configure('locked', { fallbackModelIds: [models.high] });
    mock.script.set('standard', [401]);
    const err = await routeAndInvoke(deps, owner, { agentKey: 'locked', messages }).catch((e) => e);
    expect(err).toBeInstanceOf(InvocationHaltedError);
    expect(err).toMatchObject({ status: 502, haltReason: 'authentication_failed' });
    expect(mock.calls.map((c) => c.model)).toEqual(['standard']);
    expect((await fallbackLog('locked'))[0]).toMatchObject({
      allowed: false,
      haltReason: 'authentication_failed',
      fallbackModelId: null,
      triggerKind: 'authentication_failed',
    });
  });

  it('halts when the fallback is outside the allowlist', async () => {
    await configure('strict', { allowlistModelIds: [models.standard], fallbackModelIds: [models.high] });
    mock.script.set('standard', [429]);
    await expect(routeAndInvoke(deps, owner, { agentKey: 'strict', messages })).rejects.toMatchObject({
      haltReason: 'fallback_outside_allowlist',
    });
    expect(mock.calls.map((c) => c.model)).toEqual(['standard']);
  });

  it('halts when the fallback violates the minimum quality tier', async () => {
    await configure('auditor', { primaryModelId: models.high, fallbackModelIds: [models.economy] });
    mock.script.set('high', [500]);
    await expect(
      routeAndInvoke(deps, owner, { agentKey: 'auditor', messages, taskKind: 'security_analysis' }),
    ).rejects.toMatchObject({ haltReason: 'fallback_below_min_quality_tier' });
    expect(mock.calls.map((c) => c.model)).toEqual(['high']);
  });

  it('halts when no fallback has the mandatory capability, and when the chain runs out', async () => {
    const [provider] = await conn.db.select().from(modelInvocations).limit(1);
    const legacy = await createModel(conn.db, owner, {
      providerId: provider!.providerId,
      modelKey: 'legacy-no-tools',
      availability: 'available',
      qualityTier: 'standard',
      capabilities: { tool_calling: 'no' },
    });
    await configure('toolsmith', { fallbackModelIds: [legacy.id] });
    mock.script.set('standard', [429]);
    const tools = [{ name: 'read_file', description: 'Read a file', parametersSchema: { type: 'object' } }];
    await expect(routeAndInvoke(deps, owner, { agentKey: 'toolsmith', messages, tools })).rejects.toMatchObject({
      haltReason: 'no_capable_fallback',
    });
    expect(mock.calls.map((c) => c.model)).toEqual(['standard']);

    await configure('lonely');
    mock.script.set('standard', [429]);
    await expect(routeAndInvoke(deps, owner, { agentKey: 'lonely', messages })).rejects.toMatchObject({
      haltReason: 'fallback_chain_exhausted',
    });

    await configure('crosser', {
      fallbackModelIds: [models.frontier],
      routingPolicy: { requireApprovalForProviderChange: true },
    });
    mock.script.set('standard', [429]);
    await expect(routeAndInvoke(deps, owner, { agentKey: 'crosser', messages })).rejects.toMatchObject({
      haltReason: 'provider_change_requires_approval',
    });
  });

  it('charges budgets, halts with a checkpoint at exhaustion and blocks the next invocation', async () => {
    const taskId = uuidv7();
    await configure('spender', { fallbackModelIds: [models.high] });
    await upsertBudget(conn.db, owner, { level: 'task', scopeRefId: taskId, tokenLimit: 4_000 });
    const call = (extra: Record<string, unknown> = {}) =>
      routeAndInvoke(deps, owner, { agentKey: 'spender', taskId, messages, ...extra });

    const first = await call(); // 1 500 / 4 000 = 37.5 %
    expect(first.budget).toMatchObject({ worstBand: 'normal', haltTriggered: false, optimizeContext: false });
    const second = await call(); // 75 %
    expect(second.budget).toMatchObject({ worstBand: 'warning_70', haltTriggered: false, optimizeContext: true });
    expect(second.budget.transitions[0]).toMatchObject({ level: 'task', action: 'emit_budget_warning' });

    const third = await call(); // 112.5 % — the call itself fitted the pre-check, the budget is now spent
    expect(third.budget.haltTriggered).toBe(true);
    expect(haltCheckpoints.length).toBe(1);
    expect(third.budget.transitions[0]).toMatchObject({ newBand: 'exhausted_100', checkpointId: haltCheckpoints[0] });
    const [budget] = await listBudgets(conn.db, owner, { level: 'task', scopeRefId: taskId });
    expect(budget).toMatchObject({ halted: true, consumedTokens: 4_500, lastCheckpointId: haltCheckpoints[0] });

    mock.calls.length = 0;
    const blocked = await call({ essential: true }).catch((e) => e);
    expect(blocked).toBeInstanceOf(BudgetBlockedError);
    expect(blocked).toMatchObject({ status: 422, code: 'budget_blocked' });
    expect(blocked.extensions).toMatchObject({ reason: 'budget_exhausted', level: 'task', requiresHumanApproval: true });
    expect(mock.calls).toEqual([]); // never silently downgraded or dispatched
    const [halted] = await audits('ai.routing.halted');
    expect(halted!.payload).toMatchObject({ agentKey: 'spender', stage: 'pre_dispatch', reason: 'budget_exhausted' });

    // A human raises the limit: work resumes on the same model.
    await upsertBudget(conn.db, owner, { level: 'task', scopeRefId: taskId, tokenLimit: 20_000 });
    expect((await call()).modelKey).toBe('standard');
  });

  it('stops the fallback chain when the budget runs out mid-invocation', async () => {
    const taskId = uuidv7();
    await configure('frugal', { fallbackModelIds: [models.high] });
    await upsertBudget(conn.db, owner, { level: 'task', scopeRefId: taskId, costLimitUsd: '0.004000' });
    // standard costs at most (≈5 + 512 tokens) well under the limit; high would need $0.006+ worst case.
    mock.script.set('standard', [429]);
    await expect(routeAndInvoke(deps, owner, { agentKey: 'frugal', taskId, messages })).rejects.toMatchObject({
      haltReason: 'budget_exhausted',
    });
    expect(mock.calls.map((c) => c.model)).toEqual(['standard']);
  });
});
