import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { approveArtifactVersion, createArtifact } from '@platform/artifacts';
import {
  createAgent,
  listAgents,
  listAgentVersions,
  listSkills,
  publishAgentVersion,
  publishSkill,
  seedAgentLibrary,
} from '@platform/agent-runtime';
import {
  createModel,
  createProvider,
  EnvelopeSecretStore,
  OpenAiCompatibleAdapter,
  ProviderAdapterRegistry,
  upsertAgentModelConfig,
} from '@platform/ai-management';
import { upsertBudget } from '@platform/budget';
import {
  agentExecutions,
  agentHandoffs,
  approvals,
  contextPackages,
  createTestDatabase,
  type DatabaseConnection,
  qualityGateEvaluations,
  systemEvents,
  taskExecutions,
  taskLeases,
  tasks,
  workflowSteps,
} from '@platform/db';
import { bootstrapOwner } from '@platform/iam';
import { createProject } from '@platform/projects';
import type { Actor } from '@platform/shared';
import { LocalStorage } from '@platform/storage';
import {
  cancelWorkflowRun,
  claimNextTask,
  completeClaim,
  computeBackoffMs,
  createAgentTaskExecutor,
  createWorkflow,
  decideApproval,
  drainWorker,
  evaluateCondition,
  getWorkflowRun,
  heartbeat,
  LeaseLostError,
  listApprovals,
  listProjectEvents,
  listTaskExecutions,
  pauseWorkflowRun,
  planStages,
  recoverExpiredLeases,
  resumeWorkflowRun,
  type SchedulerDeps,
  startWorkflowRun,
  transitionTask,
  validateWorkflowDefinition,
  type WorkflowDefinition,
} from '../src/index.js';

/**
 * Phase 5 gate (docs/phase-0/08-roadmap.md): E2E workflow of ≥3 agents with handoffs; kill worker mid-task
 * ⇒ lease expiry ⇒ recovery; pause/resume; retries bounded.
 */
const AGENT_LIBRARY = fileURLToPath(new URL('../../../agent-library', import.meta.url));

// ---------------------------------------------------------------- TEST-ONLY scripted model (Blueprint §20.3)

type Reply =
  | { envelope: Record<string, unknown>; usage?: { prompt: number; completion: number } }
  | { raw: string }
  | { status: number };

const envelope = (over: Record<string, unknown>): Record<string, unknown> => ({
  status: 'completed',
  summary: 'done',
  artifacts: [],
  handoff: { decisions: ['d1'], assumptions: [], open_questions: [], required_actions: ['continue'] },
  result: {},
  ...over,
});

const DEFAULT_REPLY: Record<string, (title: string) => Record<string, unknown>> = {
  ba: () =>
    envelope({
      summary: 'Requirements analysed',
      artifacts: [
        { path: '.ai-context/01-requirements/overview.md', type: 'requirements', content: '# Requirements\nUS-1 Users can log in.\n' },
      ],
      result: {
        user_stories: [{ id: 'US-1', story: 'As a user I can log in', acceptance_criteria: ['valid credentials open a session'] }],
        business_rules: ['passwords are never stored in clear text'],
      },
    }),
  architect: (title) =>
    envelope({
      summary: `Designed: ${title}`,
      artifacts: [
        title.includes('API')
          ? { path: '.ai-context/04-api/contract.md', type: 'api_contract', content: '# API\nPOST /login\n' }
          : { path: '.ai-context/02-architecture/overview.md', type: 'architecture', content: '# Architecture\nAPI + DB\n' },
      ],
      result: { components: [{ name: 'api', responsibility: 'serves requests' }], tech_stack: ['TypeScript'] },
    }),
  database: () =>
    envelope({
      summary: 'Schema designed',
      artifacts: [{ path: '.ai-context/03-database/schema.md', type: 'db_schema', content: '# Schema\nusers(id pk)\n' }],
      result: { entities: [{ name: 'users', primary_key: 'id' }] },
    }),
  review: () =>
    envelope({
      summary: 'Reviewed',
      artifacts: [
        { path: '.ai-context/07-quality/review-reports/review.md', type: 'review_report', content: '# Review\nNo findings.\n' },
      ],
      result: { verdict: 'approved', findings: [] },
    }),
};

const scripted = new Map<string, Reply[]>();
const calls: Array<{ role: string; title: string; model: string; body: string }> = [];

const scriptedFetch: typeof fetch = async (_input, init) => {
  const body = String(init?.body ?? '{}');
  const parsed = JSON.parse(body) as { model: string };
  const role = /You act as the '([a-z_]+)' agent/.exec(body)?.[1] ?? 'unknown';
  const title = /\\"title\\": \\"([^"\\]+)\\"/.exec(body)?.[1] ?? 'unknown';
  calls.push({ role, title, model: parsed.model, body });
  const reply: Reply = scripted.get(title)?.shift() ?? { envelope: DEFAULT_REPLY[role]!(title) };
  if ('status' in reply) return new Response('{"error":{"code":"rate_limit_exceeded"}}', { status: reply.status });
  const usage = 'envelope' in reply && reply.usage ? reply.usage : { prompt: 1000, completion: 500 };
  return new Response(
    JSON.stringify({
      id: 'cmpl-test',
      choices: [
        {
          finish_reason: 'stop',
          message: { role: 'assistant', content: 'raw' in reply ? reply.raw : JSON.stringify(reply.envelope) },
        },
      ],
      usage: { prompt_tokens: usage.prompt, completion_tokens: usage.completion },
    }),
    { status: 200 },
  );
};

