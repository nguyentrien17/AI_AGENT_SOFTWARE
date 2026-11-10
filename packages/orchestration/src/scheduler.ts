import { hostname } from 'node:os';
import path from 'node:path';
import { and, asc, desc, eq, isNotNull, isNull, lt, lte, or } from 'drizzle-orm';
import {
  type Agent,
  AgentExecutionError,
  ContextInputUnavailableError,
  type AgentRuntimeDeps,
  type AgentTaskResult,
  type AgentVersion,
  executeAgentTask,
  resolveAgent,
  type StageHints,
} from '@platform/agent-runtime';
import {
  type Db,
  projects,
  qualityGateEvaluations,
  repositories,
  taskAssignments,
  taskExecutions,
  taskLeases,
  tasks,
  workflowRuns,
  workflowSteps,
} from '@platform/db';
import { BudgetBlockedError, InvocationHaltedError, RoutingHaltError } from '@platform/model-router';
import { emitEvent } from '@platform/observability';
import { DEFAULT_WORKSPACE_GATES, type GateKey, runQualityGates } from '@platform/quality-gates';
import type { StorageAdapter } from '@platform/storage';
import {
  integrateTaskBranches,
  integrationWorktreeDir,
  removeTaskWorktree,
  taskWorktreeDir,
} from '@platform/tool-executor';
import { type Actor, AppError, isAppError, NotFoundError } from '@platform/shared';
import { HUMAN_APPROVAL_GATE, latestRejectionComment, requestApproval } from './approvals.js';
import { recordGateEvaluation, type Task, transitionTask } from './tasks.js';
import type { StageDefinition } from './workflows.js';
import { syncWorkflowStep, systemPauseRun } from './workflows.js';

export const OUTPUT_CONTRACT_GATE = 'agent_output_contract';
export const INTEGRATION_GATE = 'integration_merge';
export const DEFAULT_LEASE_SECONDS = 120;

export type TaskExecution = typeof taskExecutions.$inferSelect;

/** A worker's exclusive, time-bounded right to execute one task (Blueprint §9.3). */
export interface TaskClaim {
  task: Task;
  execution: TaskExecution;
  workerId: string;
  workspaceId: string;
  /** Null for platform-executed stages (integration). */
  agent: Agent | null;
  version: AgentVersion | null;
  stage: StageDefinition | null;
  feedback: string | null;
  leaseExpiresAt: Date;
}

export type TaskExecutor = (claim: TaskClaim) => Promise<AgentTaskResult>;

/** The execution no longer holds the task lease; its result must be discarded, never applied. */
export class LeaseLostError extends AppError {
  constructor(executionId: string) {
    super({
      status: 409,
      code: 'lease_lost',
      title: 'Lease lost',
      detail: `Execution '${executionId}' no longer holds the task lease; its result was discarded`,
    });
  }
}

export interface SchedulerDeps {
  db: Db;
  executor: TaskExecutor;
  now?: () => Date;
  leaseSeconds?: number;
  /** Source of jitter; injectable for deterministic tests. */
  random?: () => number;
  backoff?: { baseMs?: number; maxMs?: number };
  /**
   * Root storage (repositories, worktrees, evidence blobs). Required for Quality Gates on workspace changes
   * and for integration stages.
   */
  storage?: StorageAdapter;
}

const SCHEDULER = (workspaceId: string | null): Actor => ({ type: 'system', workspaceId, component: 'scheduler' });

/** Binds the scheduler to the real agent runtime. */
export function createAgentTaskExecutor(deps: AgentRuntimeDeps): TaskExecutor {
  return (claim) => {
    const hints: StageHints = {};
    const s = claim.stage;
    if (s?.nextAgent) hints.nextAgent = s.nextAgent;
    if (s?.complexity) hints.complexity = s.complexity;
    if (s?.riskLevel) hints.riskLevel = s.riskLevel;
    if (s?.taskKind) hints.taskKind = s.taskKind;
    if (s?.essential !== undefined) hints.essential = s.essential;
    if (s?.qualityGateCritical !== undefined) hints.qualityGateCritical = s.qualityGateCritical;
    if (!claim.agent || !claim.version) {
      throw new AgentExecutionError('no_agent', `Stage of task '${claim.task.id}' is not executed by an agent`, false);
    }
    return executeAgentTask(deps, {
      task: claim.task,
      agent: claim.agent,
      version: claim.version,
      executionId: claim.execution.id,
      attemptNo: claim.execution.attemptNo,
      workflowRunId: claim.task.workflowRunId,
      hints,
      feedback: claim.feedback,
    });
  };
}

