import { and, desc, eq, inArray } from 'drizzle-orm';
import { resolveAgent } from '@platform/agent-runtime';
import {
  approvals,
  type Db,
  projects,
  taskDependencies,
  tasks,
  workflowRuns,
  workflows,
  workflowSteps,
  workflowVersions,
} from '@platform/db';
import { authorize } from '@platform/iam';
import { audit, emitEvent } from '@platform/observability';
import {
  type Actor,
  actorId,
  ConflictError,
  hashJson,
  NotFoundError,
  UnprocessableError,
  ValidationError,
} from '@platform/shared';
import { type GateKey, validateGateKeys } from '@platform/quality-gates';
import { topologicalOrder } from './task-state-machine.js';
import { transitionTask } from './tasks.js';

// ---------------------------------------------------------------- definition (pure)

export type Condition =
  | { var: string; equals?: unknown; notEquals?: unknown; in?: unknown[]; exists?: boolean }
  | { all: Condition[] }
  | { any: Condition[] }
  | { not: Condition };

export interface StageDefinition {
  key: string;
  title: string;
  objective: string;
  /**
   * `agent` (default): executed by the agent named in `agentKey`. `integration`: executed by the platform —
   * merges the run's finished task branches into the integration branch (Blueprint §8.1 stage 6).
   */
  kind?: 'agent' | 'integration';
  /**
   * Agent registry key; required for agent stages (enforced by validation). The model is resolved at run
   * time by the Model Router, never here.
   */
  agentKey?: string;
  /** Extra deterministic Quality Gates (Blueprint §12.2) on top of the defaults for workspace changes. */
  gates?: GateKey[];
  dependsOn?: string[];
  /** Conditional branching: the stage is skipped when this evaluates to false on the run variables. */
  when?: Condition;
  /** `human` inserts an approval gate after the agent finishes (Blueprint §8.2). */
  approval?: 'none' | 'human';
  nextAgent?: string;
  inputRefs?: Array<{ path: string; version?: number }>;
  expectedOutput?: Record<string, unknown>;
  acceptanceCriteria?: string[];
  complexity?: 'trivial' | 'low' | 'medium' | 'high' | 'critical';
  riskLevel?: 'low' | 'medium' | 'high' | 'critical';
  taskKind?: string;
  essential?: boolean;
  qualityGateCritical?: boolean;
  maxRetries?: number;
  timeoutSeconds?: number;
}

export interface WorkflowDefinition {
  stages: StageDefinition[];
}

const KEY_RE = /^[a-z][a-z0-9_-]{0,59}$/;
const MAX_STAGES = 100;

function conditionErrors(cond: unknown, path: string): string[] {
  if (typeof cond !== 'object' || cond === null || Array.isArray(cond)) return [`${path}: must be an object`];
  const c = cond as Record<string, unknown>;
  if ('all' in c || 'any' in c) {
    const list = (c['all'] ?? c['any']) as unknown;
    if (!Array.isArray(list) || list.length === 0) return [`${path}: all/any needs a non-empty list`];
    return list.flatMap((x, i) => conditionErrors(x, `${path}[${i}]`));
  }
  if ('not' in c) return conditionErrors(c['not'], `${path}.not`);
  if (typeof c['var'] !== 'string' || !c['var']) return [`${path}: 'var' is required`];
  const ops = ['equals', 'notEquals', 'in', 'exists'].filter((k) => k in c);
  if (ops.length !== 1) return [`${path}: exactly one of equals, notEquals, in, exists is required`];
  if ('in' in c && !Array.isArray(c['in'])) return [`${path}: 'in' must be a list`];
  return [];
}