// ---------------------------------------------------------------- fixtures

let conn: DatabaseConnection;
let dir: string;
let storage: LocalStorage;
let owner: Actor;
let workspaceId: string;
let projectId: string;
let clock: Date;
let sched: SchedulerDeps;
const modelIds: Record<string, string> = {};

const stage = (key: string, agentKey: string, over: Record<string, unknown> = {}) => ({
  key,
  agentKey,
  title: `Stage ${key}`,
  objective: `Do ${key}`,
  ...over,
});

let wfCounter = 0;
async function startRun(definition: WorkflowDefinition, variables: Record<string, unknown> = {}, project = projectId) {
  const { workflow } = await createWorkflow(conn.db, owner, { key: `wf-${++wfCounter}`, name: 'Test workflow', definition });
  return startWorkflowRun(conn.db, owner, { projectId: project, workflowId: workflow.id, variables });
}

const stepStatuses = async (runId: string) =>
  Object.fromEntries(
    (await conn.db.select().from(workflowSteps).where(eq(workflowSteps.runId, runId))).map((s) => [s.stageKey, s.status]),
  );
const taskOfStage = async (runId: string, stageKey: string) => {
  const [step] = await conn.db
    .select()
    .from(workflowSteps)
    .where(and(eq(workflowSteps.runId, runId), eq(workflowSteps.stageKey, stageKey)));
  const [task] = await conn.db.select().from(tasks).where(eq(tasks.id, step!.taskId!));
  return task!;
};
const advance = (seconds: number) => {
  clock = new Date(clock.getTime() + seconds * 1000);
};

beforeAll(async () => {
  conn = await createTestDatabase();
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'orchestration-p5-'));
  storage = new LocalStorage(dir);
  const b = await bootstrapOwner(conn.db, { email: 'owner@example.com', password: 'correct-horse-battery', displayName: 'Owner' });
  workspaceId = b.workspaceId;
  owner = { type: 'user', userId: b.user.id, workspaceId };
  projectId = (await createProject({ db: conn.db, storage, initGit: false }, owner, { key: 'p5', name: 'Phase 5' })).id;

  const secretStore = EnvelopeSecretStore.fromKey(randomBytes(32).toString('base64'), 1);
  const provider = await createProvider(conn.db, secretStore, owner, {
    providerKey: 'p5-provider',
    displayName: 'P5',
    adapterType: 'openai_compatible',
    baseUrl: 'https://p5.local/v1',
    apiKey: 'sk-p5-test-key-00001111',
  });
  for (const [modelKey, qualityTier] of [
    ['std', 'standard'],
    ['big', 'high'],
  ] as const) {
    const m = await createModel(conn.db, owner, {
      providerId: provider.id,
      modelKey,
      availability: 'available',
      contextWindow: 200_000,
      maxOutputTokens: 8_000,
      qualityTier,
      metadataVerified: true,
      capabilities: { structured_output: 'yes', tool_calling: 'yes' },
    });
    modelIds[modelKey] = m.id;
  }
  await upsertAgentModelConfig(conn.db, owner, {
    scope: 'global',
    mode: 'hybrid',
    primaryModelId: modelIds['std']!,
    allowlistModelIds: [modelIds['std']!, modelIds['big']!],
    params: { maxOutputTokens: 1000 },
    routingPolicy: { allowAutoUpgrade: true },
  });

  clock = new Date('2026-11-10T08:00:00Z');
  sched = {
    db: conn.db,
    executor: createAgentTaskExecutor({
      db: conn.db,
      storage,
      secretStore,
      registry: new ProviderAdapterRegistry([new OpenAiCompatibleAdapter(scriptedFetch)]),
      sleep: async () => undefined,
    }),
    now: () => clock,
    leaseSeconds: 60,
    random: () => 0.5,
    backoff: { baseMs: 10_000, maxMs: 60_000 },
  };
});

afterAll(async () => {
  await conn.close();
  await fs.rm(dir, { recursive: true, force: true });
});

beforeEach(() => {
  scripted.clear();
  calls.length = 0;
});

// ---------------------------------------------------------------- pure logic