/** Exponential backoff with full jitter (Blueprint §9.4): uniformly random in [0, min(max, base·2^(n-1))]. */
export function computeBackoffMs(
  attemptNo: number,
  opts: { baseMs?: number; maxMs?: number; random?: () => number } = {},
): number {
  const base = opts.baseMs ?? 1_000;
  const max = opts.maxMs ?? 60_000;
  const ceiling = Math.min(max, base * 2 ** Math.max(0, attemptNo - 1));
  return Math.floor((opts.random ?? Math.random)() * ceiling);
}

async function workspaceOfProject(db: Db, projectId: string): Promise<string> {
  const [p] = await db.select({ ws: projects.workspaceId }).from(projects).where(eq(projects.id, projectId));
  if (!p) throw new NotFoundError('Project', projectId);
  return p.ws;
}

function isUniqueViolation(err: unknown): boolean {
  for (let e: unknown = err; e && typeof e === 'object'; e = (e as { cause?: unknown }).cause) {
    if ((e as { code?: string }).code === '23505') return true;
  }
  return false;
}

/** Why the last attempt's work was rejected by a Quality Gate, fed back to the agent. */
async function latestFailedGateSummary(db: Db, taskId: string): Promise<string | null> {
  const [row] = await db
    .select({ gateKey: qualityGateEvaluations.gateKey, evidence: qualityGateEvaluations.evidence })
    .from(qualityGateEvaluations)
    .where(and(eq(qualityGateEvaluations.taskId, taskId), eq(qualityGateEvaluations.outcome, 'failed')))
    .orderBy(desc(qualityGateEvaluations.evaluatedAt), desc(qualityGateEvaluations.id))
    .limit(1);
  if (!row) return null;
  return `Quality gate '${row.gateKey}' failed: ${String(row.evidence['summary'] ?? '')}`;
}

async function lastFailureMessage(db: Db, taskId: string): Promise<string | null> {
  const [row] = await db
    .select({ failure: taskExecutions.failure })
    .from(taskExecutions)
    .where(and(eq(taskExecutions.taskId, taskId), eq(taskExecutions.status, 'failed')))
    .orderBy(desc(taskExecutions.attemptNo))
    .limit(1);
  const message = row?.failure?.['message'];
  return typeof message === 'string' ? message : null;
}

/**
 * Claims the oldest runnable task: `ready`, past its backoff time, and either standalone or part of a
 * running (not paused) workflow run. The lease row's primary key is the task id, so two workers can never
 * hold the same task.
 */
