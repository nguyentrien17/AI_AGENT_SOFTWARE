import {
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { createdAt, id } from './columns.js';
import { contextItems, contextVersions } from './artifacts.js';
import { projects } from './projects.js';
import { tasks } from './tasks.js';

export const packageItemSource = pgEnum('package_item_source', ['explicit', 'handoff', 'default']);
export const relevance = pgEnum('relevance', ['high', 'medium', 'low']);

/**
 * Immutable Context Package manifests (Blueprint §7.5). A package is valid until `invalidated_at` is set;
 * at most one valid package exists per cache key.
 */
export const contextPackages = pgTable(
  'context_packages',
  {
    id: id(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    taskId: uuid('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    agentRole: text('agent_role').notNull(),
    cacheKey: text('cache_key').notNull(),
    contextVersion: integer('context_version').notNull(),
    estimatedTokens: integer('estimated_tokens').notNull(),
    tokenBudget: integer('token_budget').notNull(),
    promptVersion: text('prompt_version').notNull(),
    modelConfigVersion: text('model_config_version').notNull(),
    manifest: jsonb('manifest').$type<Record<string, unknown>>().notNull(),
    manifestHash: text('manifest_hash').notNull(),
    invalidatedAt: timestamp('invalidated_at', { withTimezone: true }),
    invalidationReason: text('invalidation_reason'),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('context_packages_valid_cache_key_uq')
      .on(t.cacheKey)
      .where(sql`${t.invalidatedAt} is null`),
    index('context_packages_task_idx').on(t.taskId, t.createdAt),
  ],
);

export const contextPackageItems = pgTable(
  'context_package_items',
  {
    packageId: uuid('package_id')
      .notNull()
      .references(() => contextPackages.id, { onDelete: 'cascade' }),
    contextVersionId: uuid('context_version_id')
      .notNull()
      .references(() => contextVersions.id, { onDelete: 'cascade' }),
    contextItemId: uuid('context_item_id')
      .notNull()
      .references(() => contextItems.id, { onDelete: 'cascade' }),
    relevance: relevance('relevance').notNull(),
    source: packageItemSource('source').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.packageId, t.contextVersionId] }),
    index('context_package_items_item_idx').on(t.contextItemId),
  ],
);

export const handoffStatus = pgEnum('handoff_status', ['completed', 'partial', 'blocked', 'failed']);

/** Structured, schema-validated agent handoffs (Blueprint §6.4). Append-only. */
export const agentHandoffs = pgTable(
  'agent_handoffs',
  {
    id: uuid('id').primaryKey(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    taskId: uuid('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    fromAgent: text('from_agent').notNull(),
    toAgent: text('to_agent').notNull(),
    status: handoffStatus('status').notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    payloadHash: text('payload_hash').notNull(),
    artifactItemId: uuid('artifact_item_id').references(() => contextItems.id),
    createdAt: createdAt(),
  },
  (t) => [
    index('agent_handoffs_task_idx').on(t.taskId, t.createdAt),
    index('agent_handoffs_project_idx').on(t.projectId, t.createdAt),
  ],
);

/** Immutable checkpoints of a project's context state (Blueprint §7.1 pause/resume/recovery). */
export const checkpoints = pgTable(
  'checkpoints',
  {
    id: id(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    taskId: uuid('task_id').references(() => tasks.id, { onDelete: 'set null' }),
    workflowRunId: uuid('workflow_run_id'),
    label: text('label').notNull(),
    contextVersion: integer('context_version').notNull(),
    state: jsonb('state').$type<Record<string, unknown>>().notNull(),
    stateHash: text('state_hash').notNull(),
    gitCommit: text('git_commit'),
    createdByType: text('created_by_type').notNull(),
    createdById: text('created_by_id').notNull(),
    createdAt: createdAt(),
  },
  (t) => [index('checkpoints_project_idx').on(t.projectId, t.createdAt)],
);

export const memoryKind = pgEnum('memory_kind', ['decision', 'fact', 'constraint', 'lesson']);

/** Durable project memories; `constraint` memories are injected into every context package. */
export const projectMemories = pgTable(
  'project_memories',
  {
    id: id(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    kind: memoryKind('kind').notNull(),
    content: text('content').notNull(),
    sourceRef: text('source_ref'),
    createdByType: text('created_by_type').notNull(),
    createdById: text('created_by_id').notNull(),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [index('project_memories_project_idx').on(t.projectId, t.kind)],
);
