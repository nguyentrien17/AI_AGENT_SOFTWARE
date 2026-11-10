import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type DatabaseConnection, taskStatusValues } from '@platform/db';
import { bootstrapOwner, createUser } from '@platform/iam';
import { createProject, upsertProjectMember } from '@platform/projects';
import { type Actor, ForbiddenError } from '@platform/shared';
import { LocalStorage } from '@platform/storage';
import {
  addDependency,
  canTransition,
  createTask,
  getTask,
  getTaskHistory,
  isHumanTransition,
  recordGateEvaluation,
  TASK_TRANSITIONS,
  topologicalOrder,
  transitionTask,
  updateTask,
  wouldCreateCycle,
} from '../src/index.js';

describe('task state machine (pure)', () => {
  it('covers every status and has terminal states', () => {
    expect(Object.keys(TASK_TRANSITIONS).sort()).toEqual([...taskStatusValues].sort());
    expect(TASK_TRANSITIONS.completed).toEqual([]);
    expect(TASK_TRANSITIONS.cancelled).toEqual([]);
  });
  it('rejects illegal transitions', () => {
    expect(canTransition('draft', 'running')).toBe(false);
    expect(canTransition('pending', 'completed')).toBe(false);
    expect(canTransition('completed', 'ready')).toBe(false);
    expect(canTransition('running', 'completed')).toBe(true);
  });
  it('humans cannot self-declare completion or start execution', () => {
    expect(isHumanTransition('running', 'completed')).toBe(false);
    expect(isHumanTransition('ready', 'assigned')).toBe(false);
    expect(isHumanTransition('running', 'cancelled')).toBe(true);
    expect(isHumanTransition('failed', 'ready')).toBe(true);
  });
  it('detects cycles and orders DAGs', () => {
    const edges = new Map([
      ['c', ['b']],
      ['b', ['a']],
    ]);
    expect(wouldCreateCycle(edges, 'a', 'c')).toBe(true);
    expect(wouldCreateCycle(edges, 'a', 'a')).toBe(true);
    expect(wouldCreateCycle(edges, 'd', 'c')).toBe(false);
    expect(topologicalOrder(['a', 'b', 'c'], edges)).toEqual(['a', 'b', 'c']);
    expect(
      topologicalOrder(
        ['a', 'b'],
        new Map([
          ['a', ['b']],
          ['b', ['a']],
        ]),
      ),
    ).toBeNull();
  });
});

const PW = 'correct-horse-battery';
let conn: DatabaseConnection;
let dir: string;
let owner: Actor;
let dev: Actor;
let viewer: Actor;
let system: Actor;
let projectId: string;

beforeAll(async () => {
  conn = await createTestDatabase();
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tasks-test-'));
  const b = await bootstrapOwner(conn.db, { email: 'owner@example.com', password: PW, displayName: 'Owner' });
  owner = { type: 'user', userId: b.user.id, workspaceId: b.workspaceId };
  system = { type: 'system', workspaceId: b.workspaceId, component: 'test-scheduler' };
  const d = await createUser(conn.db, owner, {
    email: 'dev@example.com',
    displayName: 'Dev',
    password: PW,
    role: 'developer',
  });
  const v = await createUser(conn.db, owner, {
    email: 'v@example.com',
    displayName: 'V',
    password: PW,
    role: 'viewer',
  });
  dev = { type: 'user', userId: d.id, workspaceId: b.workspaceId };
  viewer = { type: 'user', userId: v.id, workspaceId: b.workspaceId };
  projectId = (
    await createProject({ db: conn.db, storage: new LocalStorage(dir), initGit: false }, owner, {
      key: 'tasks',
      name: 'Tasks',
    })
  ).id;
  await upsertProjectMember({ db: conn.db }, owner, projectId, { userId: d.id, role: 'developer' });
  await upsertProjectMember({ db: conn.db }, owner, projectId, { userId: v.id, role: 'viewer' });
});
afterAll(async () => {
  await conn.close();
  await fs.rm(dir, { recursive: true, force: true });
});

const base = { objective: 'do it', acceptanceCriteria: ['works'] };

