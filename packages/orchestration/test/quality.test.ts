import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { createAgent } from '@platform/agent-runtime';
import {
  createModel,
  createProvider,
  EnvelopeSecretStore,
  OpenAiCompatibleAdapter,
  ProviderAdapterRegistry,
  upsertAgentModelConfig,
} from '@platform/ai-management';
import {
  approvals,
  createTestDatabase,
  type DatabaseConnection,
  projects,
  qualityGateEvaluations,
  systemEvents,
  tasks,
  toolExecutions,
  toolPermissions,
  workflowSteps,
} from '@platform/db';
import { bootstrapOwner } from '@platform/iam';
import { createProject } from '@platform/projects';
import type { Actor } from '@platform/shared';
import { LocalStorage } from '@platform/storage';
import {
  type AnyToolDefinition,
  createDefaultToolCatalog,
  integrationWorktreeDir,
  resolveToolApproval,
  runGit,
  syncToolRegistry,
  ToolCatalog,
} from '@platform/tool-executor';
import {
  createAgentTaskExecutor,
  createWorkflow,
  decideApproval,
  drainWorker,
  getWorkflowRun,
  type SchedulerDeps,
  startWorkflowRun,
  type WorkflowDefinition,
} from '../src/index.js';

/** P8-01 / P8-02 / P7-08 with a real git repository: gates gate completion, integration merges branches. */
const AWS = ['AKIA', 'Q3EGRAVEZ7WN4PLK'].join(''); // assembled at runtime: no literal key in the repo

/** TEST-ONLY scripted developer model (Blueprint §20.3). */
function plan(title: string, sawGateFailure: boolean): { path: string; content: string } {
  switch (title) {
    case 'Leaky feature':
      return sawGateFailure
        ? { path: 'source-code/config.ts', content: 'export const awsKeyId = process.env.AWS_ACCESS_KEY_ID;\n' }
        : { path: 'source-code/config.ts', content: `export const awsKeyId = "${AWS}";\n` };
    case 'Feature A':
      return { path: 'source-code/a.ts', content: 'export const a = 1;\n' };
    case 'Feature B':
      return { path: 'source-code/b.ts', content: 'export const b = 2;\n' };
    case 'Variant X':
      return { path: 'source-code/shared.ts', content: 'export const mode = "x";\n' };
    case 'Variant Y':
      return { path: 'source-code/shared.ts', content: 'export const mode = "y";\n' };
    default:
      return { path: 'source-code/misc.ts', content: 'export const misc = true;\n' };
  }
}

const scriptedFetch: typeof fetch = async (_input, init) => {
  const body = JSON.parse(String(init?.body ?? '{}')) as { messages: Array<{ role: string; content: string | null }> };
  const text = JSON.stringify(body.messages);
  const title = /\\"title\\": \\"([^"\\]+)\\"/.exec(text)?.[1] ?? 'unknown';
  const toolResults = body.messages.filter((m) => m.role === 'tool').length;
  const step = plan(title, text.includes("Quality gate 'secret_scan' failed"));
  const releaseCall = {
    role: 'assistant',
    content: null,
    tool_calls: [{ id: 'r1', type: 'function', function: { name: 'deploy_preview', arguments: '{"environment":"preview"}' } }],
  };
  const message =
    title === 'Release preview' && toolResults === 0
      ? releaseCall
      : title === 'Release preview' || toolResults >= 2
        ? {
            role: 'assistant',
            content: JSON.stringify({
              status: 'completed',
              summary: `${title} done`,
              artifacts: [],
              handoff: { decisions: [], assumptions: [], open_questions: [], required_actions: [] },
              result: {},
            }),
          }
        : toolResults === 0
      ? {
          role: 'assistant',
          content: null,
          tool_calls: [{ id: 'c1', type: 'function', function: { name: 'fs_write_file', arguments: JSON.stringify(step) } }],
        }
      : toolResults === 1
        ? {
            role: 'assistant',
            content: null,
            tool_calls: [{ id: 'c2', type: 'function', function: { name: 'git_commit', arguments: JSON.stringify({ message: title }) } }],
          }
        : {
            role: 'assistant',
            content: JSON.stringify({
              status: 'completed',
              summary: `${title} done`,
              artifacts: [],
              handoff: { decisions: [], assumptions: [], open_questions: [], required_actions: [] },
              result: {},
            }),
          };
  return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message }], usage: { prompt_tokens: 20, completion_tokens: 5 } }), {
    status: 200,
  });
};

let conn: DatabaseConnection;
let dir: string;
let storage: LocalStorage;
let owner: Actor;
let sched: SchedulerDeps;
let secretStore: EnvelopeSecretStore;
let wf = 0;