/** Structural validation of a workflow definition, including cycle detection before any execution. */
export function validateWorkflowDefinition(input: unknown): WorkflowDefinition {
  const errors: Array<{ path: string; message: string }> = [];
  const stages = (input as { stages?: unknown } | null)?.stages;
  if (!Array.isArray(stages) || stages.length === 0 || stages.length > MAX_STAGES) {
    throw new ValidationError(`A workflow needs 1..${MAX_STAGES} stages`);
  }
  const keys = new Set<string>();
  for (const [i, raw] of stages.entries()) {
    const s = raw as Partial<StageDefinition>;
    const at = `stages[${i}]`;
    if (typeof s.key !== 'string' || !KEY_RE.test(s.key)) errors.push({ path: `${at}.key`, message: 'invalid key' });
    else if (keys.has(s.key)) errors.push({ path: `${at}.key`, message: `duplicate stage '${s.key}'` });
    else keys.add(s.key);
    if (s.kind !== undefined && s.kind !== 'agent' && s.kind !== 'integration') {
      errors.push({ path: `${at}.kind`, message: "must be 'agent' or 'integration'" });
    }
    const required = s.kind === 'integration' ? (['title', 'objective'] as const) : (['title', 'objective', 'agentKey'] as const);
    for (const field of required) {
      if (typeof s[field] !== 'string' || !s[field]?.trim()) errors.push({ path: `${at}.${field}`, message: 'required' });
    }
    try {
      validateGateKeys(s.gates);
    } catch (err) {
      errors.push({ path: `${at}.gates`, message: err instanceof Error ? err.message : 'invalid' });
    }
    if (s.approval !== undefined && s.approval !== 'none' && s.approval !== 'human') {
      errors.push({ path: `${at}.approval`, message: "must be 'none' or 'human'" });
    }
    if (s.maxRetries !== undefined && (!Number.isInteger(s.maxRetries) || s.maxRetries < 0 || s.maxRetries > 10)) {
      errors.push({ path: `${at}.maxRetries`, message: 'must be 0..10 (bounded retries)' });
    }
    if (s.when !== undefined) {
      for (const message of conditionErrors(s.when, 'when')) errors.push({ path: `${at}.when`, message });
    }
  }
  const def = input as WorkflowDefinition;
  for (const [i, s] of def.stages.entries()) {
    for (const dep of s.dependsOn ?? []) {
      if (!keys.has(dep)) errors.push({ path: `stages[${i}].dependsOn`, message: `unknown stage '${dep}'` });
      if (dep === s.key) errors.push({ path: `stages[${i}].dependsOn`, message: 'a stage cannot depend on itself' });
    }
  }
  if (errors.length) throw new ValidationError('Invalid workflow definition', errors);
  const edges = new Map(def.stages.map((s) => [s.key, s.dependsOn ?? []]));
  if (!topologicalOrder([...keys], edges)) {
    throw new ValidationError('Workflow definition contains a circular dependency');
  }
  return def;
}

