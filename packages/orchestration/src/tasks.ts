import { and, asc, desc, eq, inArray } from 'drizzle-orm';
import {
  type Db,
  projects,
  qualityGateEvaluations,
  taskDependencies,
  tasks,
  type TaskStatus,
  taskStatusHistory,
} from '@platform/db';
import { authorize } from '@platform/iam';
import { audit, emitEvent } from '@platform/observability';
import {
  type Actor,
  actorId,
  ConflictError,
  ForbiddenError,
  InvalidStateTransitionError,
  NotFoundError,
  ValidationError,
  VersionConflictError,
} from '@platform/shared';
import {
  assertTransition,
  isHumanTransition,
  TERMINAL_STATUSES,
  wouldCreateCycle,
} from './task-state-machine.js';

export type Task = typeof tasks.$inferSelect;

export interface CreateTaskInput {
  title: string;
  objective: string;
  inputRefs?: Array<{ path: string; version?: number }>;
  expectedOutput?: Record<string, unknown>;
  acceptanceCriteria?: string[];
  agentRole?: string | null;
  allowedTools?: string[];
  tokenCeiling?: number | null;
  costCeiling?: string | null;
  timeoutSeconds?: number;
  maxRetries?: number;
  complexity?: 'trivial' | 'low' | 'medium' | 'high' | 'critical';
}

const MAX_RETRIES_CAP = 10;

function validateTaskInput(input: Partial<CreateTaskInput>, creating: boolean) {
  const errors: Array<{ path: string; message: string }> = [];
  if (creating || input.title !== undefined)
    if (!input.title?.trim()) errors.push({ path: 'title', message: 'required' });
  if (creating || input.objective !== undefined)
    if (!input.objective?.trim()) errors.push({ path: 'objective', message: 'required' });
  if (input.timeoutSeconds !== undefined && (input.timeoutSeconds < 1 || input.timeoutSeconds > 86_400)) {
    errors.push({ path: 'timeoutSeconds', message: 'must be 1..86400' });
  }
  if (input.maxRetries !== undefined && (input.maxRetries < 0 || input.maxRetries > MAX_RETRIES_CAP)) {
    errors.push({ path: 'maxRetries', message: `must be 0..${MAX_RETRIES_CAP} (bounded retries)` });
  }
  if (input.tokenCeiling != null && input.tokenCeiling < 1)
    errors.push({ path: 'tokenCeiling', message: 'must be positive' });
  if (input.costCeiling != null && !/^\d+(\.\d{1,6})?$/.test(input.costCeiling)) {
    errors.push({ path: 'costCeiling', message: 'must be a non-negative decimal' });
  }
  if (errors.length) throw new ValidationError('Invalid task input', errors);
}

async function loadTask(db: Db, taskId: string, lock = false): Promise<Task> {
  const q = db.select().from(tasks).where(eq(tasks.id, taskId));
  const [t] = lock ? await q.for('update') : await q;
  if (!t) throw new NotFoundError('Task', taskId);
  return t;
}

async function workspaceOf(db: Db, projectId: string): Promise<string> {
  const [p] = await db
    .select({ ws: projects.workspaceId, status: projects.status })
    .from(projects)
    .where(eq(projects.id, projectId));
  if (!p) throw new NotFoundError('Project', projectId);
  return p.ws;
}