async function newProject(key: string) {
  return createProject({ db: conn.db, storage, initGit: true }, owner, { key, name: key });
}
async function run(projectId: string, definition: WorkflowDefinition) {
  const { workflow } = await createWorkflow(conn.db, owner, { key: `q-${++wf}`, name: 'Q', definition });
  return (await startWorkflowRun(conn.db, owner, { projectId, workflowId: workflow.id })).run;
}
const dev = (key: string, title: string, over: Record<string, unknown> = {}) => ({
  key,
  agentKey: 'developer',
  title,
  objective: title,
  ...over,
});
async function taskOf(runId: string, stageKey: string) {
  const [step] = await conn.db
    .select()
    .from(workflowSteps)
    .where(and(eq(workflowSteps.runId, runId), eq(workflowSteps.stageKey, stageKey)));
  return (await conn.db.select().from(tasks).where(eq(tasks.id, step!.taskId!)))[0]!;
}
const gates = (taskId: string) =>
  conn.db.select().from(qualityGateEvaluations).where(eq(qualityGateEvaluations.taskId, taskId)).orderBy(qualityGateEvaluations.evaluatedAt);

beforeAll(async () => {
  conn = await createTestDatabase();
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'quality-gates-'));
  storage = new LocalStorage(dir);
  const b = await bootstrapOwner(conn.db, { email: 'o@example.com', password: 'correct-horse-battery', displayName: 'O' });
  owner = { type: 'user', userId: b.user.id, workspaceId: b.workspaceId };
  secretStore = EnvelopeSecretStore.fromKey(randomBytes(32).toString('base64'), 1);
  const provider = await createProvider(conn.db, secretStore, owner, {
    providerKey: 'q-provider',
    displayName: 'Q',
    adapterType: 'openai_compatible',
    baseUrl: 'https://q.local/v1',
    apiKey: 'sk-q-test-key-00001111',
  });
  const model = await createModel(conn.db, owner, {
    providerId: provider.id,
    modelKey: 'coder',
    availability: 'available',
    qualityTier: 'high',
    capabilities: { structured_output: 'yes', tool_calling: 'yes' },
  });
  await upsertAgentModelConfig(conn.db, owner, { scope: 'global', mode: 'fixed', primaryModelId: model.id });
  await createAgent(conn.db, owner, {
    agentKey: 'developer',
    name: 'Developer',
    role: 'developer',
    definition: {
      systemInstruction: 'Implement the task.',
      allowedTools: ['fs_write_file', 'fs_read_file', 'git_commit', 'git_diff'],
      allowedActions: ['read_file', 'write_file', 'git_read', 'git_commit'],
      allowedFileScopes: ['source-code/**'],
    },
  });
  const catalog = createDefaultToolCatalog();
  await syncToolRegistry(conn.db, catalog);
  sched = {
    db: conn.db,
    storage,
    random: () => 0,
    executor: createAgentTaskExecutor({
      db: conn.db,
      storage,
      secretStore,
      registry: new ProviderAdapterRegistry([new OpenAiCompatibleAdapter(scriptedFetch)]),
      sleep: async () => undefined,
      tools: { storageRoot: storage.root, catalog },
    }),
  };
});

afterAll(async () => {
  await conn.close();
  await fs.rm(dir, { recursive: true, force: true });
});

