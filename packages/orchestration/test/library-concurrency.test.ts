import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { seedAgentLibrary } from '@platform/agent-runtime';
import { createTestDatabase, type DatabaseConnection, taskExecutions, taskLeases, workflowSteps } from '@platform/db';
import { bootstrapOwner } from '@platform/iam';
import { createProject } from '@platform/projects';
import type { Actor } from '@platform/shared';
import { LocalStorage } from '@platform/storage';
import {
  claimNextTask,
  createWorkflow,
  getWorkflowRun,
  heartbeat,
  listWorkflows,
  planStages,
  recoverExpiredLeases,
  seedWorkflowLibrary,
  startWorkflowRun,
  validateWorkflowDefinition,
  type WorkflowDefinition,
} from '../src/index.js';

const LIBRARY = fileURLToPath(new URL('../../../agent-library', import.meta.url));
let conn: DatabaseConnection;
let dir: string;
let owner: Actor;
let projectId: string;

beforeAll(async () => {
  conn = await createTestDatabase();
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'orch-lib-'));
  const b = await bootstrapOwner(conn.db, { email: 'o@example.com', password: 'correct-horse-battery', displayName: 'O' });
  owner = { type: 'user', userId: b.user.id, workspaceId: b.workspaceId };
  projectId = (await createProject({ db: conn.db, storage: new LocalStorage(dir), initGit: false }, owner, { key: 'lib', name: 'Lib' })).id;
  await seedAgentLibrary(conn.db, owner, LIBRARY);
});

afterAll(async () => {
  await conn.close();
  await fs.rm(dir, { recursive: true, force: true });
});

describe('P7-07 default SDLC workflow library', () => {
  it('seeds idempotently and adapts the lifecycle to the change (Blueprint §8.2)', async () => {
    expect(await seedWorkflowLibrary(conn.db, owner, LIBRARY)).toEqual([{ key: 'sdlc-default', outcome: 'created', versionNo: 1 }]);
    expect(await seedWorkflowLibrary(conn.db, owner, LIBRARY)).toEqual([{ key: 'sdlc-default', outcome: 'unchanged', versionNo: 1 }]);
    const [workflow] = await listWorkflows(conn.db, owner);

    const def = (await import('yaml')).parse(await fs.readFile(path.join(LIBRARY, 'workflows', 'sdlc-default.yaml'), 'utf8'))
      .definition as WorkflowDefinition;
    validateWorkflowDefinition(def);
    const active = (vars: Record<string, unknown>) => planStages(def, vars).filter((p) => p.active).map((p) => p.stage.key);
    expect(active({ change_type: 'feature', touches_database: true })).toEqual([
      'requirements',
      'architecture',
      'database',
      'implementation',
      'integration',
      'review',
    ]);
    expect(active({ change_type: 'feature', touches_database: false })).not.toContain('database');
    // A bug fix goes straight to implementation, then integration and review.
    const bugfix = planStages(def, { change_type: 'bugfix' });
    expect(bugfix.filter((p) => p.active).map((p) => p.stage.key)).toEqual(['implementation', 'integration', 'review']);
    expect(bugfix.find((p) => p.stage.key === 'implementation')!.effectiveDependsOn).toEqual([]);

    const { run, steps } = await startWorkflowRun(conn.db, owner, { projectId, workflowId: workflow!.id, variables: { change_type: 'bugfix' } });
    expect(steps.filter((s) => s.status === 'skipped').map((s) => s.stageKey).sort()).toEqual(['architecture', 'database', 'requirements']);
    expect((await getWorkflowRun(conn.db, owner, run.id)).run.status).toBe('running');
  });
});

describe('P8-07 concurrency: claims and lease races', () => {
  async function parallelRun(n: number) {
    const definition: WorkflowDefinition = {
      stages: Array.from({ length: n }, (_, i) => ({ key: `s${i}`, agentKey: 'ba', title: `Par ${i}`, objective: 'x' })),
    };
    const { workflow } = await createWorkflow(conn.db, owner, { key: `par-${n}-${Date.now()}`, name: 'Par', definition });
    return startWorkflowRun(conn.db, owner, { projectId, workflowId: workflow.id });
  }

  it('never hands the same task to two workers, however many race for it', async () => {
    const { run } = await parallelRun(3);
    const now = new Date();
    const claims = await Promise.all(Array.from({ length: 8 }, (_, i) => claimNextTask(conn.db, `racer-${i}`, { now })));
    const won = claims.filter((c) => c !== null);
    const runTasks = (await conn.db.select().from(workflowSteps).where(eq(workflowSteps.runId, run.id))).map((s) => s.taskId);
    const ofRun = won.filter((c) => runTasks.includes(c!.task.id));
    expect(new Set(ofRun.map((c) => c!.task.id)).size).toBe(ofRun.length);
    expect(ofRun.length).toBe(3);
    for (const c of ofRun) {
      const execs = await conn.db.select().from(taskExecutions).where(eq(taskExecutions.taskId, c!.task.id));
      expect(execs.filter((e) => e.status === 'running')).toHaveLength(1);
      const leases = await conn.db.select().from(taskLeases).where(eq(taskLeases.taskId, c!.task.id));
      expect(leases).toHaveLength(1);
    }
  });

  it('a heartbeat that wins the race keeps the lease; concurrent recoveries recover once', async () => {
    const { run } = await parallelRun(1);
    const [step] = await conn.db.select().from(workflowSteps).where(eq(workflowSteps.runId, run.id));
    const t0 = new Date();
    let claim = await claimNextTask(conn.db, 'holder', { now: t0, leaseSeconds: 10 });
    while (claim && claim.task.id !== step!.taskId) claim = await claimNextTask(conn.db, 'holder', { now: t0, leaseSeconds: 10 });
    expect(claim).not.toBeNull();

    // After expiry, a heartbeat that lands before recovery saves the lease.
    const late = new Date(t0.getTime() + 11_000);
    expect(await heartbeat(conn.db, claim!.execution.id, { now: late, leaseSeconds: 10 })).toBe(true);
    expect((await recoverExpiredLeases(conn.db, late)).filter((r) => r.taskId === claim!.task.id)).toEqual([]);

    // Once truly expired, several recoverers at once recover the task exactly once.
    const later = new Date(late.getTime() + 11_000);
    const results = await Promise.all([1, 2, 3, 4].map(() => recoverExpiredLeases(conn.db, later)));
    const mine = results.flat().filter((r) => r.taskId === claim!.task.id);
    expect(mine).toHaveLength(1);
    const [exec] = await conn.db.select().from(taskExecutions).where(eq(taskExecutions.id, claim!.execution.id));
    expect(exec!.status).toBe('abandoned');
    expect(await heartbeat(conn.db, claim!.execution.id, { now: later })).toBe(false);
  });
});
