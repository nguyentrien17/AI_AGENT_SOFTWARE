import { index, integer, jsonb, pgEnum, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { createdAt, id, updatedAt, version } from './columns.js';
import { workspaces } from './iam.js';

export const agentStatus = pgEnum('agent_status', ['active', 'disabled', 'deprecated']);

export interface AgentRetryPolicy {
  /** Re-prompts allowed when the model output violates the output contract. */
  maxOutputRepairs?: number;
}

/** Agent registry (Blueprint §6.1). The mutable head row points at the current immutable version. */
export const agents = pgTable(
  'agents',
  {
    id: id(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    agentKey: text('agent_key').notNull(),
    name: text('name').notNull(),
    description: text('description').notNull().default(''),
    /** Context-access role (see `AGENT_ROLES` in @platform/artifacts). */
    role: text('role').notNull(),
    currentVersionId: uuid('current_version_id'),
    status: agentStatus('status').notNull().default('active'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    version: version(),
  },
  (t) => [
    uniqueIndex('agents_ws_key_uq').on(t.workspaceId, t.agentKey),
    index('agents_ws_role_idx').on(t.workspaceId, t.role),
  ],
);

/**
 * Immutable agent definition version. Changing instructions, schemas or permissions always creates a new
 * row (enforced by a database trigger).
 */
export const agentVersions = pgTable(
  'agent_versions',
  {
    id: id(),
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    versionNo: integer('version_no').notNull(),
    systemInstruction: text('system_instruction').notNull(),
    inputSchema: jsonb('input_schema').$type<Record<string, unknown>>().notNull().default({}),
    outputSchema: jsonb('output_schema').$type<Record<string, unknown>>().notNull().default({}),
    allowedTools: text('allowed_tools').array().notNull().default([]),
    allowedFileScopes: text('allowed_file_scopes').array().notNull().default([]),
    allowedActions: text('allowed_actions').array().notNull().default([]),
    modelConfigRef: text('model_config_ref'),
    timeoutSeconds: integer('timeout_seconds').notNull().default(600),
    retryPolicy: jsonb('retry_policy').$type<AgentRetryPolicy>().notNull().default({}),
    completionCriteria: jsonb('completion_criteria').$type<string[]>().notNull().default([]),
    contentHash: text('content_hash').notNull(),
    createdBy: text('created_by').notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('agent_versions_agent_no_uq').on(t.agentId, t.versionNo)],
);

export const agentExecutionStatus = pgEnum('agent_execution_status', ['succeeded', 'needs_input', 'failed']);

/** One row per finished agent run inside a task execution. Append-only. */
export const agentExecutions = pgTable(
  'agent_executions',
  {
    id: id(),
    taskExecutionId: uuid('task_execution_id').notNull(),
    taskId: uuid('task_id').notNull(),
    agentVersionId: uuid('agent_version_id')
      .notNull()
      .references(() => agentVersions.id),
    providerId: uuid('provider_id'),
    modelId: uuid('model_id'),
    configVersion: integer('config_version'),
    contextPackageId: uuid('context_package_id'),
    invocationIds: jsonb('invocation_ids').$type<string[]>().notNull().default([]),
    handoffId: uuid('handoff_id'),
    status: agentExecutionStatus('status').notNull(),
    errorCode: text('error_code'),
    outputRepairs: integer('output_repairs').notNull().default(0),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull(),
    completedAt: timestamp('completed_at', { withTimezone: true }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [index('agent_executions_task_idx').on(t.taskId, t.createdAt)],
);