export async function claimNextTask(
  db: Db,
  workerId: string,
  opts: { now?: Date; leaseSeconds?: number } = {},
): Promise<TaskClaim | null> {
  const now = opts.now ?? new Date();
  const leaseSeconds = opts.leaseSeconds ?? DEFAULT_LEASE_SECONDS;
  const candidates = await db
    .select({ task: tasks, runStatus: workflowRuns.status })
    .from(tasks)
    .leftJoin(workflowRuns, eq(workflowRuns.id, tasks.workflowRunId))
    .where(
      and(
        eq(tasks.status, 'ready'),
        isNotNull(tasks.agentRole),
        or(isNull(tasks.notBefore), lte(tasks.notBefore, now)),
        or(isNull(tasks.workflowRunId), eq(workflowRuns.status, 'running')),
      ),
    )
    .orderBy(asc(tasks.createdAt), asc(tasks.id))
    .limit(25);

  for (const { task } of candidates) {
    const workspaceId = await workspaceOfProject(db, task.projectId);
    const system = SCHEDULER(workspaceId);
    const [step] = task.workflowStepId
      ? await db.select().from(workflowSteps).where(eq(workflowSteps.id, task.workflowStepId))
      : [];
    const stage = (step?.config as unknown as StageDefinition | undefined) ?? null;
    const platformStage = stage?.kind === 'integration';
    const resolved = platformStage
      ? null
      : await resolveAgent(db, workspaceId, { agentKey: stage?.agentKey ?? null, role: task.agentRole });
    if (!platformStage && !resolved) {
      await transitionTask(db, system, task.id, 'blocked', {
        reason: `no active agent registered for '${stage?.agentKey ?? task.agentRole}'`,
      });
      continue;
    }

    let execution: TaskExecution;
    const expiresAt = new Date(now.getTime() + leaseSeconds * 1000);
    try {
      execution = await db.transaction(async (txRaw) => {
        const tx = txRaw as unknown as Db;
        const [last] = await tx
          .select({ no: taskExecutions.attemptNo })
          .from(taskExecutions)
          .where(eq(taskExecutions.taskId, task.id))
          .orderBy(desc(taskExecutions.attemptNo))
          .limit(1);
        const [exec] = await tx
          .insert(taskExecutions)
          .values({
            taskId: task.id,
            attemptNo: (last?.no ?? 0) + 1,
            workerId,
            agentVersionId: resolved?.version.id ?? null,
            startedAt: now,
          })
          .returning();
        await tx.insert(taskLeases).values({
          taskId: task.id,
          executionId: exec!.id,
          holder: workerId,
          expiresAt,
          heartbeatAt: now,
        });
        if (resolved) {
          await tx.insert(taskAssignments).values({
            taskId: task.id,
            agentId: resolved.agent.id,
            agentVersionId: resolved.version.id,
            assignedBy: 'scheduler',
          });
        }
        return exec!;
      });
    } catch (err) {
      if (isUniqueViolation(err)) continue; // another worker holds the lease
      throw err;
    }

    try {
      await transitionTask(db, system, task.id, 'assigned', { reason: `claimed by ${workerId}` });
      const running = await transitionTask(db, system, task.id, 'running', {
        reason: `attempt ${execution.attemptNo} by ${resolved ? `${resolved.agent.agentKey}@${resolved.version.versionNo}` : 'platform integration'}`,
      });
      await syncWorkflowStep(db, running, 'running');
      const feedback =
        (await latestRejectionComment(db, task.id)) ??
        (await lastFailureMessage(db, task.id)) ??
        (await latestFailedGateSummary(db, task.id));
      return {
        task: running,
        execution,
        workerId,
        workspaceId,
        agent: resolved?.agent ?? null,
        version: resolved?.version ?? null,
        stage,
        feedback,
        leaseExpiresAt: expiresAt,
      };
    } catch (err) {
      // The task changed under us (e.g. cancelled): give the lease back and move on.
      await db.delete(taskLeases).where(eq(taskLeases.executionId, execution.id));
      await db
        .update(taskExecutions)
        .set({ status: 'released', endedAt: now, failure: { code: 'claim_aborted', message: String(err) } })
        .where(eq(taskExecutions.id, execution.id));
    }
  }
  return null;
}

/** Extends the lease. Returns false when the lease is gone — the worker must stop and discard its work. */
export async function heartbeat(
  db: Db,
  executionId: string,
  opts: { now?: Date; leaseSeconds?: number } = {},
): Promise<boolean> {
  const now = opts.now ?? new Date();
  const rows = await db
    .update(taskLeases)
    .set({ heartbeatAt: now, expiresAt: new Date(now.getTime() + (opts.leaseSeconds ?? DEFAULT_LEASE_SECONDS) * 1000) })
    .where(eq(taskLeases.executionId, executionId))
    .returning({ taskId: taskLeases.taskId });
  return rows.length > 0;
}

export interface RecoveredLease {
  taskId: string;
  executionId: string;
  holder: string;
  taskStatus: Task['status'];
}

/**
 * Crash recovery (Blueprint §9.3): a worker that missed its heartbeats loses the lease, its execution is
 * closed as `abandoned`, and the task returns to `ready` — or stays `failed` once retries are exhausted.
 */