export async function createTask(
  db: Db,
  actor: Actor,
  projectId: string,
  input: CreateTaskInput,
): Promise<Task> {
  await authorize(db, actor, 'task.write', { projectId });
  validateTaskInput(input, true);
  const [p] = await db.select({ status: projects.status }).from(projects).where(eq(projects.id, projectId));
  if (p?.status === 'archived') throw new ConflictError('Project is archived', 'project_archived');
  return db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Db;
    const [t] = await tx
      .insert(tasks)
      .values({
        projectId,
        title: input.title.trim(),
        objective: input.objective.trim(),
        inputRefs: input.inputRefs ?? [],
        expectedOutput: input.expectedOutput ?? {},
        acceptanceCriteria: input.acceptanceCriteria ?? [],
        agentRole: input.agentRole ?? null,
        allowedTools: input.allowedTools ?? [],
        tokenCeiling: input.tokenCeiling ?? null,
        costCeiling: input.costCeiling ?? null,
        timeoutSeconds: input.timeoutSeconds ?? 600,
        maxRetries: input.maxRetries ?? 2,
        complexity: input.complexity ?? 'medium',
        createdBy: actorId(actor),
      })
      .returning();
    await audit(tx, actor, {
      action: 'task.create',
      targetType: 'task',
      targetId: t!.id,
      projectId,
      payload: { title: t!.title },
    });
    await emitEvent(tx, {
      type: 'task.created',
      aggregateType: 'task',
      aggregateId: t!.id,
      workspaceId: await workspaceOf(tx, projectId),
      projectId,
    });
    return t!;
  });
}

export async function updateTask(
  db: Db,
  actor: Actor,
  taskId: string,
  input: Partial<CreateTaskInput> & { expectedVersion: number },
): Promise<Task> {
  const cur = await loadTask(db, taskId);
  await authorize(db, actor, 'task.write', { projectId: cur.projectId });
  if (!['draft', 'pending', 'blocked'].includes(cur.status)) {
    throw new ConflictError(`Task in status '${cur.status}' cannot be edited`, 'task_not_editable');
  }
  validateTaskInput(input, false);
  const { expectedVersion, ...fields } = input;
  const patch: Partial<typeof tasks.$inferInsert> = { version: expectedVersion + 1 };
  if (fields.title !== undefined) patch.title = fields.title.trim();
  if (fields.objective !== undefined) patch.objective = fields.objective.trim();
  if (fields.inputRefs !== undefined) patch.inputRefs = fields.inputRefs;
  if (fields.expectedOutput !== undefined) patch.expectedOutput = fields.expectedOutput;
  if (fields.acceptanceCriteria !== undefined) patch.acceptanceCriteria = fields.acceptanceCriteria;
  if (fields.agentRole !== undefined) patch.agentRole = fields.agentRole;
  if (fields.allowedTools !== undefined) patch.allowedTools = fields.allowedTools;
  if (fields.tokenCeiling !== undefined) patch.tokenCeiling = fields.tokenCeiling;
  if (fields.costCeiling !== undefined) patch.costCeiling = fields.costCeiling;
  if (fields.timeoutSeconds !== undefined) patch.timeoutSeconds = fields.timeoutSeconds;
  if (fields.maxRetries !== undefined) patch.maxRetries = fields.maxRetries;
  if (fields.complexity !== undefined) patch.complexity = fields.complexity;
  const [t] = await db
    .update(tasks)
    .set(patch)
    .where(and(eq(tasks.id, taskId), eq(tasks.version, expectedVersion)))
    .returning();
  if (!t) throw new VersionConflictError('Task', expectedVersion, cur.version);
  await audit(db, actor, {
    action: 'task.update',
    targetType: 'task',
    targetId: taskId,
    projectId: cur.projectId,
    payload: { fields: Object.keys(fields) },
  });
  return t;
}

export async function getTask(db: Db, actor: Actor, taskId: string): Promise<Task> {
  const t = await loadTask(db, taskId);
  await authorize(db, actor, 'task.read', { projectId: t.projectId });
  return t;
}

export async function listTasks(db: Db, actor: Actor, projectId: string, opts: { status?: TaskStatus } = {}) {
  await authorize(db, actor, 'task.read', { projectId });
  const conds = [eq(tasks.projectId, projectId)];
  if (opts.status) conds.push(eq(tasks.status, opts.status));
  return db
    .select()
    .from(tasks)
    .where(and(...conds))
    .orderBy(asc(tasks.createdAt));
}

