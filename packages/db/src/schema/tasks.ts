import {
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { createdAt, id, updatedAt, version } from './columns.js';
import { projects } from './projects.js';

/** Blueprint §9.1 task state machine statuses. */
export const taskStatusValues = [
  'draft',
  'pending',
  'ready',
  'assigned',
  'running',
  'waiting_for_input',
  'waiting_for_approval',
  'blocked',
  'failed',
  'completed',
  'cancelled',
] as const;
export type TaskStatus = (typeof taskStatusValues)[number];

export const taskStatus = pgEnum('task_status', taskStatusValues);
export const taskComplexity = pgEnum('task_complexity', ['trivial', 'low', 'medium', 'high', 'critical']);

export const tasks = pgTable(
  'tasks',
  {
    id: id(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    workflowRunId: uuid('workflow_run_id'),
    workflowStepId: uuid('workflow_step_id'),
    title: text('title').notNull(),
    objective: text('objective').notNull(),
    inputRefs: jsonb('input_refs').$type<Array<{ path: string; version?: number }>>().notNull().default([]),
    expectedOutput: jsonb('expected_output').$type<Record<string, unknown>>().notNull().default({}),
    acceptanceCriteria: jsonb('acceptance_criteria').$type<string[]>().notNull().default([]),
    agentRole: text('agent_role'),
    allowedTools: text('allowed_tools').array().notNull().default([]),
    tokenCeiling: integer('token_ceiling'),
    costCeiling: numeric('cost_ceiling', { precision: 14, scale: 6 }),
    timeoutSeconds: integer('timeout_seconds').notNull().default(600),
    maxRetries: integer('max_retries').notNull().default(2),
    retryCount: integer('retry_count').notNull().default(0),
    /** Earliest time the scheduler may claim the task again (retry backoff, Blueprint §9.4). */
    notBefore: timestamp('not_before', { withTimezone: true }),
    complexity: taskComplexity('complexity').notNull().default('medium'),
    status: taskStatus('status').notNull().default('draft'),
    statusReason: text('status_reason'),
    createdBy: text('created_by').notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    version: version(),
  },
  (t) => [index('tasks_project_status_idx').on(t.projectId, t.status, t.createdAt)],
);

export const taskDependencies = pgTable(
  'task_dependencies',
  {
    taskId: uuid('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    dependsOnTaskId: uuid('depends_on_task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.taskId, t.dependsOnTaskId] }),
    index('task_deps_depends_on_idx').on(t.dependsOnTaskId),
  ],
);

/** Append-only history of every validated status transition. */
export const taskStatusHistory = pgTable(
  'task_status_history',
  {
    id: id(),
    taskId: uuid('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    fromStatus: taskStatus('from_status').notNull(),
    toStatus: taskStatus('to_status').notNull(),
    reason: text('reason'),
    actorType: text('actor_type').notNull(),
    actorId: text('actor_id').notNull(),
    createdAt: createdAt(),
  },
  (t) => [index('task_status_history_task_idx').on(t.taskId, t.createdAt)],
);

export const gateOutcome = pgEnum('gate_outcome', [
  'passed',
  'failed',
  'warning',
  'blocked',
  'requires_approval',
]);

/** Immutable quality gate evidence (Blueprint §12.4). A task may only complete with a passed evaluation. */
export const qualityGateEvaluations = pgTable(
  'quality_gate_evaluations',
  {
    id: id(),
    taskId: uuid('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    gateKey: text('gate_key').notNull(),
    outcome: gateOutcome('outcome').notNull(),
    evidence: jsonb('evidence')
      .$type<{
        tool: string;
        toolVersion: string;
        command: string;
        environmentId: string;
        gitTreeHash: string | null;
        logUri: string | null;
        timestamp: string;
        [k: string]: unknown;
      }>()
      .notNull(),
    evaluatedAt: timestamp('evaluated_at', { withTimezone: true }).notNull().defaultNow(),
    createdAt: createdAt(),
  },
  (t) => [index('qge_task_idx').on(t.taskId, t.createdAt)],
);