export async function recoverExpiredLeases(db: Db, now: Date = new Date()): Promise<RecoveredLease[]> {
  const expired = await db.select().from(taskLeases).where(lt(taskLeases.expiresAt, now));
  const recovered: RecoveredLease[] = [];
  for (const lease of expired) {
    const revoked = await db.transaction(async (txRaw) => {
      const tx = txRaw as unknown as Db;
      const gone = await tx
        .delete(taskLeases)
        .where(and(eq(taskLeases.executionId, lease.executionId), lt(taskLeases.expiresAt, now)))
        .returning({ taskId: taskLeases.taskId });
      if (gone.length === 0) return false; // heartbeat arrived in the meantime
      await tx
        .update(taskExecutions)
        .set({
          status: 'abandoned',
          endedAt: now,
          failure: { code: 'lease_expired', message: `worker '${lease.holder}' missed its heartbeats`, retryable: true },
        })
        .where(and(eq(taskExecutions.id, lease.executionId), eq(taskExecutions.status, 'running')));
      return true;
    });
    if (!revoked) continue;

    const [task] = await db.select().from(tasks).where(eq(tasks.id, lease.taskId)).limit(1);
    if (!task) continue;
    const workspaceId = await workspaceOfProject(db, task.projectId);
    const system = SCHEDULER(workspaceId);
    let status = task.status;
    if (task.status === 'assigned') {
      status = (await transitionTask(db, system, task.id, 'ready', { reason: 'lease expired before start' })).status;
    } else if (task.status === 'running') {
      status = await failAndMaybeRetry(db, system, task, `lease expired: worker '${lease.holder}' stopped responding`, now, 0);
    }
    await emitEvent(db, {
      type: 'task.lease_expired',
      aggregateType: 'task',
      aggregateId: task.id,
      workspaceId,
      projectId: task.projectId,
      payload: { executionId: lease.executionId, holder: lease.holder, taskStatus: status },
    });
    recovered.push({ taskId: task.id, executionId: lease.executionId, holder: lease.holder, taskStatus: status });
  }
  return recovered;
}

/** `running → failed`, then `failed → ready` with a backoff delay while retries remain. */
async function failAndMaybeRetry(
  db: Db,
  system: Actor,
  task: Task,
  reason: string,
  now: Date,
  backoffMs: number,
): Promise<Task['status']> {
  const failed = await transitionTask(db, system, task.id, 'failed', { reason });
  if (failed.retryCount < failed.maxRetries) {
    await transitionTask(db, system, task.id, 'ready', {
      reason: `retry ${failed.retryCount + 1} of ${failed.maxRetries}`,
    });
    await db
      .update(tasks)
      .set({ notBefore: new Date(now.getTime() + backoffMs) })
      .where(eq(tasks.id, task.id));
    await syncWorkflowStep(db, task, 'pending');
    return 'ready';
  }
  // Never an infinite self-correction loop: stop, keep the failure context, alert the user.
  await emitEvent(db, {
    type: 'task.retries_exhausted',
    aggregateType: 'task',
    aggregateId: task.id,
    workspaceId: system.workspaceId,
    projectId: task.projectId,
    payload: { maxRetries: failed.maxRetries, reason, requires: 'human_intervention' },
  });
  await syncWorkflowStep(db, task, 'failed');
  return 'failed';
}

/** Closes the execution and frees the lease, or throws {@link LeaseLostError} when the lease moved on. */
async function closeExecution(
  db: Db,
  claim: TaskClaim,
  status: 'succeeded' | 'failed',
  detail: { result?: Record<string, unknown>; failure?: Record<string, unknown> },
  now: Date,
): Promise<void> {
  await db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Db;
    const held = await tx
      .delete(taskLeases)
      .where(and(eq(taskLeases.taskId, claim.task.id), eq(taskLeases.executionId, claim.execution.id)))
      .returning({ taskId: taskLeases.taskId });
    if (held.length === 0) throw new LeaseLostError(claim.execution.id);
    await tx
      .update(taskExecutions)
      .set({ status, endedAt: now, ...detail })
      .where(eq(taskExecutions.id, claim.execution.id));
  });
}