describe('task service', () => {
  it('validates input and enforces bounded retries', async () => {
    await expect(createTask(conn.db, dev, projectId, { title: '', objective: '' })).rejects.toMatchObject({
      code: 'validation_error',
    });
    await expect(
      createTask(conn.db, dev, projectId, { title: 'x', objective: 'y', maxRetries: 99 }),
    ).rejects.toMatchObject({
      code: 'validation_error',
    });
    await expect(
      createTask(conn.db, viewer, projectId, { title: 'x', objective: 'y' }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('promotes through the DAG and blocks on cancellation', async () => {
    const a = await createTask(conn.db, dev, projectId, { title: 'A', ...base });
    const b = await createTask(conn.db, dev, projectId, { title: 'B', ...base });
    const c = await createTask(conn.db, dev, projectId, { title: 'C', ...base });
    await addDependency(conn.db, dev, b.id, a.id);
    await addDependency(conn.db, dev, c.id, b.id);
    await expect(addDependency(conn.db, dev, a.id, c.id)).rejects.toMatchObject({ code: 'dependency_cycle' });

    // A has no deps → auto-ready; B, C stay pending.
    expect((await transitionTask(conn.db, dev, a.id, 'pending')).status).toBe('ready');
    expect((await transitionTask(conn.db, dev, b.id, 'pending')).status).toBe('pending');
    expect((await transitionTask(conn.db, dev, c.id, 'pending')).status).toBe('pending');
    await expect(transitionTask(conn.db, dev, b.id, 'ready')).rejects.toMatchObject({
      code: 'invalid_state_transition',
    });

    // Execution transitions are system-only.
    await expect(transitionTask(conn.db, dev, a.id, 'assigned')).rejects.toBeInstanceOf(ForbiddenError);
    await transitionTask(conn.db, system, a.id, 'assigned');
    await transitionTask(conn.db, system, a.id, 'running');

    // Completion requires passing quality gate evidence.
    await expect(transitionTask(conn.db, system, a.id, 'completed')).rejects.toMatchObject({
      code: 'invalid_state_transition',
    });
    const evidence = {
      tool: 'vitest',
      toolVersion: '2.1',
      command: 'npm test',
      environmentId: 'local',
      gitTreeHash: null,
      logUri: null,
    };
    await recordGateEvaluation(conn.db, system, a.id, { gateKey: 'unit-tests', outcome: 'failed', evidence });
    await expect(transitionTask(conn.db, system, a.id, 'completed')).rejects.toThrow(/unit-tests=failed/);
    await recordGateEvaluation(conn.db, system, a.id, { gateKey: 'unit-tests', outcome: 'passed', evidence });
    await expect(
      recordGateEvaluation(conn.db, dev, a.id, { gateKey: 'x', outcome: 'passed', evidence }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect((await transitionTask(conn.db, system, a.id, 'completed')).status).toBe('completed');

    // B promoted automatically; C still pending.
    expect((await getTask(conn.db, dev, b.id)).status).toBe('ready');
    expect((await getTask(conn.db, dev, c.id)).status).toBe('pending');

    // Cancelling B blocks C.
    await transitionTask(conn.db, dev, b.id, 'cancelled', { reason: 'descoped' });
    expect((await getTask(conn.db, dev, c.id)).status).toBe('blocked');

    // Terminal tasks cannot move.
    await expect(transitionTask(conn.db, system, a.id, 'ready')).rejects.toMatchObject({
      code: 'invalid_state_transition',
    });

    const history = await getTaskHistory(conn.db, viewer, a.id);
    expect(history.map((h) => h.toStatus)).toEqual(['pending', 'ready', 'assigned', 'running', 'completed']);
  });

  it('bounds retries: failed → ready only while retries remain', async () => {
    const t = await createTask(conn.db, dev, projectId, { title: 'Retry', ...base, maxRetries: 1 });
    await transitionTask(conn.db, dev, t.id, 'pending');
    await transitionTask(conn.db, system, t.id, 'assigned');
    await transitionTask(conn.db, system, t.id, 'running');
    await transitionTask(conn.db, system, t.id, 'failed', { reason: 'tests failed' });
    const retried = await transitionTask(conn.db, dev, t.id, 'ready');
    expect(retried.retryCount).toBe(1);
    await transitionTask(conn.db, system, t.id, 'assigned');
    await transitionTask(conn.db, system, t.id, 'running');
    await transitionTask(conn.db, system, t.id, 'failed');
    await expect(transitionTask(conn.db, dev, t.id, 'ready')).rejects.toThrow(/max retries/);
    expect((await transitionTask(conn.db, system, t.id, 'waiting_for_input')).status).toBe(
      'waiting_for_input',
    );
  });

  it('agents cannot change status directly; edits respect status and version', async () => {
    const t = await createTask(conn.db, dev, projectId, { title: 'Edit', ...base });
    const agent: Actor = {
      type: 'agent',
      agentKey: 'developer',
      agentVersion: 1,
      workspaceId: owner.workspaceId!,
    };
    await expect(transitionTask(conn.db, agent, t.id, 'pending')).rejects.toBeInstanceOf(ForbiddenError);
    const u = await updateTask(conn.db, dev, t.id, { title: 'Edited', expectedVersion: t.version });
    await expect(
      updateTask(conn.db, dev, t.id, { title: 'stale', expectedVersion: t.version }),
    ).rejects.toMatchObject({ code: 'version_conflict' });
    await transitionTask(conn.db, dev, t.id, 'pending');
    await transitionTask(conn.db, system, t.id, 'assigned');
    await expect(
      updateTask(conn.db, dev, t.id, { title: 'late', expectedVersion: u.version + 2 }),
    ).rejects.toMatchObject({
      code: 'task_not_editable',
    });
  });
});
