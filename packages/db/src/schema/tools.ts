import { boolean, index, integer, jsonb, pgEnum, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { createdAt, id, updatedAt } from './columns.js';
import { projects } from './projects.js';
import { tasks } from './tasks.js';

export const toolRisk = pgEnum('tool_risk', ['low', 'medium', 'high', 'critical']);

export interface ToolRedactionPolicy {
  /** Input fields whose values are never stored or logged (e.g. file contents). */
  omitInputFields?: string[];
  /** Store only a size/hash summary of the output, not the output itself. */
  summarizeOutput?: boolean;
}

/** Catalog of tools known to the platform (Blueprint §11.1), synced from code at start-up. */
export const toolRegistry = pgTable('tool_registry', {
  toolKey: text('tool_key').primaryKey(),
  description: text('description').notNull(),
  inputSchema: jsonb('input_schema').$type<Record<string, unknown>>().notNull(),
  outputSchema: jsonb('output_schema').$type<Record<string, unknown>>().notNull(),
  action: text('action').notNull(),
  requiredScopes: text('required_scopes').array().notNull().default([]),
  timeoutSeconds: integer('timeout_seconds').notNull(),
  risk: toolRisk('risk').notNull(),
  idempotent: boolean('idempotent').notNull(),
  requiresSandbox: boolean('requires_sandbox').notNull().default(false),
  redactionPolicy: jsonb('redaction_policy').$type<ToolRedactionPolicy>().notNull().default({}),
  runtimes: text('runtimes').array().notNull().default([]),
  definitionHash: text('definition_hash').notNull(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const toolPermissionSubject = pgEnum('tool_permission_subject', ['agent_version', 'role']);

/**
 * Per-tool narrowing of an agent's permissions (Blueprint §16.2). A row can only restrict what the agent
 * definition already allows, and raise the risk ceiling for that one tool.
 */
export const toolPermissions = pgTable(
  'tool_permissions',
  {
    id: id(),
    workspaceId: uuid('workspace_id').notNull(),
    subjectType: toolPermissionSubject('subject_type').notNull(),
    subjectId: text('subject_id').notNull(),
    toolKey: text('tool_key')
      .notNull()
      .references(() => toolRegistry.toolKey),
    fileScopes: text('file_scopes').array().notNull().default([]),
    maxRisk: toolRisk('max_risk').notNull().default('medium'),
    createdBy: text('created_by').notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('tool_permissions_subject_tool_uq').on(t.workspaceId, t.subjectType, t.subjectId, t.toolKey)],
);

export const toolExecutionStatus = pgEnum('tool_execution_status', [
  'succeeded',
  'failed',
  'denied',
  'approval_required',
  'timed_out',
]);

/** Every tool call, allowed or not. Append-only (Blueprint §11.2 full capture, §17 audit). */
export const toolExecutions = pgTable(
  'tool_executions',
  {
    id: id(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    taskId: uuid('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    taskExecutionId: uuid('task_execution_id'),
    toolKey: text('tool_key').notNull(),
    actorId: text('actor_id').notNull(),
    /** Redacted per the tool's policy. */
    input: jsonb('input').$type<Record<string, unknown>>().notNull(),
    status: toolExecutionStatus('status').notNull(),
    /** Each permission dimension with its verdict. */
    decision: jsonb('decision').$type<Record<string, unknown>>().notNull(),
    output: jsonb('output').$type<Record<string, unknown>>(),
    errorCode: text('error_code'),
    errorMessage: text('error_message'),
    exitCode: integer('exit_code'),
    durationMs: integer('duration_ms').notNull(),
    sandboxSessionId: uuid('sandbox_session_id'),
    createdAt: createdAt(),
  },
  (t) => [index('tool_executions_task_idx').on(t.taskId, t.createdAt)],
);
