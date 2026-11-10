import { index, integer, jsonb, pgEnum, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { agents, agentVersions } from './agents.js';
import { createdAt, id, updatedAt, version } from './columns.js';
import { users, workspaces } from './iam.js';
import { projects } from './projects.js';
import { tasks } from './tasks.js';

export const workflows = pgTable(
  'workflows',
  {
    id: id(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    key: text('key').notNull(),
    name: text('name').notNull(),
    description: text('description').notNull().default(''),
    currentVersionId: uuid('current_version_id'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    version: version(),
  },
  (t) => [uniqueIndex('workflows_ws_key_uq').on(t.workspaceId, t.key)],
);

/** Immutable workflow definition (stages, conditions, gates). */
export const workflowVersions = pgTable(
  'workflow_versions',
  {
    id: id(),
    workflowId: uuid('workflow_id')
      .notNull()
      .references(() => workflows.id, { onDelete: 'cascade' }),
    versionNo: integer('version_no').notNull(),
    definition: jsonb('definition').$type<Record<string, unknown>>().notNull(),
    contentHash: text('content_hash').notNull(),
    createdBy: text('created_by').notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('workflow_versions_wf_no_uq').on(t.workflowId, t.versionNo)],
);

export const workflowRunStatus = pgEnum('workflow_run_status', [
  'running',
  'paused',
  'completed',
  'failed',
  'cancelled',
]);

export const workflowRuns = pgTable(
  'workflow_runs',
  {
    id: id(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    workflowVersionId: uuid('workflow_version_id')
      .notNull()
      .references(() => workflowVersions.id),
    status: workflowRunStatus('status').notNull().default('running'),
    variables: jsonb('variables').$type<Record<string, unknown>>().notNull().default({}),
    pausedReason: text('paused_reason'),
    startedByType: text('started_by_type').notNull(),
    startedById: text('started_by_id').notNull(),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    endedAt: timestamp('ended_at', { withTimezone: true }),
    updatedAt: updatedAt(),
    version: version(),
  },
  (t) => [index('workflow_runs_project_idx').on(t.projectId, t.startedAt)],
);

export const workflowStepStatus = pgEnum('workflow_step_status', [
  'pending',
  'running',
  'waiting_for_approval',
  'waiting_for_input',
  'completed',
  'failed',
  'skipped',
  'cancelled',
]);

export const workflowSteps = pgTable(
  'workflow_steps',
  {
    id: id(),
    runId: uuid('run_id')
      .notNull()
      .references(() => workflowRuns.id, { onDelete: 'cascade' }),
    stageKey: text('stage_key').notNull(),
    position: integer('position').notNull(),
    status: workflowStepStatus('status').notNull().default('pending'),
    /** Snapshot of the stage definition this step was created from. */
    config: jsonb('config').$type<Record<string, unknown>>().notNull().default({}),
    taskId: uuid('task_id').references(() => tasks.id, { onDelete: 'set null' }),
    gateResult: text('gate_result'),
    skipReason: text('skip_reason'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('workflow_steps_run_stage_uq').on(t.runId, t.stageKey)],
);

export const taskAssignments = pgTable(
  'task_assignments',
  {
    id: id(),
    taskId: uuid('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id),
    agentVersionId: uuid('agent_version_id')
      .notNull()
      .references(() => agentVersions.id),
    assignedBy: text('assigned_by').notNull(),
    assignedAt: timestamp('assigned_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('task_assignments_task_idx').on(t.taskId, t.assignedAt)],
);

export const taskExecutionStatus = pgEnum('task_execution_status', [
  'running',
  'succeeded',
  'failed',
  'abandoned',
  'released',
]);

/**
 * One row per attempt to execute a task. Created when a worker claims the task; only its outcome columns
 * may change, and only while it is still `running` (database guard).
 */
export const taskExecutions = pgTable(
  'task_executions',
  {
    id: id(),
    taskId: uuid('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    attemptNo: integer('attempt_no').notNull(),
    workerId: text('worker_id').notNull(),
    agentVersionId: uuid('agent_version_id').references(() => agentVersions.id),
    status: taskExecutionStatus('status').notNull().default('running'),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    endedAt: timestamp('ended_at', { withTimezone: true }),
    /** Full failure context: message, code, stack, retryable flag (Blueprint §9.4). */
    failure: jsonb('failure').$type<Record<string, unknown>>(),
    result: jsonb('result').$type<Record<string, unknown>>(),
  },
  (t) => [uniqueIndex('task_executions_task_attempt_uq').on(t.taskId, t.attemptNo)],
);

/** Time-bounded execution lease. The unique task id is the guard against duplicate concurrent execution. */
export const taskLeases = pgTable('task_leases', {
  taskId: uuid('task_id')
    .primaryKey()
    .references(() => tasks.id, { onDelete: 'cascade' }),
  executionId: uuid('execution_id')
    .notNull()
    .references(() => taskExecutions.id, { onDelete: 'cascade' }),
  holder: text('holder').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  heartbeatAt: timestamp('heartbeat_at', { withTimezone: true }).notNull(),
  createdAt: createdAt(),
});

export const approvalStatus = pgEnum('approval_status', ['pending', 'approved', 'rejected', 'cancelled']);

/** Human approval requests (Blueprint §16.3). Decisions are made by humans only. */
export const approvals = pgTable(
  'approvals',
  {
    id: id(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(),
    runId: uuid('run_id').references(() => workflowRuns.id, { onDelete: 'cascade' }),
    stepId: uuid('step_id').references(() => workflowSteps.id, { onDelete: 'cascade' }),
    taskId: uuid('task_id').references(() => tasks.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    subject: jsonb('subject').$type<Record<string, unknown>>().notNull().default({}),
    status: approvalStatus('status').notNull().default('pending'),
    requestedByType: text('requested_by_type').notNull(),
    requestedById: text('requested_by_id').notNull(),
    decidedBy: uuid('decided_by').references(() => users.id),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    comment: text('comment'),
    createdAt: createdAt(),
  },
  (t) => [index('approvals_project_status_idx').on(t.projectId, t.status, t.createdAt)],
);