export type TaskOutcome =
  | 'completed'
  | 'waiting_for_approval'
  | 'waiting_for_input'
  | 'retry_scheduled'
  | 'failed'
  | 'budget_paused'
  | 'blocked'
  | 'lease_lost';

/** Applies a successful agent result: gate evidence first, then the status the evidence allows. */
export interface CompletionOptions {
  storage?: StorageAdapter;
  random?: () => number;
  backoff?: { baseMs?: number; maxMs?: number };
}

/**
 * Runs the deterministic Quality Gates for a finished attempt and records their evidence. Returns the
 * outcome when a gate stops completion, or null when every gate passed (Blueprint §12.1).
 */
async function enforceQualityGates(
  db: Db,
  claim: TaskClaim,
  opts: CompletionOptions,
  now: Date,
): Promise<TaskOutcome | null> {
  if (!opts.storage) return null;
  const { task } = claim;
  const system = SCHEDULER(claim.workspaceId);
  const keys = [...new Set<GateKey>([...DEFAULT_WORKSPACE_GATES, ...(claim.stage?.gates ?? [])])];
  const results = await runQualityGates({ db, storage: opts.storage }, task.id, keys);
  for (const r of results) {
    await recordGateEvaluation(db, system, task.id, { gateKey: r.gateKey, outcome: r.outcome, evidence: r.evidence });
  }
  const failed = results.filter((r) => r.outcome === 'failed');
  if (failed.length) {
    const reason = `quality gates failed: ${failed.map((r) => `${r.gateKey} — ${r.evidence.summary}`).join(' | ')}`;
    const backoffMs = computeBackoffMs(claim.execution.attemptNo, { ...opts.backoff, ...(opts.random ? { random: opts.random } : {}) });
    const status = await failAndMaybeRetry(db, system, task, reason.slice(0, 900), now, backoffMs);
    return status === 'ready' ? 'retry_scheduled' : 'failed';
  }
  const stuck = results.filter((r) => r.outcome === 'blocked' || r.outcome === 'requires_approval');
  if (stuck.length) {
    const reason = stuck.map((r) => `${r.gateKey} — ${r.evidence.summary}`).join(' | ');
    await transitionTask(db, system, task.id, 'blocked', { reason: `quality gates cannot pass: ${reason}`.slice(0, 900) });
    await syncWorkflowStep(db, task, 'waiting_for_input', 'blocked');
    await emitEvent(db, {
      type: 'task.needs_intervention',
      aggregateType: 'task',
      aggregateId: task.id,
      workspaceId: claim.workspaceId,
      projectId: task.projectId,
      payload: { code: 'quality_gate_blocked', gates: stuck.map((r) => ({ gateKey: r.gateKey, summary: r.evidence.summary })) },
    });
    return 'blocked';
  }
  return null;
}

