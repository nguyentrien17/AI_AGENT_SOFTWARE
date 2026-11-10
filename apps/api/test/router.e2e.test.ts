import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { and, eq } from 'drizzle-orm';
import { EnvelopeSecretStore, OpenAiCompatibleAdapter, ProviderAdapterRegistry } from '@platform/ai-management';
import { auditLogs, createTestDatabase, type DatabaseConnection, modelInvocations } from '@platform/db';
import { createLogger } from '@platform/observability';
import { uuidv7 } from '@platform/shared';
import { LocalStorage } from '@platform/storage';
import { buildApp } from '../src/app.js';

/**
 * Phase 4 gate (docs/phase-0/08-roadmap.md): precedence matrix; allowlist violation blocked; fallback
 * triggers and prohibited scenarios; budget thresholds including halt + checkpoint; every invocation has
 * a routing explanation in the audit log.
 */
const PW = 'correct-horse-battery';
let dir: string;
let conn: DatabaseConnection;
let app: FastifyInstance;
let cookie: string;

/** TEST-ONLY scripted provider endpoint (Blueprint §20.3): per-model queue of HTTP statuses, default 200. */
const script = new Map<string, number[]>();
const dispatched: string[] = [];
const scriptedFetch: typeof fetch = async (_input, init) => {
  const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
  const model = String(body['model']);
  dispatched.push(model);
  const status = script.get(model)?.shift() ?? 200;
  if (status === 429) return new Response('{"error":{"code":"rate_limit_exceeded"}}', { status });
  if (status === 401) return new Response('{"error":{"code":"invalid_api_key"}}', { status });
  if (status !== 200) return new Response('{"error":"upstream"}', { status });
  return new Response(
    JSON.stringify({
      id: `cmpl-${model}`,
      choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: `ok from ${model}` } }],
      usage: { prompt_tokens: 1000, completion_tokens: 500 },
    }),
    { status: 200 },
  );
};

async function call(method: string, url: string, body?: unknown, as: string = cookie) {
  return app.inject({
    method: method as never,
    url: `/api/v1${url}`,
    headers: { cookie: as },
    ...(body !== undefined ? { payload: body as object } : {}),
  });
}
const json = (r: LightMyRequestResponse) => r.json();
const ok = async (method: string, url: string, body?: unknown) => {
  const res = await call(method, url, body);
  expect(res.statusCode, `${method} ${url} → ${res.body}`).toBeLessThan(300);
  return json(res);
};

const models: Record<string, string> = {};
let projectId: string;
let taskId: string;
const messages = [{ role: 'user', content: 'Do the work.' }];

beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'api-router-'));
  conn = await createTestDatabase();
  app = await buildApp({
    db: conn.db,
    storage: new LocalStorage(dir),
    logger: createLogger({ sink: () => undefined }),
    secretStore: EnvelopeSecretStore.fromKey(randomBytes(32).toString('base64'), 1),
    adapterRegistry: new ProviderAdapterRegistry([new OpenAiCompatibleAdapter(scriptedFetch)]),
  });
  await app.inject({
    method: 'POST',
    url: '/api/v1/auth/bootstrap',
    payload: { email: 'o@example.com', password: PW, displayName: 'O' },
  });
  const login = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { email: 'o@example.com', password: PW },
  });
  cookie = String(login.headers['set-cookie']).split(';')[0]!;

  const provider = await ok('POST', '/ai/providers', {
    providerKey: 'gate-provider',
    displayName: 'Gate Provider',
    adapterType: 'openai_compatible',
    baseUrl: 'https://gate.local/v1',
    apiKey: 'sk-gate-test-key-12345678',
  });
  const tiers = [
    ['m-global', 'economy', '0.10', '0.40'],
    ['m-agent', 'standard', '1.00', '4.00'],
    ['m-project', 'standard', '1.00', '4.00'],
    ['m-workflow', 'high', '3.00', '12.00'],
    ['m-task', 'frontier', '10.00', '40.00'],
  ] as const;
  for (const [modelKey, qualityTier, inputPerMtok, outputPerMtok] of tiers) {
    const m = await ok('POST', '/ai/models', {
      providerId: provider.id,
      modelKey,
      availability: 'available',
      contextWindow: 100_000,
      maxOutputTokens: 4_000,
      qualityTier,
      metadataVerified: true,
      capabilities: { tool_calling: 'yes', structured_output: 'yes' },
      pricing: { inputPerMtok, outputPerMtok, verified: true },
    });
    models[modelKey] = m.id;
  }
  projectId = (await ok('POST', '/projects', { key: 'gate4', name: 'Gate 4' })).id;
  taskId = (
    await ok('POST', `/projects/${projectId}/tasks`, { title: 'Build', objective: 'build it', agentRole: 'developer' })
  ).id;
});