describe('workflow definitions & backoff — pure logic', () => {
  const def: WorkflowDefinition = {
    stages: [
      stage('a', 'ba'),
      stage('b', 'architect', { dependsOn: ['a'], when: { var: 'kind', equals: 'feature' } }),
      stage('c', 'database', { dependsOn: ['b'], when: { var: 'db.changes', exists: true } }),
      stage('d', 'review', { dependsOn: ['b', 'c'] }),
    ],
  };

  it('rejects cycles, unknown dependencies and malformed stages before anything runs', () => {
    expect(validateWorkflowDefinition(def).stages).toHaveLength(4);
    expect(() =>
      validateWorkflowDefinition({ stages: [stage('a', 'ba', { dependsOn: ['b'] }), stage('b', 'ba', { dependsOn: ['a'] })] }),
    ).toThrow(/circular/);
    expect(() => validateWorkflowDefinition({ stages: [stage('a', 'ba', { dependsOn: ['zz'] })] })).toThrow(/Invalid workflow/);
    expect(() => validateWorkflowDefinition({ stages: [stage('a', 'ba'), stage('a', 'ba')] })).toThrow(/Invalid workflow/);
    expect(() => validateWorkflowDefinition({ stages: [stage('a', 'ba', { maxRetries: 99 })] })).toThrow(/Invalid workflow/);
    expect(() => validateWorkflowDefinition({ stages: [] })).toThrow(/1\.\.100 stages/);
  });

  it('evaluates branch conditions', () => {
    const vars = { kind: 'bugfix', db: { changes: 2 }, tags: 'auth' };
    expect(evaluateCondition({ var: 'kind', equals: 'bugfix' }, vars)).toBe(true);
    expect(evaluateCondition({ var: 'kind', in: ['feature', 'epic'] }, vars)).toBe(false);
    expect(evaluateCondition({ var: 'db.changes', exists: true }, vars)).toBe(true);
    expect(evaluateCondition({ var: 'db.missing', exists: false }, vars)).toBe(true);
    expect(evaluateCondition({ all: [{ var: 'tags', equals: 'auth' }, { not: { var: 'kind', equals: 'feature' } }] }, vars)).toBe(true);
    expect(evaluateCondition({ any: [{ var: 'kind', equals: 'x' }, { var: 'kind', notEquals: 'bugfix' }] }, vars)).toBe(false);
  });

  it('skips inactive stages and rewires dependencies around them', () => {
    const full = planStages(def, { kind: 'feature', db: { changes: 1 } });
    expect(full.map((p) => [p.stage.key, p.active, p.effectiveDependsOn])).toEqual([
      ['a', true, []],
      ['b', true, ['a']],
      ['c', true, ['b']],
      ['d', true, ['b', 'c']],
    ]);
    // A bug fix bypasses design and database: review then waits directly for the analysis.
    const bugfix = planStages(def, { kind: 'bugfix' });
    expect(bugfix.filter((p) => !p.active).map((p) => p.stage.key)).toEqual(['b', 'c']);
    expect(bugfix.find((p) => p.stage.key === 'd')!.effectiveDependsOn).toEqual(['a']);
  });

  it('computes exponential backoff with full jitter inside its bounds', () => {
    const opts = { baseMs: 1_000, maxMs: 8_000 };
    expect(computeBackoffMs(1, { ...opts, random: () => 0.999 })).toBeLessThan(1_000);
    expect(computeBackoffMs(3, { ...opts, random: () => 0.5 })).toBe(2_000);
    expect(computeBackoffMs(10, { ...opts, random: () => 0.999 })).toBeLessThan(8_000);
    expect(computeBackoffMs(4, { ...opts, random: () => 0 })).toBe(0);
  });
});

// ---------------------------------------------------------------- integration

