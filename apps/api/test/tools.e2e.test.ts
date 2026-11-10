import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { EnvelopeSecretStore, OpenAiCompatibleAdapter, ProviderAdapterRegistry } from '@platform/ai-management';
import { createTestDatabase, type DatabaseConnection } from '@platform/db';
import { createLogger } from '@platform/observability';
import { createAgentTaskExecutor, drainWorker, type SchedulerDeps } from '@platform/orchestration';
import { LocalStorage } from '@platform/storage';
import { MAX_TOOL_CALLS_PER_ATTEMPT } from '@platform/agent-runtime';
import { createDefaultToolCatalog, syncToolRegistry } from '@platform/tool-executor';
import { buildApp } from '../src/app.js';

/**
 * Phase 6 part A end to end: a developer agent edits code through the Tool Executor inside its task
 * worktree; denied calls are reported back to the model; tool loops are bounded.
 */
const PW = 'correct-horse-battery';
let dir: string;
let conn: DatabaseConnection;
let app: FastifyInstance;
let cookie: string;
let sched: SchedulerDeps;
const sentBodies: Array<{ messages: Array<Record<string, unknown>>; tools?: Array<{ function: { name: string } }> }> = [];

const final = {
  status: 'completed',
  summary: 'Implemented greeting',
  artifacts: [],
  handoff: { decisions: ['added greet()'], assumptions: [], open_questions: [], required_actions: ['review the diff'] },
  result: {},
};