afterAll(async () => {
  await app.close();
  await conn.close();
  await fs.rm(dir, { recursive: true, force: true });
});

beforeEach(() => {
  script.clear();
  dispatched.length = 0;
});

describe('Phase 4 gate — Model Router & Token Budget over HTTP', () => {
  it('resolves the full precedence matrix: Task > Workflow > Project > Agent > Global', async () => {
    const workflowId = uuidv7();
    const put = (body: Record<string, unknown>) => ok('PUT', '/ai/configurations', { mode: 'fixed', ...body });
    await put({ scope: 'global', primaryModelId: models['m-global'] });
    await put({ scope: 'agent', agentKey: 'developer', primaryModelId: models['m-agent'] });
    await put({ scope: 'project', scopeRefId: projectId, agentKey: 'developer', primaryModelId: models['m-project'] });
    await put({ scope: 'workflow', scopeRefId: workflowId, agentKey: 'developer', primaryModelId: models['m-workflow'] });
    await put({ scope: 'task', scopeRefId: taskId, agentKey: 'developer', primaryModelId: models['m-task'] });

    const resolve = async (agentKey: string, scope: Record<string, string>) => {
      const r = await ok('POST', '/ai/router/resolve', { agentKey, ...scope });
      return [r.modelKey, r.explanation.resolvedScope];
    };
    const matrix: Array<[string, Record<string, string>, string, string]> = [
      ['reviewer', {}, 'm-global', 'global'],
      ['developer', {}, 'm-agent', 'agent'],
      ['developer', { projectId }, 'm-project', 'project'],
      ['developer', { projectId, workflowId }, 'm-workflow', 'workflow'],
      ['developer', { workflowId }, 'm-workflow', 'workflow'],
      ['developer', { projectId, workflowId, taskId }, 'm-task', 'task'],
      ['developer', { taskId }, 'm-task', 'task'],
      // A scope configured for another agent does not leak: `reviewer` only has the global default.
      ['reviewer', { projectId, workflowId, taskId }, 'm-global', 'global'],
    ];
    for (const [agentKey, scope, modelKey, level] of matrix) {
      expect(await resolve(agentKey, scope), `${agentKey} ${Object.keys(scope).join('+') || 'none'}`).toEqual([
        modelKey,
        level,
      ]);
    }

    // Removing a level exposes the next one down, in order.
    const full = { projectId, workflowId, taskId };
    await put({ scope: 'task', scopeRefId: taskId, agentKey: 'developer', primaryModelId: models['m-task'], active: false });
    expect(await resolve('developer', full)).toEqual(['m-workflow', 'workflow']);
    await put({
      scope: 'workflow',
      scopeRefId: workflowId,
      agentKey: 'developer',
      primaryModelId: models['m-workflow'],
      active: false,
    });
    expect(await resolve('developer', full)).toEqual(['m-project', 'project']);
    await put({
      scope: 'project',
      scopeRefId: projectId,
      agentKey: 'developer',
      primaryModelId: models['m-project'],
      active: false,
    });
    expect(await resolve('developer', full)).toEqual(['m-agent', 'agent']);
    expect(dispatched).toEqual([]); // the dry-run never calls a provider
  });

  it('lets hard ceilings beat every scope, and restricts them to administrators', async () => {
    await ok('PUT', '/ai/routing-policies', {
      hardCeilings: { maxOutputTokens: 256, deniedModelIds: [models['m-agent']] },
    });
    const denied = await call('POST', '/ai/router/resolve', { agentKey: 'developer' });
    expect(denied.statusCode).toBe(422);
    expect(json(denied)).toMatchObject({ code: 'routing_halted', haltReason: 'primary_model_rejected' });

    await ok('PUT', '/ai/routing-policies', { hardCeilings: { maxOutputTokens: 256 } });
    const clamped = await ok('POST', '/ai/router/resolve', { agentKey: 'developer', maxOutputTokens: 9_000 });
    expect(clamped.effectiveParams.maxOutputTokens).toBe(256);
    expect(clamped.explanation.ceilingsApplied).toEqual(['maxOutputTokens:9000->256']);
    await ok('PUT', '/ai/routing-policies', {});
    expect((await ok('GET', '/ai/routing-policies')).hardCeilings).toEqual({});

    await ok('POST', '/users', { email: 'pm@example.com', displayName: 'PM', password: PW, role: 'project_manager' });
    const pmLogin = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: 'pm@example.com', password: PW },
    });
    const pm = String(pmLogin.headers['set-cookie']).split(';')[0]!;
    expect((await call('PUT', '/ai/routing-policies', { hardCeilings: {} }, pm)).statusCode).toBe(403);
    expect((await call('PUT', '/budgets', { level: 'system', tokenLimit: 10 }, pm)).statusCode).toBe(403);
    expect((await call('GET', '/budgets', undefined, pm)).statusCode).toBe(200);
  });

  it('blocks allowlist violations instead of escaping the list', async () => {
    await ok('PUT', '/ai/configurations', {
      scope: 'agent',
      agentKey: 'analyst',
      mode: 'adaptive',
      allowlistModelIds: [models['m-global'], models['m-agent']],
    });
    const best = await ok('POST', '/ai/invocations', { agentKey: 'analyst', complexity: 'critical', messages });
    expect(best.modelKey).toBe('m-agent');
    expect(best.routing.explanation.desiredTier).toBe('frontier');

    const halted = await call('POST', '/ai/invocations', { agentKey: 'analyst', riskLevel: 'critical', messages });
    expect(halted.statusCode).toBe(422);
    expect(json(halted)).toMatchObject({ code: 'routing_halted', haltReason: 'no_valid_model' });
    expect(dispatched).toEqual(['m-agent']);
  });

  it('falls back on a valid trigger, halts on prohibited ones, and exposes the fallback log', async () => {
    await ok('PUT', '/ai/configurations', {
      scope: 'agent',
      agentKey: 'coder',
      mode: 'hybrid',
      primaryModelId: models['m-agent'],
      allowlistModelIds: [models['m-agent'], models['m-workflow']],
      fallbackModelIds: [models['m-workflow'], models['m-task']],
      params: { maxOutputTokens: 512 },
    });

    script.set('m-agent', [429]);
    const switched = await ok('POST', '/ai/invocations', { agentKey: 'coder', messages });
    expect(switched).toMatchObject({ modelKey: 'm-workflow', routing: { fallbackUsed: true, attempts: 2 } });

    script.set('m-agent', [401]);
    const auth = await call('POST', '/ai/invocations', { agentKey: 'coder', messages });
    expect(auth.statusCode).toBe(502);
    expect(json(auth)).toMatchObject({ code: 'invocation_halted', haltReason: 'authentication_failed' });

    // First fallback also fails; the next one (m-task) is outside the allowlist → halt, never dispatched.
    script.set('m-agent', [503]);
    script.set('m-workflow', [503]);
    dispatched.length = 0;
    const outside = await call('POST', '/ai/invocations', { agentKey: 'coder', messages });
    expect(json(outside)).toMatchObject({ code: 'invocation_halted', haltReason: 'fallback_outside_allowlist' });
    expect(dispatched).toEqual(['m-agent', 'm-workflow']);

    const log = (await ok('GET', '/ai/fallback-events?agentKey=coder')).items as Array<Record<string, unknown>>;
    expect(log.map((e) => [e['triggerKind'], e['allowed'], e['haltReason']])).toEqual([
      ['model_unavailable', false, 'fallback_outside_allowlist'],
      ['model_unavailable', true, null],
      ['authentication_failed', false, 'authentication_failed'],
      ['rate_limited', true, null],
    ]);
    expect(log[3]).toMatchObject({
      originalModelId: models['m-agent'],
      fallbackModelId: models['m-workflow'],
      attemptCount: 1,
    });
  });

  it('enforces budget thresholds, halts with a real project checkpoint, and resumes on human approval', async () => {
    await ok('PUT', '/ai/configurations', {
      scope: 'agent',
      agentKey: 'builder',
      mode: 'fixed',
      primaryModelId: models['m-agent'],
      params: { maxOutputTokens: 512 },
    });
    const budget = await ok('PUT', '/budgets', { level: 'project', scopeRefId: projectId, tokenLimit: 4_000 });
    expect(budget).toMatchObject({ currentBand: 'normal', halted: false, remainingTokens: 4_000 });
    const invoke = () => call('POST', '/ai/invocations', { agentKey: 'builder', projectId, messages });

    expect(json(await invoke()).budget).toMatchObject({ worstBand: 'normal', haltTriggered: false });
    expect(json(await invoke()).budget).toMatchObject({ worstBand: 'warning_70', optimizeContext: true });
    const third = json(await invoke());
    expect(third.budget.haltTriggered).toBe(true);
    const checkpointId = third.budget.transitions[0].checkpointId;
    expect(checkpointId).toBeTruthy();

    const checkpoints = (await ok('GET', `/projects/${projectId}/checkpoints`)).items;
    expect(checkpoints[0]).toMatchObject({ id: checkpointId, label: 'budget-halt:project' });
    const verified = await ok('GET', `/checkpoints/${checkpointId}`);
    expect(verified.verification.valid).toBe(true);
    expect(verified.checkpoint).toMatchObject({ createdById: 'budget-manager', createdByType: 'system' });
    expect(verified.checkpoint.state.extra).toMatchObject({ reason: 'budget_halt', level: 'project' });

    const [halted] = (await ok('GET', `/budgets?level=project&scopeRefId=${projectId}`)).items;
    expect(halted).toMatchObject({ halted: true, currentBand: 'exhausted_100', lastCheckpointId: checkpointId });
    const events = (await ok('GET', `/budgets/${budget.id}/events`)).items;
    expect(events.map((e: { newBand: string }) => e.newBand)).toEqual(['exhausted_100', 'warning_70']);

    dispatched.length = 0;
    const blocked = await invoke();
    expect(blocked.statusCode).toBe(422);
    expect(json(blocked)).toMatchObject({
      code: 'budget_blocked',
      reason: 'budget_exhausted',
      level: 'project',
      requiresHumanApproval: true,
    });
    expect(dispatched).toEqual([]);

    const raised = await ok('PUT', '/budgets', { level: 'project', scopeRefId: projectId, tokenLimit: 100_000 });
    expect(raised).toMatchObject({ halted: false, currentBand: 'normal' });
    expect((await invoke()).statusCode).toBe(200);
  });

  it('writes a routing explanation to the audit log for every agent invocation', async () => {
    const invocations = await conn.db.select().from(modelInvocations).where(eq(modelInvocations.purpose, 'agent'));
    expect(invocations.length).toBeGreaterThanOrEqual(10);
    for (const inv of invocations) {
      expect(inv.routingExplanation, inv.id).toMatchObject({ router: 'model-router/1' });
    }

    const audited = async (action: string) =>
      new Set(
        (
          await conn.db
            .select({ id: auditLogs.targetId })
            .from(auditLogs)
            .where(and(eq(auditLogs.action, action), eq(auditLogs.targetType, 'model_invocation')))
        ).map((r) => r.id),
      );
    const decided = await audited('ai.routing.decided');
    const fellBack = await audited('ai.routing.fallback');
    const halted = await audited('ai.routing.halted');
    for (const inv of invocations) {
      const covered = inv.status === 'succeeded' ? decided.has(inv.id) : fellBack.has(inv.id) || halted.has(inv.id);
      expect(covered, `${inv.status} invocation ${inv.id}`).toBe(true);
    }
    const [sample] = await conn.db.select().from(auditLogs).where(eq(auditLogs.action, 'ai.routing.decided')).limit(1);
    expect(sample!.payload).toMatchObject({
      router: 'model-router/1',
      mode: expect.any(String),
      selectionReason: expect.any(String),
      candidates: expect.any(Array),
      precedenceChain: expect.any(Array),
    });
    expect(JSON.stringify(sample!.payload)).not.toContain('sk-gate-test-key');
  });

  it('serves usage & cost analytics with drill-down filters', async () => {
    const all = await ok('GET', '/ai/costs/breakdown?groupBy=model');
    expect(all.groupBy).toBe('model');
    expect(all.totals.invocations).toBe(all.totals.succeeded + all.totals.failed);
    expect(all.totals.actualCostUsd).toBeNull(); // never fabricated
    const byKey = Object.fromEntries(all.groups.map((g: { label: string }) => [g.label, g]));
    // m-agent succeeded with 1 000 in / 500 out at $1 / $4 per Mtok = $0.003 per call
    expect(Number(byKey['m-agent'].estimatedCostUsd)).toBeCloseTo(byKey['m-agent'].succeeded * 0.003, 6);
    expect(byKey['m-agent'].inputTokens).toBe(byKey['m-agent'].succeeded * 1000);

    const builder = await ok('GET', `/ai/costs/breakdown?agentKey=builder&projectId=${projectId}&groupBy=agent`);
    expect(builder.groups).toHaveLength(1);
    expect(builder.groups[0]).toMatchObject({ key: 'builder', succeeded: 4, failed: 0, estimatedCostUsd: '0.012000' });
    expect(builder.filter).toEqual({ agentKey: 'builder', projectId });

    const future = await ok('GET', `/ai/costs/breakdown?from=${encodeURIComponent('2999-01-01T00:00:00Z')}`);
    expect(future.totals.invocations).toBe(0);
    expect((await call('GET', '/ai/costs/breakdown?from=not-a-date')).statusCode).toBe(400);
    expect((await ok('GET', '/ai/costs/breakdown?groupBy=day')).groups.length).toBeGreaterThanOrEqual(1);
  });
});