function lookup(vars: Record<string, unknown>, path: string): unknown {
  let cur: unknown = vars;
  for (const part of path.split('.')) {
    if (typeof cur !== 'object' || cur === null) return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

export function evaluateCondition(cond: Condition, vars: Record<string, unknown>): boolean {
  if ('all' in cond) return cond.all.every((c) => evaluateCondition(c, vars));
  if ('any' in cond) return cond.any.some((c) => evaluateCondition(c, vars));
  if ('not' in cond) return !evaluateCondition(cond.not, vars);
  const value = lookup(vars, cond.var);
  if ('equals' in cond) return value === cond.equals;
  if ('notEquals' in cond) return value !== cond.notEquals;
  if ('in' in cond) return (cond.in ?? []).includes(value);
  return (value !== undefined && value !== null) === cond.exists;
}

export interface PlannedStage {
  stage: StageDefinition;
  position: number;
  active: boolean;
  skipReason: string | null;
  /** Active stages this one waits for; a skipped dependency is replaced by what it depended on. */
  effectiveDependsOn: string[];
}

/**
 * Applies conditional branching to a definition for one run (Blueprint §8.2 adaptive execution): inactive
 * stages are skipped and the dependency graph is rewired around them so nothing waits for a skipped stage.
 */
export function planStages(def: WorkflowDefinition, vars: Record<string, unknown>): PlannedStage[] {
  const byKey = new Map(def.stages.map((s) => [s.key, s]));
  const order = topologicalOrder(
    def.stages.map((s) => s.key),
    new Map(def.stages.map((s) => [s.key, s.dependsOn ?? []])),
  )!;
  const active = new Map<string, boolean>();
  for (const s of def.stages) active.set(s.key, s.when ? evaluateCondition(s.when, vars) : true);

  const resolved = new Map<string, string[]>();
  const effective = (key: string): string[] => {
    const cached = resolved.get(key);
    if (cached) return cached;
    const out = new Set<string>();
    for (const dep of byKey.get(key)!.dependsOn ?? []) {
      if (active.get(dep)) out.add(dep);
      else for (const d of effective(dep)) out.add(d);
    }
    const list = [...out].sort();
    resolved.set(key, list);
    return list;
  };

  return order.map((key, position) => ({
    stage: byKey.get(key)!,
    position,
    active: active.get(key)!,
    skipReason: active.get(key) ? null : 'condition evaluated to false',
    effectiveDependsOn: effective(key),
  }));
}

// ---------------------------------------------------------------- definitions & versions

export type Workflow = typeof workflows.$inferSelect;
export type WorkflowVersion = typeof workflowVersions.$inferSelect;
export type WorkflowRun = typeof workflowRuns.$inferSelect;
export type WorkflowStep = typeof workflowSteps.$inferSelect;

function workspaceOf(actor: Actor): string {
  if (!actor.workspaceId) throw new ValidationError('A workspace context is required');
  return actor.workspaceId;
}

async function insertWorkflowVersion(tx: Db, actor: Actor, wf: Workflow, def: WorkflowDefinition) {
  const [latest] = await tx
    .select({ no: workflowVersions.versionNo })
    .from(workflowVersions)
    .where(eq(workflowVersions.workflowId, wf.id))
    .orderBy(desc(workflowVersions.versionNo))
    .limit(1);
  const [created] = await tx
    .insert(workflowVersions)
    .values({
      workflowId: wf.id,
      versionNo: (latest?.no ?? 0) + 1,
      definition: def as unknown as Record<string, unknown>,
      contentHash: hashJson(def),
      createdBy: actorId(actor),
    })
    .returning();
  await tx
    .update(workflows)
    .set({ currentVersionId: created!.id, updatedAt: new Date(), version: wf.version + 1 })
    .where(eq(workflows.id, wf.id));
  return created!;
}

export async function createWorkflow(
  db: Db,
  actor: Actor,
  input: { key: string; name: string; description?: string; definition: unknown },
): Promise<{ workflow: Workflow; version: WorkflowVersion }> {
  await authorize(db, actor, 'ai.config.manage');
  const workspaceId = workspaceOf(actor);
  const key = input.key.trim().toLowerCase();
  if (!KEY_RE.test(key)) throw new ValidationError('Workflow key must start with a letter: lowercase letters, digits, - or _');
  if (!input.name.trim()) throw new ValidationError('name is required');
  const def = validateWorkflowDefinition(input.definition);
  return db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Db;
    const [dup] = await tx
      .select({ id: workflows.id })
      .from(workflows)
      .where(and(eq(workflows.workspaceId, workspaceId), eq(workflows.key, key)))
      .limit(1);
    if (dup) throw new ConflictError(`Workflow '${key}' already exists`, 'workflow_exists');
    const [wf] = await tx
      .insert(workflows)
      .values({ workspaceId, key, name: input.name.trim(), description: input.description?.trim() ?? '' })
      .returning();
    const version = await insertWorkflowVersion(tx, actor, wf!, def);
    await audit(tx, actor, {
      action: 'workflow.created',
      targetType: 'workflow',
      targetId: wf!.id,
      payload: { key, versionNo: 1, stages: def.stages.length },
    });
    return { workflow: { ...wf!, currentVersionId: version.id }, version };
  });
}

async function loadWorkflow(db: Db, workspaceId: string, workflowId: string): Promise<Workflow> {
  const [wf] = await db
    .select()
    .from(workflows)
    .where(and(eq(workflows.id, workflowId), eq(workflows.workspaceId, workspaceId)))
    .limit(1);
  if (!wf) throw new NotFoundError('Workflow', workflowId);
  return wf;
}

/** Publishes a new immutable definition version; running runs keep the version they started with. */
export async function publishWorkflowVersion(
  db: Db,
  actor: Actor,
  workflowId: string,
  definition: unknown,
): Promise<WorkflowVersion> {
  await authorize(db, actor, 'ai.config.manage');
  const def = validateWorkflowDefinition(definition);
  return db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Db;
    const wf = await loadWorkflow(tx, workspaceOf(actor), workflowId);
    if (wf.currentVersionId) {
      // Re-publishing an identical definition is a no-op, which keeps seeding idempotent.
      const [current] = await tx.select().from(workflowVersions).where(eq(workflowVersions.id, wf.currentVersionId));
      if (current?.contentHash === hashJson(def)) return current;
    }
    const version = await insertWorkflowVersion(tx, actor, wf, def);
    await audit(tx, actor, {
      action: 'workflow.version_published',
      targetType: 'workflow',
      targetId: wf.id,
      payload: { key: wf.key, versionNo: version.versionNo },
    });
    return version;
  });
}