describe('Phase 5 gate — agent runtime & orchestration [integration]', () => {
  it('seeds the agent library idempotently and keeps versions immutable (P5-01)', async () => {
    const first = await seedAgentLibrary(conn.db, owner, AGENT_LIBRARY);
    expect(first.map((r) => [r.agentKey, r.outcome, r.versionNo])).toEqual([
      ['architect', 'created', 1],
      ['ba', 'created', 1],
      ['database', 'created', 1],
      ['developer', 'created', 1],
      ['review', 'created', 1],
    ]);
    expect((await seedAgentLibrary(conn.db, owner, AGENT_LIBRARY)).every((r) => r.outcome === 'unchanged')).toBe(true);

    const agents = await listAgents(conn.db, owner);
    const ba = agents.find((a) => a.agentKey === 'ba')!;
    expect(ba.currentVersion).toMatchObject({ versionNo: 1, retryPolicy: { maxOutputRepairs: 1 } });
    // A definition never names a model.
    expect(JSON.stringify(ba.currentVersion)).not.toMatch(/gpt|claude|gemini/i);

    const v1 = ba.currentVersion!;
    const changed = await publishAgentVersion(conn.db, owner, ba.id, {
      systemInstruction: `${v1.systemInstruction}\nBe concise.`,
      outputSchema: v1.outputSchema,
      retryPolicy: v1.retryPolicy,
      completionCriteria: v1.completionCriteria,
    });
    expect(changed).toMatchObject({ created: true, version: { versionNo: 2 } });
    expect((await listAgentVersions(conn.db, owner, ba.id)).map((v) => v.versionNo)).toEqual([2, 1]);
    await expect(
      conn.db.execute(sql`update agent_versions set system_instruction = 'tampered' where id = ${v1.id}`),
    ).rejects.toThrow();

    // B7: skills are seeded with the library, versioned and immutable.
    expect((await listSkills(conn.db, owner)).map((k) => `${k.skillKey}@${k.versionNo}`)).toEqual(['adr-writing@1', 'secure-coding@1']);
    const [adr] = await listSkills(conn.db, owner);
    expect((await publishSkill(conn.db, owner, { skillKey: 'adr-writing', name: adr!.name, description: adr!.description, instructions: adr!.instructions })).created).toBe(false);
    const changedSkill = await publishSkill(conn.db, owner, { skillKey: 'scratch', name: 'Scratch', instructions: 'v1' });
    expect((await publishSkill(conn.db, owner, { skillKey: 'scratch', name: 'Scratch', instructions: 'v2' })).skill.versionNo).toBe(changedSkill.skill.versionNo + 1);
    await expect(conn.db.execute(sql`update agent_skills set instructions = 'tampered' where id = ${changedSkill.skill.id}`)).rejects.toThrow();
    await expect(
      createAgent(conn.db, owner, { agentKey: 'badskill', name: 'Bad', role: 'qa', definition: { systemInstruction: 'x', skills: ['Not A Key'] } }),
    ).rejects.toThrow(/Invalid skill key/);

    await expect(
      createAgent(conn.db, owner, { agentKey: 'rogue', name: 'Rogue', role: 'wizard', definition: { systemInstruction: 'x' } }),
    ).rejects.toThrow(/Unknown agent role/);
    await expect(
      createAgent(conn.db, owner, {
        agentKey: 'looper',
        name: 'Looper',
        role: 'qa',
        definition: { systemInstruction: 'x', retryPolicy: { maxOutputRepairs: 50 } },
      }),
    ).rejects.toThrow(/bounded self-correction/);
  });

  it('GATE: runs a 4-agent workflow with handoffs, an approval gate, parallel stages and no transcripts', async () => {
    const { run } = await startRun(
      {
        stages: [
          stage('requirements', 'ba', { nextAgent: 'architect' }),
          stage('architecture', 'architect', { dependsOn: ['requirements'], approval: 'human', nextAgent: 'database' }),
          stage('schema', 'database', { dependsOn: ['architecture'], nextAgent: 'review' }),
          stage('api', 'architect', { title: 'API contract', dependsOn: ['architecture'], nextAgent: 'review' }),
          stage('review', 'review', { dependsOn: ['schema', 'api'] }),
        ],
      },
      {},
    );
    expect((await taskOfStage(run.id, 'requirements')).status).toBe('ready');
    expect((await taskOfStage(run.id, 'architecture')).status).toBe('pending');

    // BA runs, then the architect stops at the human approval gate.
    let ticks = await drainWorker(sched, 'worker-1');
    expect(ticks.map((t) => t.outcome)).toEqual(['completed', 'waiting_for_approval']);
    expect(await stepStatuses(run.id)).toMatchObject({
      requirements: 'completed',
      architecture: 'waiting_for_approval',
      schema: 'pending',
    });
    const architecture = await taskOfStage(run.id, 'architecture');
    expect(architecture.status).toBe('waiting_for_approval');

    // Agent B consumed Agent A's output through the Context Package — as untrusted data, not as a transcript.
    const architectCall = calls.find((c) => c.role === 'architect')!;
    const sent = JSON.parse(architectCall.body) as { messages: Array<{ role: string; content: string }> };
    const system = sent.messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n');
    const untrusted = sent.messages.find((m) => m.content.includes('[UNTRUSTED_CONTEXT id='))!;
    expect(untrusted.role).toBe('user');
    expect(untrusted.content).toContain('US-1 Users can log in.');
    expect(system).not.toContain('US-1 Users can log in.');
    // B7: the architect's skill is part of the trusted instructions, and its version is on record.
    expect(system).toContain('## Skill: Architecture Decision Records');
    expect(untrusted.content).not.toContain('## Skill:');
    expect(architectCall.body).not.toContain('Requirements analysed'); // the BA's chat summary is not forwarded
    const [pkg] = await conn.db.select().from(contextPackages).where(eq(contextPackages.taskId, architecture.id));
    expect(pkg!.promptVersion).toBe('architect@1+adr-writing@1');
    expect((pkg!.manifest as { items: Array<{ path: string; source: string }> }).items).toContainEqual(
      expect.objectContaining({ path: '.ai-context/01-requirements/overview.md', source: 'handoff' }),
    );

    // Only a human may decide; nothing can approve its own work.
    const [approval] = (await listApprovals(conn.db, owner, projectId, { status: 'pending' })).items;
    expect(approval).toMatchObject({ kind: 'workflow_gate', taskId: architecture.id });
    const agentActor: Actor = { type: 'agent', agentKey: 'architect', agentVersion: 1, workspaceId, taskId: architecture.id };
    await expect(decideApproval(conn.db, agentActor, approval!.id, { decision: 'approved' })).rejects.toThrow(/Only a human/);
    await expect(
      decideApproval(conn.db, { type: 'system', workspaceId, component: 'x' }, approval!.id, { decision: 'approved' }),
    ).rejects.toThrow(/Only a human/);
    await expect(decideApproval(conn.db, owner, approval!.id, { decision: 'rejected' })).rejects.toThrow(/needs a comment/);

    // Rejection sends the stage back for rework with the reviewer's comment as feedback.
    await decideApproval(conn.db, owner, approval!.id, { decision: 'rejected', comment: 'Add a caching layer.' });
    expect(await taskOfStage(run.id, 'architecture')).toMatchObject({ status: 'ready', retryCount: 1 });
    calls.length = 0;
    ticks = await drainWorker(sched, 'worker-1');
    expect(ticks.map((t) => t.outcome)).toEqual(['waiting_for_approval']);
    expect(calls[0]!.body).toContain('Add a caching layer.');
    await expect(decideApproval(conn.db, owner, approval!.id, { decision: 'approved' })).rejects.toThrow(/already rejected/);

    const [second] = (await listApprovals(conn.db, owner, projectId, { status: 'pending' })).items;
    await decideApproval(conn.db, owner, second!.id, { decision: 'approved', comment: 'Good.' });
    expect((await taskOfStage(run.id, 'architecture')).status).toBe('completed');

    // Both dependants are released together: independent stages run in parallel.
    expect((await taskOfStage(run.id, 'schema')).status).toBe('ready');
    expect((await taskOfStage(run.id, 'api')).status).toBe('ready');
    expect((await taskOfStage(run.id, 'review')).status).toBe('pending');

    ticks = await drainWorker(sched, 'worker-1');
    expect(ticks.map((t) => t.outcome)).toEqual(['completed', 'completed', 'completed']);
    const finished = await getWorkflowRun(conn.db, owner, run.id);
    expect(finished.run.status).toBe('completed');
    expect(finished.run.endedAt).not.toBeNull();
    expect(finished.steps.every((s) => s.status === 'completed')).toBe(true);

    // Structured handoffs with hashed output references, one per finished agent run.
    const handoffs = await conn.db.select().from(agentHandoffs).where(eq(agentHandoffs.projectId, projectId));
    expect(handoffs.map((h) => `${h.fromAgent}>${h.toAgent}`).sort()).toEqual([
      'architect>database',
      'architect>database',
      'architect>review',
      'ba>architect',
      'database>review',
      'review>orchestrator',
    ]);
    for (const h of handoffs) {
      const refs = (h.payload as { output_refs: Array<{ sha256: string }> }).output_refs;
      expect(refs.length).toBe(1);
      expect(refs[0]!.sha256).toMatch(/^[0-9a-f]{64}$/);
    }

    // Completion rests on gate evidence, never on the agent's claim.
    const gates = await conn.db.select().from(qualityGateEvaluations).where(eq(qualityGateEvaluations.taskId, architecture.id));
    expect(gates.map((g) => `${g.gateKey}=${g.outcome}`).sort()).toEqual([
      'agent_output_contract=passed',
      'agent_output_contract=passed',
      'human_approval=failed',
      'human_approval=passed',
      'human_approval=requires_approval',
      'human_approval=requires_approval',
    ]);
    const runs = await conn.db.select().from(agentExecutions).where(eq(agentExecutions.taskId, architecture.id));
    expect(runs.map((r) => r.status)).toEqual(['succeeded', 'succeeded']);
    expect((await listTaskExecutions(conn.db, architecture.id)).map((e) => [e.attemptNo, e.status])).toEqual([
      [1, 'succeeded'],
      [2, 'succeeded'],
    ]);
    expect(await conn.db.select().from(taskLeases)).toEqual([]);

    const events = (await listProjectEvents(conn.db, owner, projectId, { limit: 500 })).map((e) => e.type);
    expect(events).toEqual(expect.arrayContaining(['workflow.run_started', 'approval.requested', 'approval.rejected', 'approval.approved', 'handoff.created', 'task.completed', 'workflow.run_completed']));
    const cursor = (await listProjectEvents(conn.db, owner, projectId, { limit: 3 })).at(-1)!.id;
    expect((await listProjectEvents(conn.db, owner, projectId, { after: cursor, limit: 500 })).length).toBe(events.length - 3);
  });

  it('branches conditionally: a skipped stage is not executed and does not block its dependants', async () => {
    const { run, steps } = await startRun(
      {
        stages: [
          stage('requirements', 'ba'),
          stage('schema', 'database', { dependsOn: ['requirements'], when: { var: 'has_database', equals: true } }),
          stage('review', 'review', { dependsOn: ['schema'] }),
        ],
      },
      { has_database: false },
    );
    expect(steps.find((s) => s.stageKey === 'schema')).toMatchObject({ status: 'skipped', taskId: null });
    const ticks = await drainWorker(sched, 'worker-1');
    expect(ticks.map((t) => t.outcome)).toEqual(['completed', 'completed']);
    expect(calls.map((c) => c.role)).toEqual(['ba', 'review']);
    expect((await getWorkflowRun(conn.db, owner, run.id)).run.status).toBe('completed');
    expect(await stepStatuses(run.id)).toEqual({ requirements: 'completed', schema: 'skipped', review: 'completed' });

    await expect(
      startRun({ stages: [stage('only', 'ba', { when: { var: 'x', equals: 1 } })] }, { x: 2 }),
    ).rejects.toMatchObject({ code: 'workflow_empty' });
    await expect(startRun({ stages: [stage('ghost', 'nobody')] })).rejects.toMatchObject({ code: 'agent_unavailable' });
  });

  it('GATE: bounds retries, applies backoff, escalates the model and stops with the failure context', async () => {
    const title = 'Flaky analysis';
    const { run } = await startRun({ stages: [stage('analysis', 'ba', { title, maxRetries: 2 })] });
    // Every reply violates the contract: 1 try + 1 repair per attempt, 3 attempts in total.
    scripted.set(title, Array.from({ length: 20 }, () => ({ raw: 'I think the answer is 42.' })));

    let ticks = await drainWorker(sched, 'worker-1');
    expect(ticks.map((t) => t.outcome)).toEqual(['retry_scheduled']);
    expect(calls.length).toBe(2);
    const afterFirst = await taskOfStage(run.id, 'analysis');
    expect(afterFirst).toMatchObject({ status: 'ready', retryCount: 1 });
    // attempt 1 → jitter 0.5 × min(60 s, 10 s × 2^0) = 5 s
    expect(afterFirst.notBefore!.getTime() - clock.getTime()).toBe(5_000);

    expect(await drainWorker(sched, 'worker-1')).toEqual([]); // still backing off
    advance(6);
    ticks = await drainWorker(sched, 'worker-1');
    expect(ticks.map((t) => t.outcome)).toEqual(['retry_scheduled']);
    expect((await taskOfStage(run.id, 'analysis')).notBefore!.getTime() - clock.getTime()).toBe(10_000);

    advance(11);
    ticks = await drainWorker(sched, 'worker-1');
    expect(ticks.map((t) => t.outcome)).toEqual(['failed']);
    expect(ticks[0]!.error).toMatch(/violates its contract after 1 repair/);

    // Bounded: 3 attempts × (1 try + 1 repair) and nothing more, however long we wait.
    advance(3600);
    expect(await drainWorker(sched, 'worker-1')).toEqual([]);
    expect(calls.length).toBe(6);
    // Retries escalate complexity, so the hybrid configuration upgrades the model.
    expect(calls.map((c) => c.model)).toEqual(['std', 'std', 'big', 'big', 'big', 'big']);

    const task = await taskOfStage(run.id, 'analysis');
    expect(task).toMatchObject({ status: 'failed', retryCount: 2, maxRetries: 2 });
    const executions = await listTaskExecutions(conn.db, task.id);
    expect(executions.map((e) => [e.attemptNo, e.status])).toEqual([[1, 'failed'], [2, 'failed'], [3, 'failed']]);
    expect(executions[2]!.failure).toMatchObject({ code: 'agent_output_invalid', retryable: true, attemptNo: 3 });
    expect(typeof executions[2]!.failure!['stack']).toBe('string');
    expect((await getWorkflowRun(conn.db, owner, run.id)).run.status).toBe('failed');
    const exhausted = await conn.db
      .select()
      .from(systemEvents)
      .where(and(eq(systemEvents.type, 'task.retries_exhausted'), eq(systemEvents.aggregateId, task.id)));
    expect(exhausted[0]!.payload).toMatchObject({ maxRetries: 2, requires: 'human_intervention' });
  });

  it('repairs a contract violation within the attempt, and rejects writes outside the agent area', async () => {
    const repaired = 'Repairable analysis';
    scripted.set(repaired, [{ envelope: { status: 'completed', summary: 'missing fields' } }]);
    const a = await startRun({ stages: [stage('analysis', 'ba', { title: repaired, maxRetries: 0 })] });
    expect((await drainWorker(sched, 'worker-1')).map((t) => t.outcome)).toEqual(['completed']);
    expect(calls.length).toBe(2);
    expect(calls[1]!.body).toContain('violated the output contract');
    const [exec] = await conn.db
      .select()
      .from(agentExecutions)
      .where(eq(agentExecutions.taskId, (await taskOfStage(a.run.id, 'analysis')).id));
    expect(exec).toMatchObject({ status: 'succeeded', outputRepairs: 1 });

    // The BA tries to overwrite the architecture: the artifact policy stops it and the attempt fails.
    const greedy = 'Greedy analysis';
    scripted.set(greedy, [
      {
        envelope: {
          ...DEFAULT_REPLY['ba']!(greedy),
          artifacts: [{ path: '.ai-context/02-architecture/overview.md', type: 'architecture', content: 'hijacked' }],
        },
      },
    ]);
    const b = await startRun({ stages: [stage('analysis', 'ba', { title: greedy, maxRetries: 0 })] });
    const [tick] = await drainWorker(sched, 'worker-1');
    expect(tick).toMatchObject({ outcome: 'failed' });
    expect(tick!.error).toMatch(/cannot write/);
    const [failed] = await listTaskExecutions(conn.db, (await taskOfStage(b.run.id, 'analysis')).id);
    expect(failed!.failure).toMatchObject({ code: 'agent_action_rejected' });
  });

  it('parks a task whose required input is missing or unapproved, without spending retries', async () => {
    const inputPath = '.ai-context/01-requirements/request.md';
    const { run } = await startRun({
      stages: [stage('analysis', 'ba', { title: 'Analyse request', inputRefs: [{ path: inputPath }], maxRetries: 1 })],
    });
    expect((await drainWorker(sched, 'worker-1')).map((t) => t.outcome)).toEqual(['waiting_for_input']);
    let task = await taskOfStage(run.id, 'analysis');
    expect(task).toMatchObject({ status: 'waiting_for_input', retryCount: 0 });
    expect(task.statusReason).toMatch(/Required context artifact .*request\.md.* not found — provide or approve it/);
    expect(calls).toEqual([]); // no model call was spent

    // Written but not yet approved: still parked, still no retry spent.
    const { item, version } = await createArtifact({ db: conn.db, storage }, owner, projectId, {
      path: inputPath,
      type: 'request',
      content: '# Request\nBuild a login page.\n',
    });
    await transitionTask(conn.db, owner, task.id, 'ready', { reason: 'request written' });
    expect((await drainWorker(sched, 'worker-1')).map((t) => t.outcome)).toEqual(['waiting_for_input']);
    task = await taskOfStage(run.id, 'analysis');
    expect(task).toMatchObject({ status: 'waiting_for_input', retryCount: 0 });
    expect(task.statusReason).toMatch(/has no approved version/);

    // Approved: the agent runs with the request in its context package.
    await approveArtifactVersion({ db: conn.db, storage }, owner, item.id, version.versionNo);
    await transitionTask(conn.db, owner, task.id, 'ready', { reason: 'request approved' });
    expect((await drainWorker(sched, 'worker-1')).map((t) => t.outcome)).toEqual(['completed']);
    expect(calls[0]!.body).toContain('Build a login page.');
  });

  it('fails clearly, before any model call, when an agent needs a skill that does not exist', async () => {
    await createAgent(conn.db, owner, {
      agentKey: 'skilless',
      name: 'Skilless',
      role: 'qa',
      definition: { systemInstruction: 'Test things.', skills: ['missing-skill'] },
    });
    await startRun({ stages: [stage('qa', 'skilless', { title: 'Needs a skill', maxRetries: 0 })] });
    const [tick] = await drainWorker(sched, 'worker-1');
    expect(tick).toMatchObject({ outcome: 'failed' });
    expect(tick!.error).toMatch(/needs unknown skill\(s\): missing-skill/);
    expect(calls).toEqual([]);
  });

  it('parks a task that needs human input instead of guessing', async () => {
    const title = 'Ambiguous request';
    scripted.set(title, [
      {
        envelope: envelope({
          status: 'needs_input',
          summary: 'Too vague',
          handoff: { decisions: [], assumptions: [], open_questions: ['Which user roles exist?'], required_actions: [] },
        }),
      },
    ]);
    const { run } = await startRun({ stages: [stage('analysis', 'ba', { title })] });
    const dbg = await drainWorker(sched, 'worker-1');
    expect(dbg.map((t) => t.outcome)).toEqual(['waiting_for_input']);
    const task = await taskOfStage(run.id, 'analysis');
    expect(task.status).toBe('waiting_for_input');
    expect(task.statusReason).toContain('Which user roles exist?');
    expect(await stepStatuses(run.id)).toEqual({ analysis: 'waiting_for_input' });
    await cancelWorkflowRun(conn.db, owner, run.id, 'test cleanup');
  });

  it('GATE: recovers a task whose worker died mid-execution, without duplicate execution', async () => {
    const { run } = await startRun({ stages: [stage('analysis', 'ba', { title: 'Crash recovery' })] });

    // Worker A claims the task and then dies: no heartbeat, no result.
    const claimA = (await claimNextTask(conn.db, 'worker-A', { now: clock, leaseSeconds: 60 }))!;
    expect(claimA.task.status).toBe('running');
    expect(claimA.execution).toMatchObject({ attemptNo: 1, workerId: 'worker-A', status: 'running' });

    // While the lease is valid nobody else can take the task.
    advance(30);
    expect(await claimNextTask(conn.db, 'worker-B', { now: clock, leaseSeconds: 60 })).toBeNull();
    expect(await recoverExpiredLeases(conn.db, clock)).toEqual([]);
    // A heartbeat keeps it alive past the original expiry…
    expect(await heartbeat(conn.db, claimA.execution.id, { now: clock, leaseSeconds: 60 })).toBe(true);
    advance(45);
    expect(await recoverExpiredLeases(conn.db, clock)).toEqual([]);

    // …but once heartbeats stop, the lease expires and the task is recovered.
    advance(61);
    const recovered = await recoverExpiredLeases(conn.db, clock);
    expect(recovered).toEqual([
      { taskId: claimA.task.id, executionId: claimA.execution.id, holder: 'worker-A', taskStatus: 'ready' },
    ]);
    expect(await taskOfStage(run.id, 'analysis')).toMatchObject({ status: 'ready', retryCount: 1 });
    expect(await heartbeat(conn.db, claimA.execution.id, { now: clock })).toBe(false);

    // Worker B finishes the job.
    const ticks = await drainWorker(sched, 'worker-B');
    expect(ticks.map((t) => t.outcome)).toEqual(['completed']);
    expect((await getWorkflowRun(conn.db, owner, run.id)).run.status).toBe('completed');

    // Worker A comes back with a stale result: it is discarded, not applied.
    await expect(
      completeClaim(conn.db, claimA, {
        status: 'completed',
        summary: 'stale',
        result: {},
        outputRefs: [],
        openQuestions: [],
        handoffId: null,
        contextPackageId: claimA.task.id,
        invocationIds: [],
        modelKey: 'std',
        providerKey: 'p5-provider',
        outputRepairs: 0,
        budget: { worstBand: 'normal', haltTriggered: false },
      }),
    ).rejects.toBeInstanceOf(LeaseLostError);

    const executions = await listTaskExecutions(conn.db, claimA.task.id);
    expect(executions.map((e) => [e.attemptNo, e.workerId, e.status])).toEqual([
      [1, 'worker-A', 'abandoned'],
      [2, 'worker-B', 'succeeded'],
    ]);
    expect(executions[0]!.failure).toMatchObject({ code: 'lease_expired' });
    // A closed execution is immutable.
    await expect(
      conn.db.update(taskExecutions).set({ status: 'succeeded' }).where(eq(taskExecutions.id, claimA.execution.id)),
    ).rejects.toThrow();
    const expired = await conn.db
      .select()
      .from(systemEvents)
      .where(and(eq(systemEvents.type, 'task.lease_expired'), eq(systemEvents.aggregateId, claimA.task.id)));
    expect(expired.length).toBe(1);
  });

  it('GATE: pauses, resumes and cancels a run', async () => {
    const twoStages: WorkflowDefinition = {
      stages: [stage('requirements', 'ba'), stage('review', 'review', { dependsOn: ['requirements'] })],
    };
    const { run } = await startRun(twoStages);
    expect((await pauseWorkflowRun(conn.db, owner, run.id, 'lunch')).status).toBe('paused');
    expect(await drainWorker(sched, 'worker-1')).toEqual([]); // nothing is scheduled while paused
    expect((await taskOfStage(run.id, 'requirements')).status).toBe('ready');
    expect((await getWorkflowRun(conn.db, owner, run.id)).run).toMatchObject({ status: 'paused', pausedReason: 'lunch' });

    expect((await resumeWorkflowRun(conn.db, owner, run.id)).status).toBe('running');
    expect((await drainWorker(sched, 'worker-1')).map((t) => t.outcome)).toEqual(['completed', 'completed']);
    expect((await getWorkflowRun(conn.db, owner, run.id)).run.status).toBe('completed');
    await expect(pauseWorkflowRun(conn.db, owner, run.id, 'late')).rejects.toMatchObject({ code: 'invalid_run_state' });

    const other = await startRun(twoStages);
    expect((await drainWorker(sched, 'worker-1', 1)).map((t) => t.outcome)).toEqual(['completed']);
    expect((await cancelWorkflowRun(conn.db, owner, other.run.id, 'scope dropped')).status).toBe('cancelled');
    expect((await taskOfStage(other.run.id, 'review')).status).toBe('cancelled');
    expect(await stepStatuses(other.run.id)).toEqual({ requirements: 'completed', review: 'cancelled' });
    expect(await drainWorker(sched, 'worker-1')).toEqual([]);
    await expect(resumeWorkflowRun(conn.db, owner, other.run.id)).rejects.toMatchObject({ code: 'invalid_run_state' });
  });

  it('pauses the run when the budget halts, keeps finished work, and resumes after a human raises it', async () => {
    const budgetProject = (
      await createProject({ db: conn.db, storage, initGit: false }, owner, { key: 'p5-budget', name: 'Budget' })
    ).id;
    await upsertBudget(conn.db, owner, { level: 'project', scopeRefId: budgetProject, tokenLimit: 4_000 });
    scripted.set('Expensive design', [
      { envelope: DEFAULT_REPLY['architect']!('Expensive design'), usage: { prompt: 1_900, completion: 500 } },
    ]);
    const { run } = await startRun(
      {
        stages: [
          stage('requirements', 'ba'),
          stage('design', 'architect', { title: 'Expensive design', dependsOn: ['requirements'] }),
          stage('review', 'review', { dependsOn: ['design'] }),
        ],
      },
      {},
      budgetProject,
    );

    // 1 500 + 2 400 = 3 900 of 4 000 tokens (97.5 %): the design is kept, the run is paused.
    let ticks = await drainWorker(sched, 'worker-1');
    expect(ticks.map((t) => t.outcome)).toEqual(['completed', 'completed']);
    expect((await getWorkflowRun(conn.db, owner, run.id)).run).toMatchObject({ status: 'paused', pausedReason: 'budget_halted' });
    expect((await taskOfStage(run.id, 'review')).status).toBe('ready');

    // Resuming without more budget changes nothing: the task is not consumed, no retry is spent.
    await resumeWorkflowRun(conn.db, owner, run.id);
    calls.length = 0;
    ticks = await drainWorker(sched, 'worker-1');
    expect(ticks.map((t) => t.outcome)).toEqual(['budget_paused']);
    expect(calls).toEqual([]);
    const review = await taskOfStage(run.id, 'review');
    expect(review).toMatchObject({ status: 'ready', retryCount: 0 });
    expect((await listTaskExecutions(conn.db, review.id))[0]!.failure).toMatchObject({ code: 'budget_blocked', retryable: false });
    expect((await getWorkflowRun(conn.db, owner, run.id)).run.status).toBe('paused');

    await upsertBudget(conn.db, owner, { level: 'project', scopeRefId: budgetProject, tokenLimit: 100_000 });
    await resumeWorkflowRun(conn.db, owner, run.id);
    expect((await drainWorker(sched, 'worker-1')).map((t) => t.outcome)).toEqual(['completed']);
    expect((await getWorkflowRun(conn.db, owner, run.id)).run.status).toBe('completed');
    expect((await conn.db.select().from(approvals).where(eq(approvals.projectId, budgetProject))).length).toBe(0);
  });
});