export async function completeClaim(
  db: Db,
  claim: TaskClaim,
  result: AgentTaskResult,
  now = new Date(),
  opts: CompletionOptions = {},
): Promise<TaskOutcome> {
  await closeExecution(
    db,
    claim,
    'succeeded',
    {
      result: {
        status: result.status,
        summary: result.summary,
        outputRefs: result.outputRefs,
        handoffId: result.handoffId,
        contextPackageId: result.contextPackageId,
        invocationIds: result.invocationIds,
        modelKey: result.modelKey,
        providerKey: result.providerKey,
        outputRepairs: result.outputRepairs,
      },
    },
    now,
  );
  const { task } = claim;
  const system = SCHEDULER(claim.workspaceId);
  let outcome: TaskOutcome | null;

  if (result.status === 'needs_input') {
    await transitionTask(db, system, task.id, 'waiting_for_input', {
      reason: `agent needs input: ${result.openQuestions.join(' | ').slice(0, 900)}`,
    });
    await syncWorkflowStep(db, task, 'waiting_for_input');
    await emitEvent(db, {
      type: 'task.needs_input',
      aggregateType: 'task',
      aggregateId: task.id,
      workspaceId: claim.workspaceId,
      projectId: task.projectId,
      payload: { questions: result.openQuestions },
    });
    outcome = 'waiting_for_input';
  } else if ((outcome = await enforceQualityGates(db, claim, opts, now)) !== null) {
    // A gate stopped completion; `outcome` says what happens next.
  } else {
    const evidence = {
      tool: 'agent-runtime',
      toolVersion: '1',
      command: 'validate-output-envelope',
      environmentId: claim.execution.id,
      gitTreeHash: null,
      logUri: null,
    };
    await recordGateEvaluation(db, system, task.id, { gateKey: OUTPUT_CONTRACT_GATE, outcome: 'passed', evidence });
    if (claim.stage?.approval === 'human') {
      await recordGateEvaluation(db, system, task.id, {
        gateKey: HUMAN_APPROVAL_GATE,
        outcome: 'requires_approval',
        evidence,
      });
      await transitionTask(db, system, task.id, 'waiting_for_approval', { reason: 'awaiting human approval' });
      await requestApproval(db, system, {
        projectId: task.projectId,
        kind: 'workflow_gate',
        title: `Approve '${task.title}'`,
        subject: { summary: result.summary, outputRefs: result.outputRefs, handoffId: result.handoffId },
        runId: task.workflowRunId,
        stepId: task.workflowStepId,
        taskId: task.id,
      });
      await syncWorkflowStep(db, task, 'waiting_for_approval', 'pending');
      outcome = 'waiting_for_approval';
    } else {
      await transitionTask(db, system, task.id, 'completed', { reason: 'agent output accepted' });
      await syncWorkflowStep(db, task, 'completed', 'passed');
      outcome = 'completed';
    }
  }

  // Budget protocol (Blueprint §10.4): the finished work is kept, but nothing new is scheduled.
  if (result.budget.haltTriggered && task.workflowRunId) await systemPauseRun(db, task.workflowRunId, 'budget_halted');
  return outcome;
}

/** Applies a failed attempt according to its cause (Blueprint §9.4). */
export async function failClaim(
  db: Db,
  claim: TaskClaim,
  err: unknown,
  opts: { now?: Date; random?: () => number; backoff?: { baseMs?: number; maxMs?: number } } = {},
): Promise<TaskOutcome> {
  const now = opts.now ?? new Date();
  const { task } = claim;
  const system = SCHEDULER(claim.workspaceId);
  const budgetBlocked = err instanceof BudgetBlockedError;
  const needsHuman =
    err instanceof RoutingHaltError || err instanceof InvocationHaltedError || err instanceof ContextInputUnavailableError;
  const retryable = err instanceof AgentExecutionError ? err.retryable : !budgetBlocked && !needsHuman;
  const message = err instanceof Error ? err.message : String(err);

  await closeExecution(
    db,
    claim,
    'failed',
    {
      failure: {
        code: isAppError(err) ? err.code : 'internal_error',
        message,
        stack: err instanceof Error ? (err.stack ?? null) : null,
        retryable,
        attemptNo: claim.execution.attemptNo,
        ...(isAppError(err) ? { details: err.extensions } : {}),
      },
    },
    now,
  );

  if (budgetBlocked) {
    // Not the task's fault: no retry is consumed. Scheduling stops until a human raises the budget.
    if (task.workflowRunId) {
      await transitionTask(db, system, task.id, 'ready', { reason: 'budget exhausted; waiting for approval' });
      await syncWorkflowStep(db, task, 'pending');
      await systemPauseRun(db, task.workflowRunId, 'budget_halted');
    } else {
      await transitionTask(db, system, task.id, 'blocked', { reason: `budget exhausted: ${message}` });
    }
    return 'budget_paused';
  }
  if (needsHuman) {
    await transitionTask(db, system, task.id, 'waiting_for_input', { reason: message.slice(0, 900) });
    await syncWorkflowStep(db, task, 'waiting_for_input');
    await emitEvent(db, {
      type: 'task.needs_intervention',
      aggregateType: 'task',
      aggregateId: task.id,
      workspaceId: claim.workspaceId,
      projectId: task.projectId,
      payload: { code: isAppError(err) ? err.code : 'internal_error', message },
    });
    return 'waiting_for_input';
  }
  if (!retryable) {
    await transitionTask(db, system, task.id, 'failed', { reason: message.slice(0, 900) });
    await syncWorkflowStep(db, task, 'failed');
    return 'failed';
  }
  const backoffMs = computeBackoffMs(claim.execution.attemptNo, { ...opts.backoff, ...(opts.random ? { random: opts.random } : {}) });
  const status = await failAndMaybeRetry(db, system, task, message.slice(0, 900), now, backoffMs);
  return status === 'ready' ? 'retry_scheduled' : 'failed';
}