export async function listWorkflows(db: Db, actor: Actor): Promise<Workflow[]> {
  await authorize(db, actor, 'ai.config.read');
  return db.select().from(workflows).where(eq(workflows.workspaceId, workspaceOf(actor))).orderBy(workflows.key);
}

export async function getWorkflow(db: Db, actor: Actor, workflowId: string) {
  await authorize(db, actor, 'ai.config.read');
  const workflow = await loadWorkflow(db, workspaceOf(actor), workflowId);
  const versions = await db
    .select()
    .from(workflowVersions)
    .where(eq(workflowVersions.workflowId, workflow.id))
    .orderBy(desc(workflowVersions.versionNo));
  return { workflow, versions };
}

// ---------------------------------------------------------------- runs

const ORCHESTRATOR = (workspaceId: string | null): Actor => ({
  type: 'system',
  workspaceId,
  component: 'workflow-engine',
});

async function projectWorkspace(db: Db, projectId: string): Promise<string> {
  const [p] = await db.select({ ws: projects.workspaceId }).from(projects).where(eq(projects.id, projectId));
  if (!p) throw new NotFoundError('Project', projectId);
  return p.ws;
}

/**
 * Starts a run: evaluates branching, materialises one step per stage and one task per active stage, wires
 * the task DAG, then releases the tasks so independent stages become `ready` in parallel.
 */
export async function startWorkflowRun(
  db: Db,
  actor: Actor,
  input: { projectId: string; workflowId: string; variables?: Record<string, unknown> },
): Promise<{ run: WorkflowRun; steps: WorkflowStep[] }> {
  await authorize(db, actor, 'task.write', { projectId: input.projectId });
  const workspaceId = await projectWorkspace(db, input.projectId);
  const workflow = await loadWorkflow(db, workspaceId, input.workflowId);
  if (!workflow.currentVersionId) throw new UnprocessableError('Workflow has no published version', 'workflow_unpublished');
  const [version] = await db.select().from(workflowVersions).where(eq(workflowVersions.id, workflow.currentVersionId));
  const def = validateWorkflowDefinition(version!.definition);
  const variables = input.variables ?? {};
  const plan = planStages(def, variables);
  if (!plan.some((p) => p.active)) {
    throw new UnprocessableError('Every stage of the workflow is skipped for these variables', 'workflow_empty');
  }

  // Resolve agents up front: a run never starts with a stage nobody can execute.
  const roleOf = new Map<string, string>();
  for (const p of plan.filter((x) => x.active)) {
    if (p.stage.kind === 'integration') {
      roleOf.set(p.stage.key, 'orchestrator');
      continue;
    }
    const resolved = await resolveAgent(db, workspaceId, { agentKey: p.stage.agentKey });
    if (!resolved) {
      throw new UnprocessableError(
        `Stage '${p.stage.key}' needs agent '${p.stage.agentKey}', which is not registered and active`,
        'agent_unavailable',
        { stage: p.stage.key, agentKey: p.stage.agentKey },
      );
    }
    roleOf.set(p.stage.key, resolved.agent.role);
  }

  const created = await db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Db;
    const [run] = await tx
      .insert(workflowRuns)
      .values({
        projectId: input.projectId,
        workflowVersionId: version!.id,
        variables,
        startedByType: actor.type,
        startedById: actorId(actor),
      })
      .returning();
    const taskIdByStage = new Map<string, string>();
    const steps: WorkflowStep[] = [];
    for (const p of plan) {
      const [step] = await tx
        .insert(workflowSteps)
        .values({
          runId: run!.id,
          stageKey: p.stage.key,
          position: p.position,
          status: p.active ? 'pending' : 'skipped',
          config: p.stage as unknown as Record<string, unknown>,
          skipReason: p.skipReason,
        })
        .returning();
      if (!p.active) {
        steps.push(step!);
        continue;
      }
      const [task] = await tx
        .insert(tasks)
        .values({
          projectId: input.projectId,
          workflowRunId: run!.id,
          workflowStepId: step!.id,
          title: p.stage.title.trim(),
          objective: p.stage.objective.trim(),
          inputRefs: p.stage.inputRefs ?? [],
          expectedOutput: p.stage.expectedOutput ?? {},
          acceptanceCriteria: p.stage.acceptanceCriteria ?? [],
          agentRole: roleOf.get(p.stage.key)!,
          timeoutSeconds: p.stage.timeoutSeconds ?? 600,
          maxRetries: p.stage.maxRetries ?? 2,
          complexity: p.stage.complexity ?? 'medium',
          createdBy: actorId(actor),
        })
        .returning();
      taskIdByStage.set(p.stage.key, task!.id);
      const [linked] = await tx
        .update(workflowSteps)
        .set({ taskId: task!.id })
        .where(eq(workflowSteps.id, step!.id))
        .returning();
      steps.push(linked!);
      for (const dep of p.effectiveDependsOn) {
        await tx.insert(taskDependencies).values({ taskId: task!.id, dependsOnTaskId: taskIdByStage.get(dep)! });
      }
    }
    await audit(tx, actor, {
      action: 'workflow.run_started',
      targetType: 'workflow_run',
      targetId: run!.id,
      projectId: input.projectId,
      payload: {
        workflowKey: workflow.key,
        versionNo: version!.versionNo,
        active: plan.filter((p) => p.active).map((p) => p.stage.key),
        skipped: plan.filter((p) => !p.active).map((p) => p.stage.key),
      },
    });
    await emitEvent(tx, {
      type: 'workflow.run_started',
      aggregateType: 'workflow_run',
      aggregateId: run!.id,
      workspaceId,
      projectId: input.projectId,
      payload: { workflowKey: workflow.key, versionNo: version!.versionNo },
    });
    return { run: run!, steps, taskIds: plan.filter((p) => p.active).map((p) => taskIdByStage.get(p.stage.key)!) };
  });

  // Release in topological order; tasks without unmet dependencies are promoted to `ready` immediately.
  for (const taskId of created.taskIds) {
    await transitionTask(db, ORCHESTRATOR(workspaceId), taskId, 'pending', { reason: 'workflow run started' });
  }
  return { run: created.run, steps: created.steps };
}