/** TEST-ONLY scripted model (Blueprint §20.3): the next step depends on how many tool results it has seen. */
const scriptedFetch: typeof fetch = async (_input, init) => {
  const body = JSON.parse(String(init?.body ?? '{}')) as (typeof sentBodies)[number];
  sentBodies.push(body);
  const objective = JSON.stringify(body.messages);
  const toolResults = body.messages.filter((m) => m['role'] === 'tool').length;
  const call = (name: string, args: Record<string, unknown>) => ({
    choices: [
      {
        finish_reason: 'tool_calls',
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [{ id: `call_${toolResults}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }],
        },
      },
    ],
    usage: { prompt_tokens: 50, completion_tokens: 10 },
  });
  let reply: unknown;
  if (objective.includes('Loop forever')) {
    reply = call('git_status', {});
  } else if (toolResults === 0) {
    reply = call('fs_write_file', { path: 'source-code/greet.ts', content: 'export const greet = (n: string) => `hi ${n}`;\n' });
  } else if (toolResults === 1) {
    reply = call('fs_read_file', { path: '../../../../outside.txt' });
  } else if (toolResults === 2) {
    reply = call('git_commit', { message: 'feat: greet' });
  } else {
    reply = {
      choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify(final) } }],
      usage: { prompt_tokens: 50, completion_tokens: 10 },
    };
  }
  return new Response(JSON.stringify(reply), { status: 200 });
};

async function call(method: string, url: string, body?: unknown) {
  const res = await app.inject({
    method: method as never,
    url: `/api/v1${url}`,
    headers: { cookie },
    ...(body !== undefined ? { payload: body as object } : {}),
  });
  return res;
}
const ok = async (method: string, url: string, body?: unknown) => {
  const res = await call(method, url, body);
  expect(res.statusCode, `${method} ${url} → ${res.body}`).toBeLessThan(300);
  return res.json();
};

beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'api-tools-'));
  conn = await createTestDatabase();
  const storage = new LocalStorage(dir);
  const secretStore = EnvelopeSecretStore.fromKey(randomBytes(32).toString('base64'), 1);
  const registry = new ProviderAdapterRegistry([new OpenAiCompatibleAdapter(scriptedFetch)]);
  const toolCatalog = createDefaultToolCatalog();
  await syncToolRegistry(conn.db, toolCatalog);
  app = await buildApp({
    db: conn.db,
    storage,
    logger: createLogger({ sink: () => undefined }),
    secretStore,
    adapterRegistry: registry,
    toolCatalog,
  });
  await app.inject({ method: 'POST', url: '/api/v1/auth/bootstrap', payload: { email: 'o@example.com', password: PW, displayName: 'O' } });
  const login = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email: 'o@example.com', password: PW } });
  cookie = String(login.headers['set-cookie']).split(';')[0]!;

  const provider = await ok('POST', '/ai/providers', {
    providerKey: 'tools-provider',
    displayName: 'Tools',
    adapterType: 'openai_compatible',
    baseUrl: 'https://tools.local/v1',
    apiKey: 'sk-tools-test-12345678',
  });
  const model = await ok('POST', '/ai/models', {
    providerId: provider.id,
    modelKey: 'coder',
    availability: 'available',
    qualityTier: 'high',
    capabilities: { structured_output: 'yes', tool_calling: 'yes' },
  });
  await ok('PUT', '/ai/configurations', { scope: 'global', mode: 'fixed', primaryModelId: model.id });
  await ok('POST', '/agents', {
    agentKey: 'developer',
    name: 'Developer',
    role: 'developer',
    definition: {
      systemInstruction: 'Implement the task in source-code/ and commit it.',
      allowedTools: ['fs_read_file', 'fs_write_file', 'fs_list_dir', 'git_status', 'git_diff', 'git_commit'],
      allowedActions: ['read_file', 'write_file', 'git_read', 'git_commit'],
      allowedFileScopes: ['source-code/**', 'tests/**'],
    },
  });
  sched = {
    db: conn.db,
    executor: createAgentTaskExecutor({
      db: conn.db,
      storage,
      secretStore,
      registry,
      sleep: async () => undefined,
      tools: { storageRoot: storage.root, catalog: toolCatalog },
    }),
  };
});

afterAll(async () => {
  await app.close();
  await conn.close();
  await fs.rm(dir, { recursive: true, force: true });
});

describe('Phase 6 part A — agents use tools through the Tool Executor', () => {
  it('lists the tool catalog', async () => {
    const tools = (await ok('GET', '/tools')).items;
    expect(tools.map((t: { toolKey: string }) => t.toolKey)).toContain('fs_write_file');
    expect(tools.every((t: { requiresSandbox: boolean }) => t.requiresSandbox === false)).toBe(true);
  });

  it('a developer agent writes, is refused outside its workspace, commits, and the diff is reviewable', async () => {
    const { workflow } = await ok('POST', '/workflows', {
      key: 'dev',
      name: 'Dev',
      definition: { stages: [{ key: 'implement', agentKey: 'developer', title: 'Implement greet', objective: 'Add greet()' }] },
    });
    const projectId = (await ok('POST', '/projects', { key: 'toolsapi', name: 'Tools API' })).id;
    const { run } = await ok('POST', `/projects/${projectId}/workflow-runs`, { workflowId: workflow.id });
    sentBodies.length = 0;

    expect((await drainWorker(sched, 'tools-worker')).map((t) => t.outcome)).toEqual(['completed']);
    const detail = await ok('GET', `/workflow-runs/${run.id}`);
    expect(detail.run.status).toBe('completed');
    const taskId = detail.steps[0].taskId;

    // Tools were offered, and every tool result was replayed with the call that produced it.
    expect(sentBodies[0]!.tools!.map((t) => t.function.name).sort()).toEqual([
      'fs_list_dir',
      'fs_read_file',
      'fs_write_file',
      'git_commit',
      'git_diff',
      'git_status',
    ]);
    const last = sentBodies.at(-1)!.messages;
    const toolMsgs = last.filter((m) => m['role'] === 'tool');
    expect(toolMsgs).toHaveLength(3);
    for (const m of toolMsgs) {
      const i = last.indexOf(m);
      const prevAssistant = last.slice(0, i).reverse().find((x) => x['role'] === 'assistant')!;
      expect((prevAssistant['tool_calls'] as Array<{ id: string }>).map((c) => c.id)).toContain(m['tool_call_id']);
    }
    // The model saw why its escape attempt was refused.
    expect(String(toolMsgs[1]!['content'])).toContain('path_rejected');

    const executions = (await ok('GET', `/tasks/${taskId}/tool-executions`)).items;
    expect(executions.map((e: { toolKey: string; status: string }) => `${e.toolKey}:${e.status}`)).toEqual([
      'fs_write_file:succeeded',
      'fs_read_file:denied',
      'git_commit:succeeded',
    ]);

    const diff = await ok('GET', `/tasks/${taskId}/workspace/diff`);
    expect(diff).toMatchObject({ branch: `task/${taskId}`, baseBranch: 'main', files: ['source-code/greet.ts'] });
    expect(diff.diff).toContain('+export const greet');
    expect((await call('GET', `/tasks/${detail.steps[0].taskId.replace(/.$/, '0')}/workspace/diff`)).statusCode).toBe(404);

    // P8-06 lineage answers the Blueprint §17 audit questions for this task.
    const lineage = await ok('GET', `/tasks/${taskId}/lineage`);
    expect(lineage.why).toMatchObject({ objective: 'Add greet()', stage: { key: 'implement' }, workflowRun: { id: run.id } });
    expect(lineage.scheduledBy.runStartedBy).toMatchObject({ type: 'user' });
    expect(lineage.scheduledBy.transitions.map((t: { to: string }) => t.to)).toEqual(['pending', 'ready', 'assigned', 'running', 'completed']);
    expect(lineage.executions[0]).toMatchObject({ attemptNo: 1, status: 'succeeded', agentKey: 'developer', agentVersion: 1 });
    expect(lineage.modelInvocations.length).toBe(4);
    expect(lineage.modelInvocations[0]).toMatchObject({ providerKey: 'tools-provider', modelKey: 'coder', routingExplanation: { router: 'model-router/1' } });
    expect(lineage.contextPackages).toHaveLength(1);
    expect(lineage.toolCalls.map((t: { toolKey: string; status: string }) => `${t.toolKey}:${t.status}`)).toEqual([
      'fs_write_file:succeeded',
      'fs_read_file:denied',
      'git_commit:succeeded',
    ]);
    expect(lineage.changes.workspace.files).toEqual(['source-code/greet.ts']);
    expect(lineage.changes.handoffs).toHaveLength(1);
    expect(Array.isArray(lineage.qualityGates)).toBe(true);
    expect(lineage.approvals).toEqual([]);
  });

  it('stops an agent that loops on tool calls', async () => {
    const { workflow } = await ok('POST', '/workflows', {
      key: 'loop',
      name: 'Loop',
      definition: { stages: [{ key: 'spin', agentKey: 'developer', title: 'Spin', objective: 'Loop forever', maxRetries: 0 }] },
    });
    const projectId = (await ok('POST', '/projects', { key: 'toolsloop', name: 'Loop' })).id;
    await ok('POST', `/projects/${projectId}/workflow-runs`, { workflowId: workflow.id });
    sentBodies.length = 0;
    const [tick] = await drainWorker(sched, 'tools-worker');
    expect(tick).toMatchObject({ outcome: 'failed' });
    expect(tick!.error).toMatch(new RegExp(`exceeded ${MAX_TOOL_CALLS_PER_ATTEMPT} tool calls`));
    expect(sentBodies.length).toBe(MAX_TOOL_CALLS_PER_ATTEMPT + 1);
  });
});
