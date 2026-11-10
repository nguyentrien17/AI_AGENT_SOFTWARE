import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { EnvelopeSecretStore, OpenAiCompatibleAdapter, ProviderAdapterRegistry } from '@platform/ai-management';
import { createTestDatabase, type DatabaseConnection } from '@platform/db';
import { createLogger } from '@platform/observability';
import { createAgentTaskExecutor, drainWorker } from '@platform/orchestration';
import { LocalStorage } from '@platform/storage';
import { buildApp } from '../src/app.js';

/** Phase 5 HTTP surface: agents, workflows, runs, approvals, executions, events + SSE. */
const PW = 'correct-horse-battery';
const AGENT_LIBRARY = fileURLToPath(new URL('../../../agent-library', import.meta.url));
let dir: string;
let conn: DatabaseConnection;
let app: FastifyInstance;
let cookie: string;
let registry: ProviderAdapterRegistry;
let secretStore: EnvelopeSecretStore;
let storage: LocalStorage;

/** TEST-ONLY scripted model (Blueprint §20.3): answers each agent role with a valid envelope. */
const ARTIFACT: Record<string, [string, Record<string, unknown>]> = {
  ba: [
    '.ai-context/01-requirements/overview.md',
    { user_stories: [{ id: 'US-1', story: 'log in', acceptance_criteria: ['session opens'] }], business_rules: [] },
  ],
  architect: [
    '.ai-context/02-architecture/overview.md',
    { components: [{ name: 'api', responsibility: 'serve' }], tech_stack: ['TypeScript'] },
  ],
  review: ['.ai-context/07-quality/review-reports/review.md', { verdict: 'approved', findings: [] }],
};
const scriptedFetch: typeof fetch = async (_input, init) => {
  const body = String(init?.body ?? '{}');
  const role = /You act as the '([a-z_]+)' agent/.exec(body)?.[1] ?? 'ba';
  const [artifactPath, result] = ARTIFACT[role]!;
  const envelope = {
    status: 'completed',
    summary: `${role} done`,
    artifacts: [{ path: artifactPath, type: 'doc', content: `# ${role}\n` }],
    handoff: { decisions: [], assumptions: [], open_questions: [], required_actions: [] },
    result,
  };
  return new Response(
    JSON.stringify({
      id: 'cmpl',
      choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify(envelope) } }],
      usage: { prompt_tokens: 100, completion_tokens: 50 },
    }),
    { status: 200 },
  );
};

async function call(method: string, url: string, body?: unknown) {
  return app.inject({
    method: method as never,
    url: `/api/v1${url}`,
    headers: { cookie },
    ...(body !== undefined ? { payload: body as object } : {}),
  });
}
const ok = async (method: string, url: string, body?: unknown) => {
  const res = await call(method, url, body);
  expect(res.statusCode, `${method} ${url} → ${res.body}`).toBeLessThan(300);
  return res.json();
};
const json = (r: LightMyRequestResponse) => r.json();

beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'api-wf-'));
  conn = await createTestDatabase();
  storage = new LocalStorage(dir);
  secretStore = EnvelopeSecretStore.fromKey(randomBytes(32).toString('base64'), 1);
  registry = new ProviderAdapterRegistry([new OpenAiCompatibleAdapter(scriptedFetch)]);
  app = await buildApp({
    db: conn.db,
    storage,
    logger: createLogger({ sink: () => undefined }),
    secretStore,
    adapterRegistry: registry,
    agentLibraryDir: AGENT_LIBRARY,
    initGit: false,
  });
  await app.inject({ method: 'POST', url: '/api/v1/auth/bootstrap', payload: { email: 'o@example.com', password: PW, displayName: 'O' } });
  const login = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email: 'o@example.com', password: PW } });
  cookie = String(login.headers['set-cookie']).split(';')[0]!;

  const provider = await ok('POST', '/ai/providers', {
    providerKey: 'wf-provider',
    displayName: 'WF',
    adapterType: 'openai_compatible',
    baseUrl: 'https://wf.local/v1',
    apiKey: 'sk-wf-test-key-12345678',
  });
  const model = await ok('POST', '/ai/models', {
    providerId: provider.id,
    modelKey: 'wf-model',
    availability: 'available',
    qualityTier: 'high',
    capabilities: { structured_output: 'yes' },
  });
  await ok('PUT', '/ai/configurations', { scope: 'global', mode: 'fixed', primaryModelId: model.id });
});

afterAll(async () => {
  await app.close();
  await conn.close();
  await fs.rm(dir, { recursive: true, force: true });
});