async function loadRun(db: Db, runId: string): Promise<WorkflowRun> {
  const [run] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, runId)).limit(1);
  if (!run) throw new NotFoundError('Workflow run', runId);
  return run;
}

export async function getWorkflowRun(db: Db, actor: Actor, runId: string) {
  const run = await loadRun(db, runId);
  await authorize(db, actor, 'task.read', { projectId: run.projectId });
  const steps = await db.select().from(workflowSteps).where(eq(workflowSteps.runId, run.id)).orderBy(workflowSteps.position);
  return { run, steps };
}

export async function listWorkflowRuns(db: Db, actor: Actor, projectId: string): Promise<WorkflowRun[]> {
  await authorize(db, actor, 'task.read', { projectId });
  return db
    .select()
    .from(workflowRuns)
    .where(eq(workflowRuns.projectId, projectId))
    .orderBy(desc(workflowRuns.startedAt), desc(workflowRuns.id));
}

async function setRunStatus(
  db: Db,
  actor: Actor,
  run: WorkflowRun,
  status: WorkflowRun['status'],
  reason: string | null,
): Promise<WorkflowRun> {
  const terminal = status === 'completed' || status === 'failed' || status === 'cancelled';
  return db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Db;
    const [updated] = await tx
      .update(workflowRuns)
      .set({
        status,
        pausedReason: status === 'paused' ? reason : null,
        endedAt: terminal ? new Date() : null,
        updatedAt: new Date(),
        version: run.version + 1,
      })
      .where(eq(workflowRuns.id, run.id))
      .returning();
    await audit(tx, actor, {
      action: `workflow.run_${status}`,
      targetType: 'workflow_run',
      targetId: run.id,
      projectId: run.projectId,
      payload: { from: run.status, to: status, reason },
    });
    await emitEvent(tx, {
      type: `workflow.run_${status}`,
      aggregateType: 'workflow_run',
      aggregateId: run.id,
      workspaceId: await projectWorkspace(tx, run.projectId),
      projectId: run.projectId,
      payload: { from: run.status, to: status, reason },
    });
    return updated!;
  });
}

/** Stops new task scheduling for the run; work already in flight finishes and is recorded. */
export async function pauseWorkflowRun(db: Db, actor: Actor, runId: string, reason: string): Promise<WorkflowRun> {
  const run = await loadRun(db, runId);
  await authorize(db, actor, 'task.transition', { projectId: run.projectId });
  if (run.status === 'paused') return run;
  if (run.status !== 'running') throw new ConflictError(`A ${run.status} run cannot be paused`, 'invalid_run_state');
  return setRunStatus(db, actor, run, 'paused', reason.trim() || 'paused');
}