export interface WorkerTick {
  outcome: TaskOutcome | 'idle';
  taskId: string | null;
  recovered: RecoveredLease[];
  error?: string;
}

/**
 * One scheduler pass: recover crashed work, claim one task, keep its lease alive while the agent runs,
 * then apply the result. Safe to run from any number of workers concurrently.
 */
export async function runWorkerOnce(deps: SchedulerDeps, workerId: string): Promise<WorkerTick> {
  const now = () => deps.now?.() ?? new Date();
  const leaseSeconds = deps.leaseSeconds ?? DEFAULT_LEASE_SECONDS;
  const recovered = await recoverExpiredLeases(deps.db, now());
  const claim = await claimNextTask(deps.db, workerId, { now: now(), leaseSeconds });
  if (!claim) return { outcome: 'idle', taskId: null, recovered };

  const beat = setInterval(
    () => void heartbeat(deps.db, claim.execution.id, { now: now(), leaseSeconds }).catch(() => undefined),
    Math.max(1_000, (leaseSeconds * 1000) / 3),
  );
  try {
    if (claim.stage?.kind === 'integration') {
      try {
        return { outcome: await runIntegrationClaim(deps, claim, now()), taskId: claim.task.id, recovered };
      } catch (err) {
        if (err instanceof LeaseLostError) throw err;
        const outcome = await failClaim(deps.db, claim, err, { now: now() });
        return { outcome, taskId: claim.task.id, recovered, error: err instanceof Error ? err.message : String(err) };
      }
    }
    let result: AgentTaskResult;
    try {
      result = await deps.executor(claim);
    } catch (err) {
      const outcome = await failClaim(deps.db, claim, err, {
        now: now(),
        ...(deps.random ? { random: deps.random } : {}),
        ...(deps.backoff ? { backoff: deps.backoff } : {}),
      });
      return { outcome, taskId: claim.task.id, recovered, error: err instanceof Error ? err.message : String(err) };
    }
    const completion: CompletionOptions = {
      ...(deps.storage ? { storage: deps.storage } : {}),
      ...(deps.random ? { random: deps.random } : {}),
      ...(deps.backoff ? { backoff: deps.backoff } : {}),
    };
    return { outcome: await completeClaim(deps.db, claim, result, now(), completion), taskId: claim.task.id, recovered };
  } catch (err) {
    if (err instanceof LeaseLostError) return { outcome: 'lease_lost', taskId: claim.task.id, recovered };
    throw err;
  } finally {
    clearInterval(beat);
  }
}

/** Runs passes until nothing is claimable (bounded). Used by the in-process worker and by tests. */
export async function drainWorker(deps: SchedulerDeps, workerId: string, maxTicks = 100): Promise<WorkerTick[]> {
  const ticks: WorkerTick[] = [];
  for (let i = 0; i < maxTicks; i++) {
    const tick = await runWorkerOnce(deps, workerId);
    if (tick.outcome === 'idle') break;
    ticks.push(tick);
  }
  return ticks;
}

/**
 * Integration stage (Blueprint §8.1 stage 6, P7-08), executed by the platform: merges the run's completed
 * task branches into the integration branch. A conflict blocks the task for a human; nothing is lost.
 */