export async function getTaskHistory(db: Db, actor: Actor, taskId: string) {
  const t = await loadTask(db, taskId);
  await authorize(db, actor, 'task.read', { projectId: t.projectId });
  return db
    .select()
    .from(taskStatusHistory)
    .where(eq(taskStatusHistory.taskId, taskId))
    .orderBy(asc(taskStatusHistory.createdAt));
}

// ---------------------------------------------------------------- dependencies

async function dependencyIds(db: Db, taskId: string): Promise<string[]> {
  const rows = await db
    .select({ d: taskDependencies.dependsOnTaskId })
    .from(taskDependencies)
    .where(eq(taskDependencies.taskId, taskId));
  return rows.map((r) => r.d);
}

async function unmetDependencies(db: Db, taskId: string): Promise<string[]> {
  const deps = await dependencyIds(db, taskId);
  if (!deps.length) return [];
  const rows = await db
    .select({ id: tasks.id, status: tasks.status })
    .from(tasks)
    .where(inArray(tasks.id, deps));
  return rows.filter((r) => r.status !== 'completed').map((r) => r.id);
}

export async function listDependencies(db: Db, actor: Actor, taskId: string) {
  const t = await loadTask(db, taskId);
  await authorize(db, actor, 'task.read', { projectId: t.projectId });
  const ids = await dependencyIds(db, taskId);
  if (!ids.length) return [];
  return db.select().from(tasks).where(inArray(tasks.id, ids));
}

export async function addDependency(
  db: Db,
  actor: Actor,
  taskId: string,
  dependsOnTaskId: string,
): Promise<void> {
  const t = await loadTask(db, taskId);
  await authorize(db, actor, 'task.write', { projectId: t.projectId });
  await db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Db;
    const task = await loadTask(tx, taskId, true);
    const dep = await loadTask(tx, dependsOnTaskId);
    if (dep.projectId !== task.projectId)
      throw new ValidationError('Dependencies must be within the same project');
    if (!['draft', 'pending', 'blocked'].includes(task.status)) {
      throw new ConflictError(
        `Cannot add dependencies to a task in status '${task.status}'`,
        'task_not_editable',
      );
    }
    if (dep.status === 'cancelled') throw new ValidationError('Cannot depend on a cancelled task');
    // Load the project's dependency graph and check for cycles before inserting.
    const projectTaskIds = (
      await tx.select({ id: tasks.id }).from(tasks).where(eq(tasks.projectId, task.projectId))
    ).map((r) => r.id);
    const edgesRows = projectTaskIds.length
      ? await tx.select().from(taskDependencies).where(inArray(taskDependencies.taskId, projectTaskIds))
      : [];
    const edges = new Map<string, string[]>();
    for (const e of edgesRows) edges.set(e.taskId, [...(edges.get(e.taskId) ?? []), e.dependsOnTaskId]);
    if (wouldCreateCycle(edges, taskId, dependsOnTaskId)) {
      throw new ConflictError('Adding this dependency would create a cycle', 'dependency_cycle');
    }
    await tx.insert(taskDependencies).values({ taskId, dependsOnTaskId }).onConflictDoNothing();
    await audit(tx, actor, {
      action: 'task.dependency.add',
      targetType: 'task',
      targetId: taskId,
      projectId: task.projectId,
      payload: { dependsOnTaskId },
    });
  });
}

export async function removeDependency(
  db: Db,
  actor: Actor,
  taskId: string,
  dependsOnTaskId: string,
): Promise<void> {
  const t = await loadTask(db, taskId);
  await authorize(db, actor, 'task.write', { projectId: t.projectId });
  const removed = await db
    .delete(taskDependencies)
    .where(and(eq(taskDependencies.taskId, taskId), eq(taskDependencies.dependsOnTaskId, dependsOnTaskId)))
    .returning();
  if (!removed.length) throw new NotFoundError('Dependency', `${taskId}->${dependsOnTaskId}`);
  await audit(db, actor, {
    action: 'task.dependency.remove',
    targetType: 'task',
    targetId: taskId,
    projectId: t.projectId,
    payload: { dependsOnTaskId },
  });
}