describe('Quality Gates & integration [integration]', () => {
  it('P8-02: a leaked credential fails the gate, the agent is told why, and its fix passes', async () => {
    const p = await newProject('leaky');
    const r = await run(p.id, { stages: [dev('impl', 'Leaky feature', { maxRetries: 2 })] });

    expect((await drainWorker(sched, 'w')).map((t) => t.outcome)).toEqual(['retry_scheduled', 'completed']);
    const task = await taskOf(r.id, 'impl');
    expect(task).toMatchObject({ status: 'completed', retryCount: 1 });

    const evals = await gates(task.id);
    const scans = evals.filter((e) => e.gateKey === 'secret_scan');
    expect(scans.map((e) => e.outcome)).toEqual(['failed', 'passed']);
    const failed = scans[0]!.evidence;
    expect(failed).toMatchObject({ tool: 'platform-secret-scan/1', environmentId: expect.stringMatching(/^host:/) });
    expect(failed.gitTreeHash).toMatch(/^[0-9a-f]{40}$/);
    expect(String(failed['summary'])).toContain('source-code/config.ts:1 AWS access key id');
    // Evidence never repeats the secret, and the raw log is stored and hash-addressed.
    expect(JSON.stringify(failed)).not.toContain(AWS);
    expect(failed.logUri).toMatch(/^blob:\/\/[0-9a-f]{64}$/);
    expect((await storage.getBlob(failed.logUri!)).toString('utf8')).not.toContain(AWS);
    expect(evals.find((e) => e.gateKey === 'merge_check')?.outcome).toBe('passed');
  });

  it('P7-08: an integration stage merges finished task branches into the integration branch', async () => {
    const p = await newProject('integ');
    const r = await run(p.id, {
      stages: [
        dev('a', 'Feature A'),
        dev('b', 'Feature B'),
        { key: 'integrate', kind: 'integration', title: 'Integrate', objective: 'Merge', dependsOn: ['a', 'b'] },
      ],
    });
    expect((await drainWorker(sched, 'w')).map((t) => t.outcome)).toEqual(['completed', 'completed', 'completed']);
    expect((await getWorkflowRun(conn.db, owner, r.id)).run.status).toBe('completed');

    const [proj] = await conn.db.select().from(projects).where(eq(projects.id, p.id));
    const wt = integrationWorktreeDir(storage.root, proj!.workspaceId, proj!.key);
    expect((await runGit(wt, ['rev-parse', '--abbrev-ref', 'HEAD'])).stdout.trim()).toBe('integration');
    expect((await fs.readFile(path.join(wt, 'source-code', 'a.ts'), 'utf8')).trim()).toBe('export const a = 1;');
    expect((await fs.readFile(path.join(wt, 'source-code', 'b.ts'), 'utf8')).trim()).toBe('export const b = 2;');
    // The project's own checkout of main is untouched.
    await expect(fs.access(path.join(storage.root, proj!.storagePath, 'source-code', 'a.ts'))).rejects.toThrow();
    const integ = await taskOf(r.id, 'integrate');
    const [gate] = await gates(integ.id);
    expect(gate).toMatchObject({ gateKey: 'integration_merge', outcome: 'passed' });
    expect(gate!.evidence.gitTreeHash).toMatch(/^[0-9a-f]{40}$/);
  });

  it('P7-08: a merge conflict blocks integration for a human and reports the files', async () => {
    const p = await newProject('conflict');
    const r = await run(p.id, {
      stages: [
        dev('x', 'Variant X'),
        dev('y', 'Variant Y'),
        { key: 'integrate', kind: 'integration', title: 'Integrate', objective: 'Merge', dependsOn: ['x', 'y'] },
      ],
    });
    // Each branch alone merges cleanly into main, so both pass their own merge check…
    expect((await drainWorker(sched, 'w')).map((t) => t.outcome)).toEqual(['completed', 'completed', 'blocked']);
    const integ = await taskOf(r.id, 'integrate');
    expect(integ.status).toBe('blocked');
    expect(integ.statusReason).toContain('source-code/shared.ts');
    const [ev] = await conn.db
      .select()
      .from(systemEvents)
      .where(and(eq(systemEvents.type, 'integration.conflict'), eq(systemEvents.aggregateId, integ.id)));
    expect(ev!.payload).toMatchObject({ files: ['source-code/shared.ts'], integrationBranch: 'integration' });
    expect((await getWorkflowRun(conn.db, owner, r.id)).run.status).toBe('running');
    // …and the aborted merge left the integration worktree clean.
    const [proj] = await conn.db.select().from(projects).where(eq(projects.id, p.id));
    const wt = integrationWorktreeDir(storage.root, proj!.workspaceId, proj!.key);
    expect((await runGit(wt, ['status', '--porcelain'])).stdout.trim()).toBe('');
  });

  it('P8-01: a gate that needs the sandbox blocks completion instead of being skipped', async () => {
    const p = await newProject('sandboxgate');
    const r = await run(p.id, { stages: [dev('impl', 'Feature A', { gates: ['unit_tests'] })] });
    expect((await drainWorker(sched, 'w')).map((t) => t.outcome)).toEqual(['blocked']);
    const task = await taskOf(r.id, 'impl');
    expect(task.status).toBe('blocked');
    expect(task.statusReason).toMatch(/unit_tests .*sandbox_unavailable/);
    const unit = (await gates(task.id)).find((e) => e.gateKey === 'unit_tests');
    expect(unit).toMatchObject({ outcome: 'blocked', evidence: { tool: 'sandbox', toolVersion: 'unavailable' } });
    expect((await gates(task.id)).some((e) => e.gateKey === 'agent_output_contract')).toBe(false);
  });

  it('validates stage kinds and gate keys; integration stages need no agent', async () => {
    const { validateWorkflowDefinition } = await import('../src/index.js');
    expect(() => validateWorkflowDefinition({ stages: [dev('a', 'A', { gates: ['format_disk'] })] })).toThrow(/Invalid workflow/);
    expect(() => validateWorkflowDefinition({ stages: [{ key: 'i', kind: 'integration', title: 'I', objective: 'merge' }] })).not.toThrow();
    expect(() => validateWorkflowDefinition({ stages: [{ key: 'z', kind: 'weird', title: 'Z', objective: 'z', agentKey: 'ba' }] })).toThrow(/Invalid workflow/);
  });
});