export async function resumeWorkflowRun(db: Db, actor: Actor, runId: string): Promise<WorkflowRun> {
  const run = await loadRun(db, runId);
  await authorize(db, actor, 'task.transition', { projectId: run.projectId });
  if (run.status === 'running') return run;
  if (run.status !== 'paused' && run.status !== 'failed') {
    throw new ConflictError(`A ${run.status} run cannot be resumed`, 'invalid_run_state');
  }
  return setRunStatus(db, actor, run, 'running', null);
}

export async function cancelWorkflowRun(db: Db, actor: Actor, runId: string, reason: string): Promise<WorkflowRun> {
  const run = await loadRun(db, runId);
  await authorize(db, actor, 'task.transition', { projectId: run.projectId });
  if (run.status === 'completed' || run.status === 'cancelled') {
    throw new ConflictError(`A ${run.status} run cannot be cancelled`, 'invalid_run_state');
  }
  const workspaceId = await projectWorkspace(db, run.projectId);
  const steps = await db.select().from(workflowSteps).where(eq(workflowSteps.runId, run.id));
  const taskIds = steps.map((s) => s.taskId).filter((id): id is string => id !== null);
  const open = taskIds.length
    ? await db.select().from(tasks).where(and(inArray(tasks.id, taskIds), inArray(tasks.status, [...OPEN_TASK_STATUSES])))
    : [];
  for (const task of open) {
    await transitionTask(db, ORCHESTRATOR(workspaceId), task.id, 'cancelled', { reason: `run cancelled: ${reason}` });
  }
  await db
    .update(workflowSteps)
    .set({ status: 'cancelled', updatedAt: new Date() })
    .where(and(eq(workflowSteps.runId, run.id), inArray(workflowSteps.status, [...OPEN_STEP_STATUSES])));
  await db
    .update(approvals)
    .set({ status: 'cancelled', comment: `run cancelled: ${reason}`, decidedAt: new Date() })
    .where(and(eq(approvals.runId, run.id), eq(approvals.status, 'pending')));
  return setRunStatus(db, actor, run, 'cancelled', reason);
}

const OPEN_TASK_STATUSES = [
  'draft',
  'pending',
  'ready',
  'assigned',
  'running',
  'waiting_for_input',
  'waiting_for_approval',
  'blocked',
  'failed',
] as const satisfies ReadonlyArray<(typeof tasks.$inferSelect)['status']>;

const OPEN_STEP_STATUSES = [
  'pending',
  'running',
  'waiting_for_approval',
  'waiting_for_input',
  'failed',
] as const satisfies ReadonlyArray<WorkflowStep['status']>;

// ---------------------------------------------------------------- engine hooks (used by the scheduler)

/** Mirrors a task outcome onto its workflow step and re-derives the run status. Internal. */
export async function syncWorkflowStep(
  db: Db,
  task: Pick<typeof tasks.$inferSelect, 'workflowRunId' | 'workflowStepId' | 'projectId'>,
  status: WorkflowStep['status'],
  gateResult?: string,
): Promise<void> {
  if (!task.workflowStepId || !task.workflowRunId) return;
  await db
    .update(workflowSteps)
    .set({ status, ...(gateResult !== undefined ? { gateResult } : {}), updatedAt: new Date() })
    .where(eq(workflowSteps.id, task.workflowStepId));

  const run = await loadRun(db, task.workflowRunId);
  if (run.status !== 'running' && run.status !== 'paused') return;
  const steps = await db.select().from(workflowSteps).where(eq(workflowSteps.runId, run.id));
  const system = ORCHESTRATOR(await projectWorkspace(db, run.projectId));
  if (steps.every((s) => s.status === 'completed' || s.status === 'skipped')) {
    await setRunStatus(db, system, run, 'completed', null);
  } else if (steps.some((s) => s.status === 'failed')) {
    await setRunStatus(db, system, run, 'failed', 'a stage failed after exhausting its retries');
  }
}

/** Pauses a run on behalf of the platform (budget halt). Internal. */
export async function systemPauseRun(db: Db, runId: string, reason: string): Promise<void> {
  const run = await loadRun(db, runId);
  if (run.status !== 'running') return;
  await setRunStatus(db, ORCHESTRATOR(await projectWorkspace(db, run.projectId)), run, 'paused', reason);
}