// ---------------------------------------------------------------- transitions

export interface TransitionOptions {
  reason?: string;
  expectedVersion?: number;
}

const SYSTEM_PROMOTER: (ws: string | null) => Actor = (ws) => ({
  type: 'system',
  workspaceId: ws,
  component: 'dependency-manager',
});

async function applyTransition(
  tx: Db,
  actor: Actor,
  task: Task,
  to: TaskStatus,
  reason: string | null,
): Promise<Task> {
  assertTransition(task.status, to);
  const patch: Partial<typeof tasks.$inferInsert> = {
    status: to,
    statusReason: reason,
    version: task.version + 1,
  };

  if (to === 'ready' && (task.status === 'pending' || task.status === 'blocked')) {
    const unmet = await unmetDependencies(tx, task.id);
    if (unmet.length)
      throw new InvalidStateTransitionError(
        'Task',
        task.status,
        to,
        `unmet dependencies: ${unmet.join(', ')}`,
      );
  }
  if (task.status === 'failed' && to === 'ready') {
    if (task.retryCount >= task.maxRetries) {
      throw new InvalidStateTransitionError(
        'Task',
        task.status,
        to,
        `max retries (${task.maxRetries}) exhausted; use waiting_for_input`,
      );
    }
    patch.retryCount = task.retryCount + 1;
  }
  if (to === 'completed') {
    // Blueprint §12.1: completion requires passing quality gate evidence, never an agent's claim.
    const evals = await tx
      .select()
      .from(qualityGateEvaluations)
      .where(eq(qualityGateEvaluations.taskId, task.id))
      .orderBy(desc(qualityGateEvaluations.evaluatedAt), desc(qualityGateEvaluations.id));
    const latestByGate = new Map<string, (typeof evals)[number]>();
    for (const e of evals) if (!latestByGate.has(e.gateKey)) latestByGate.set(e.gateKey, e);
    if (latestByGate.size === 0) {
      throw new InvalidStateTransitionError('Task', task.status, to, 'no quality gate evaluation recorded');
    }
    const notPassed = [...latestByGate.values()].filter((e) => e.outcome !== 'passed');
    if (notPassed.length) {
      throw new InvalidStateTransitionError(
        'Task',
        task.status,
        to,
        `quality gates not passed: ${notPassed.map((e) => `${e.gateKey}=${e.outcome}`).join(', ')}`,
      );
    }
  }

  const [updated] = await tx
    .update(tasks)
    .set(patch)
    .where(and(eq(tasks.id, task.id), eq(tasks.version, task.version)))
    .returning();
  if (!updated) throw new VersionConflictError('Task', task.version, task.version + 1);
  await tx.insert(taskStatusHistory).values({
    taskId: task.id,
    fromStatus: task.status,
    toStatus: to,
    reason,
    actorType: actor.type,
    actorId: actorId(actor),
  });
  await audit(tx, actor, {
    action: 'task.transition',
    targetType: 'task',
    targetId: task.id,
    projectId: task.projectId,
    payload: { from: task.status, to, reason },
  });
  const ws = await workspaceOf(tx, task.projectId);
  await emitEvent(tx, {
    type: to === 'completed' ? 'task.completed' : 'task.status_changed',
    aggregateType: 'task',
    aggregateId: task.id,
    workspaceId: ws,
    projectId: task.projectId,
    payload: { from: task.status, to },
  });
  return updated;
}