describe('P8-05: human approval for high-risk tool calls [integration]', () => {
  it('parks the task, reschedules it on approval, and lets the approved call run exactly once', async () => {
    let deployments = 0;
    const deployPreview: AnyToolDefinition = {
      toolKey: 'deploy_preview',
      description: 'Deploy the integration branch to the preview environment (TEST-ONLY tool).',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['environment'],
        properties: { environment: { type: 'string', enum: ['preview'] } },
      },
      outputSchema: { type: 'object' },
      action: 'execute',
      requiredScopes: ['deploy'],
      timeoutSeconds: 10,
      risk: 'high',
      idempotent: false,
      requiresSandbox: false,
      redaction: {},
      runtimes: ['any'],
      pathFields: [],
      handler: async () => ({ deployed: ++deployments }),
    };
    const catalog = new ToolCatalog([...createDefaultToolCatalog().list(), deployPreview]);
    await syncToolRegistry(conn.db, catalog);
    await createAgent(conn.db, owner, {
      agentKey: 'releaser',
      name: 'Releaser',
      role: 'devops',
      definition: { systemInstruction: 'Release.', allowedTools: ['deploy_preview'], allowedActions: ['execute'] },
    });
    // The agent may use this high-risk tool at all only because an admin raised its ceiling.
    await conn.db.insert(toolPermissions).values({
      workspaceId: owner.workspaceId!,
      subjectType: 'role',
      subjectId: 'devops',
      toolKey: 'deploy_preview',
      maxRisk: 'high',
      createdBy: 'test',
    });
    const releaseSched: SchedulerDeps = {
      ...sched,
      executor: createAgentTaskExecutor({
        db: conn.db,
        storage,
        secretStore,
        registry: new ProviderAdapterRegistry([new OpenAiCompatibleAdapter(scriptedFetch)]),
        sleep: async () => undefined,
        tools: { storageRoot: storage.root, catalog },
      }),
    };
    const p = await newProject('release');
    const r = await run(p.id, { stages: [{ key: 'release', agentKey: 'releaser', title: 'Release preview', objective: 'Deploy' }] });

    expect((await drainWorker(releaseSched, 'w')).map((t) => t.outcome)).toEqual(['waiting_for_input']);
    const parked = await taskOf(r.id, 'release');
    expect(parked.status).toBe('waiting_for_input');
    expect(parked.statusReason).toMatch(/Human approval .* is required before tool 'deploy_preview'/);
    expect(deployments).toBe(0);
    const [request] = await conn.db.select().from(approvals).where(eq(approvals.taskId, parked.id));
    expect(request).toMatchObject({ kind: 'tool_call', status: 'pending', subject: { toolKey: 'deploy_preview', risk: 'high' } });
    expect(await drainWorker(releaseSched, 'w')).toEqual([]); // nothing runs while waiting

    const agentActor: Actor = { type: 'agent', agentKey: 'devops', agentVersion: 1, workspaceId: owner.workspaceId!, taskId: parked.id };
    await expect(decideApproval(conn.db, agentActor, request!.id, { decision: 'approved' })).rejects.toThrow(/Only a human/);
    await decideApproval(conn.db, owner, request!.id, { decision: 'approved', comment: 'ok for preview' });
    expect((await taskOf(r.id, 'release')).status).toBe('ready');

    expect((await drainWorker(releaseSched, 'w')).map((t) => t.outcome)).toEqual(['completed']);
    expect(deployments).toBe(1);
    const calls = await conn.db.select().from(toolExecutions).where(eq(toolExecutions.taskId, parked.id)).orderBy(toolExecutions.createdAt);
    expect(calls.map((c) => c.status)).toEqual(['approval_required', 'succeeded']);
    expect(calls[1]!.decision).toMatchObject({ verdict: 'require_approval', approvalId: request!.id });
    // One approval, one use: the identical call now needs a fresh human decision.
    const again = await resolveToolApproval(conn.db, agentActor, {
      projectId: p.id,
      workspaceId: owner.workspaceId!,
      taskId: parked.id,
      toolKey: 'deploy_preview',
      toolInput: { environment: 'preview' },
      risk: 'high',
      reason: 'again',
    });
    expect(again).toMatchObject({ state: 'pending', created: true });
    expect(again.approvalId).not.toBe(request!.id);
  });
});