describe('Phase 5 — workflow API', () => {
  it('runs a workflow end to end over HTTP, including the approval gate and the event stream', async () => {
    const seeded = (await ok('POST', '/agents/seed')).items;
    expect(seeded.map((s: { outcome: string }) => s.outcome)).toEqual(['created', 'created', 'created', 'created']);
    const agents = (await ok('GET', '/agents')).items;
    const ba = agents.find((a: { agentKey: string }) => a.agentKey === 'ba');
    const v = ba.currentVersion;
    const sameDefinition = {
      systemInstruction: v.systemInstruction,
      inputSchema: v.inputSchema,
      outputSchema: v.outputSchema,
      allowedTools: v.allowedTools,
      allowedFileScopes: v.allowedFileScopes,
      allowedActions: v.allowedActions,
      timeoutSeconds: v.timeoutSeconds,
      retryPolicy: v.retryPolicy,
      completionCriteria: v.completionCriteria,
    };
    const republished = await call('POST', `/agents/${ba.id}/versions`, sameDefinition);
    expect(republished.statusCode).toBe(200); // identical definition: no new version
    expect(json(republished)).toMatchObject({ created: false, versionNo: 1 });
    const changed = await call('POST', `/agents/${ba.id}/versions`, { ...sameDefinition, timeoutSeconds: 300 });
    expect(changed.statusCode).toBe(201);
    expect(json(changed)).toMatchObject({ created: true, versionNo: 2 });

    const bad = await call('POST', '/workflows', {
      key: 'loop',
      name: 'Loop',
      definition: { stages: [
        { key: 'a', agentKey: 'ba', title: 'A', objective: 'a', dependsOn: ['b'] },
        { key: 'b', agentKey: 'ba', title: 'B', objective: 'b', dependsOn: ['a'] },
      ] },
    });
    expect(bad.statusCode).toBe(400);

    const { workflow } = await ok('POST', '/workflows', {
      key: 'mini-sdlc',
      name: 'Mini SDLC',
      definition: {
        stages: [
          { key: 'requirements', agentKey: 'ba', title: 'Requirements', objective: 'Analyse', nextAgent: 'architect' },
          { key: 'design', agentKey: 'architect', title: 'Design', objective: 'Design', dependsOn: ['requirements'], approval: 'human' },
          { key: 'review', agentKey: 'review', title: 'Review', objective: 'Review', dependsOn: ['design'] },
        ],
      },
    });
    const projectId = (await ok('POST', '/projects', { key: 'wfapi', name: 'WF API' })).id;
    const { run } = await ok('POST', `/projects/${projectId}/workflow-runs`, { workflowId: workflow.id });
    expect(run.status).toBe('running');

    const sched = {
      db: conn.db,
      executor: createAgentTaskExecutor({ db: conn.db, storage, secretStore, registry, sleep: async () => undefined }),
    };
    expect((await drainWorker(sched, 'api-test')).map((t) => t.outcome)).toEqual(['completed', 'waiting_for_approval']);

    const [approval] = (await ok('GET', `/projects/${projectId}/approvals?status=pending`)).items;
    expect(approval.kind).toBe('workflow_gate');
    const noComment = await call('POST', `/approvals/${approval.id}/decision`, { decision: 'rejected' });
    expect(noComment.statusCode).toBe(400);
    await ok('POST', `/approvals/${approval.id}/decision`, { decision: 'approved' });
    const again = await call('POST', `/approvals/${approval.id}/decision`, { decision: 'approved' });
    expect(again.statusCode).toBe(409);

    expect((await drainWorker(sched, 'api-test')).map((t) => t.outcome)).toEqual(['completed']);
    const detail = await ok('GET', `/workflow-runs/${run.id}`);
    expect(detail.run.status).toBe('completed');
    expect(detail.steps.map((s: { status: string }) => s.status)).toEqual(['completed', 'completed', 'completed']);

    const executions = (await ok('GET', `/tasks/${detail.steps[1].taskId}/executions`)).items;
    expect(executions).toHaveLength(1);
    expect(executions[0]).toMatchObject({ attemptNo: 1, status: 'succeeded', workerId: 'api-test' });

    // Event feed + SSE resume cursor.
    const events = (await ok('GET', `/projects/${projectId}/events?limit=500`)).items;
    expect(events.map((e: { type: string }) => e.type)).toContain('workflow.run_completed');
    const sse = await app.inject({
      method: 'GET',
      url: `/api/v1/projects/${projectId}/events/stream?follow=false`,
      headers: { cookie, 'last-event-id': events[events.length - 3].id },
    });
    expect(sse.statusCode).toBe(200);
    expect(sse.headers['content-type']).toMatch(/^text\/event-stream/);
    const frames = sse.body.trim().split('\n\n');
    expect(frames).toHaveLength(2);
    expect(frames[1]).toContain(`id: ${events[events.length - 1].id}`);
    expect(frames[1]).toContain(`event: ${events[events.length - 1].type}`);
  });

  it('pauses, resumes and cancels runs over HTTP, and denies unauthenticated access to the stream', async () => {
    const { workflow } = await ok('POST', '/workflows', {
      key: 'solo',
      name: 'Solo',
      definition: { stages: [{ key: 'only', agentKey: 'ba', title: 'Only', objective: 'x' }] },
    });
    const projectId = (await ok('POST', '/projects', { key: 'wfapi2', name: 'WF API 2' })).id;
    const { run } = await ok('POST', `/projects/${projectId}/workflow-runs`, { workflowId: workflow.id });
    expect((await ok('POST', `/workflow-runs/${run.id}/pause`, { reason: 'hold' })).status).toBe('paused');
    expect((await ok('POST', `/workflow-runs/${run.id}/resume`)).status).toBe('running');
    expect((await ok('POST', `/workflow-runs/${run.id}/cancel`, { reason: 'drop' })).status).toBe('cancelled');
    expect((await call('POST', `/workflow-runs/${run.id}/resume`)).statusCode).toBe(409);
    expect((await ok('GET', `/projects/${projectId}/workflow-runs`)).items).toHaveLength(1);

    const anonymous = await app.inject({ method: 'GET', url: `/api/v1/projects/${projectId}/events/stream?follow=false` });
    expect(anonymous.statusCode).toBe(401);
  });
});