async function runIntegrationClaim(deps: SchedulerDeps, claim: TaskClaim, now: Date): Promise<TaskOutcome> {
  const { db } = deps;
  if (!deps.storage) {
    throw new AgentExecutionError('storage_unavailable', 'Integration stages need the scheduler storage root', false);
  }
  const { task } = claim;
  const system = SCHEDULER(claim.workspaceId);
  const [project] = await db.select().from(projects).where(eq(projects.id, task.projectId)).limit(1);
  const [repo] = await db.select().from(repositories).where(eq(repositories.projectId, task.projectId)).limit(1);
  const upstream = task.workflowRunId
    ? await db
        .select({ taskId: tasks.id, stage: workflowSteps.config })
        .from(workflowSteps)
        .innerJoin(tasks, eq(tasks.id, workflowSteps.taskId))
        .where(and(eq(workflowSteps.runId, task.workflowRunId), eq(tasks.status, 'completed')))
        .orderBy(asc(workflowSteps.position))
    : [];
  const taskIds = upstream.filter((u) => (u.stage as { kind?: string }).kind !== 'integration').map((u) => u.taskId);
  const baseBranch = repo?.defaultBranch ?? 'main';
  const integrationBranch = repo?.integrationBranch ?? 'integration';
  const repoDir = path.join(deps.storage.root, project!.storagePath);
  const result = await integrateTaskBranches({
    repoDir,
    worktreeDir: integrationWorktreeDir(deps.storage.root, project!.workspaceId, project!.key),
    baseBranch,
    integrationBranch,
    taskIds,
  });
  const report = await deps.storage.putBlob(JSON.stringify(result, null, 2));
  await closeExecution(db, claim, 'succeeded', { result: { integration: result } }, now);
  const evidence = {
    tool: 'git merge',
    toolVersion: 'git',
    command: `git merge --no-ff ${result.merged.map((m) => m.branch).join(' ')} into ${integrationBranch}`,
    environmentId: `host:${hostname()}`,
    gitTreeHash: result.head,
    logUri: report.uri,
    summary: result.conflict
      ? `conflict merging ${result.conflict.branch}: ${result.conflict.files.join(', ')}`
      : `merged ${result.merged.length} branch(es) into ${integrationBranch}`,
  };
  if (result.conflict) {
    await recordGateEvaluation(db, system, task.id, { gateKey: INTEGRATION_GATE, outcome: 'blocked', evidence });
    await transitionTask(db, system, task.id, 'blocked', { reason: `integration conflict: ${evidence.summary}`.slice(0, 900) });
    await syncWorkflowStep(db, task, 'waiting_for_input', 'blocked');
    await emitEvent(db, {
      type: 'integration.conflict',
      aggregateType: 'task',
      aggregateId: task.id,
      workspaceId: claim.workspaceId,
      projectId: task.projectId,
      payload: { branch: result.conflict.branch, files: result.conflict.files, integrationBranch },
    });
    return 'blocked';
  }
  await recordGateEvaluation(db, system, task.id, { gateKey: INTEGRATION_GATE, outcome: 'passed', evidence });
  // The merged work now lives on the integration branch: free the task worktrees (branches are kept).
  const cleaned: string[] = [];
  for (const m of result.merged) {
    const mergedTaskId = m.branch.replace(/^task\//, '');
    try {
      await removeTaskWorktree(repoDir, taskWorktreeDir(deps.storage.root, project!.workspaceId, project!.key, mergedTaskId));
      cleaned.push(mergedTaskId);
    } catch {
      // best effort: a locked or already removed worktree must not fail the integration
    }
  }
  await transitionTask(db, system, task.id, 'completed', { reason: evidence.summary });
  await syncWorkflowStep(db, task, 'completed', 'passed');
  await emitEvent(db, {
    type: 'integration.completed',
    aggregateType: 'task',
    aggregateId: task.id,
    workspaceId: claim.workspaceId,
    projectId: task.projectId,
    payload: { integrationBranch, head: result.head, merged: result.merged.map((m) => m.branch), worktreesRemoved: cleaned },
  });
  return 'completed';
}

export async function listTaskExecutions(db: Db, taskId: string): Promise<TaskExecution[]> {
  return db.select().from(taskExecutions).where(eq(taskExecutions.taskId, taskId)).orderBy(asc(taskExecutions.attemptNo));
}