/** After a status change, propagate effects through the DAG (promotion / blocking). */
async function propagate(tx: Db, task: Task): Promise<void> {
  const dependents = await tx
    .select({ id: taskDependencies.taskId })
    .from(taskDependencies)
    .where(eq(taskDependencies.dependsOnTaskId, task.id));
  const ws = await workspaceOf(tx, task.projectId);
  for (const { id } of dependents) {
    const dep = await loadTask(tx, id, true);
    if (
      task.status === 'completed' &&
      dep.status === 'pending' &&
      (await unmetDependencies(tx, id)).length === 0
    ) {
      const promoted = await applyTransition(
        tx,
        SYSTEM_PROMOTER(ws),
        dep,
        'ready',
        'all dependencies completed',
      );
      await propagate(tx, promoted);
    } else if (task.status === 'cancelled' && (dep.status === 'pending' || dep.status === 'ready')) {
      await applyTransition(tx, SYSTEM_PROMOTER(ws), dep, 'blocked', `dependency ${task.id} was cancelled`);
    }
  }
}

/**
 * Validated state transition. Humans may only request the transitions in HUMAN_TRANSITIONS;
 * system actors (scheduler, runtime, approval manager) drive the rest.
 */
export async function transitionTask(
  db: Db,
  actor: Actor,
  taskId: string,
  to: TaskStatus,
  opts: TransitionOptions = {},
): Promise<Task> {
  const pre = await loadTask(db, taskId);
  if (actor.type === 'user') {
    await authorize(db, actor, 'task.transition', { projectId: pre.projectId });
  } else if (actor.type === 'agent') {
    throw new ForbiddenError(
      'Agents cannot change task status directly; they report results to the orchestrator',
    );
  }
  return db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Db;
    const task = await loadTask(tx, taskId, true);
    if (opts.expectedVersion !== undefined && opts.expectedVersion !== task.version) {
      throw new VersionConflictError('Task', opts.expectedVersion, task.version);
    }
    if (TERMINAL_STATUSES.has(task.status))
      throw new InvalidStateTransitionError('Task', task.status, to, 'task is terminal');
    assertTransition(task.status, to); // structural validity first (409), then actor permission (403)
    if (actor.type === 'user' && !isHumanTransition(task.status, to)) {
      throw new ForbiddenError(
        `Transition '${task.status}' → '${to}' is reserved for the orchestration system`,
      );
    }
    let updated = await applyTransition(tx, actor, task, to, opts.reason ?? null);
    // Auto-promotion: a pending task with all dependencies met becomes ready immediately.
    if (updated.status === 'pending' && (await unmetDependencies(tx, taskId)).length === 0) {
      updated = await applyTransition(
        tx,
        SYSTEM_PROMOTER(actor.workspaceId),
        updated,
        'ready',
        'no unmet dependencies',
      );
    }
    await propagate(tx, updated);
    return updated;
  });
}

/**
 * Records immutable quality gate evidence. System-only: in Phase 8 this is invoked by the Quality Gate
 * Engine after running deterministic tools.
 */
export async function recordGateEvaluation(
  db: Db,
  actor: Actor,
  taskId: string,
  input: {
    gateKey: string;
    outcome: 'passed' | 'failed' | 'warning' | 'blocked' | 'requires_approval';
    evidence: {
      tool: string;
      toolVersion: string;
      command: string;
      environmentId: string;
      gitTreeHash: string | null;
      logUri: string | null;
      /** Gate-specific details (summary, findings…) kept with the evidence. */
      [detail: string]: unknown;
    };
  },
) {
  if (actor.type !== 'system')
    throw new ForbiddenError('Only the quality gate engine may record gate evaluations');
  const task = await loadTask(db, taskId);
  const [row] = await db
    .insert(qualityGateEvaluations)
    .values({
      taskId,
      gateKey: input.gateKey,
      outcome: input.outcome,
      evidence: { ...input.evidence, timestamp: new Date().toISOString() },
    })
    .returning();
  await audit(db, actor, {
    action: 'quality_gate.evaluated',
    targetType: 'task',
    targetId: taskId,
    projectId: task.projectId,
    payload: { gateKey: input.gateKey, outcome: input.outcome },
  });
  return row!;
}
