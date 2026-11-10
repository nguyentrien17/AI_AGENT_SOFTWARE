import { index, integer, jsonb, pgEnum, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { createdAt, id } from './columns.js';
import { workspaces } from './iam.js';

/** Append-only audit trail (Blueprint §17). Payloads are redacted before insert. */
export const auditLogs = pgTable(
  'audit_logs',
  {
    id: id(),
    workspaceId: uuid('workspace_id').references(() => workspaces.id, { onDelete: 'set null' }),
    projectId: uuid('project_id'),
    actorType: text('actor_type').notNull(),
    actorId: text('actor_id').notNull(),
    action: text('action').notNull(),
    targetType: text('target_type').notNull(),
    targetId: text('target_id'),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull().default({}),
    requestId: text('request_id'),
    createdAt: createdAt(),
  },
  (t) => [
    index('audit_logs_ws_created_idx').on(t.workspaceId, t.createdAt),
    index('audit_logs_target_idx').on(t.targetType, t.targetId),
    index('audit_logs_project_idx').on(t.projectId, t.createdAt),
  ],
);

export const eventStatus = pgEnum('event_status', ['pending', 'dispatched', 'failed']);

/** Transactional outbox for domain events (ADR-005, Blueprint §7.8). */
export const systemEvents = pgTable(
  'system_events',
  {
    id: id(),
    type: text('type').notNull(),
    workspaceId: uuid('workspace_id'),
    projectId: uuid('project_id'),
    aggregateType: text('aggregate_type').notNull(),
    aggregateId: text('aggregate_id').notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull().default({}),
    status: eventStatus('status').notNull().default('pending'),
    attempts: integer('attempts').notNull().default(0),
    lastError: text('last_error'),
    dispatchedAt: timestamp('dispatched_at', { withTimezone: true }),
    /** Dispatcher lease: the worker handling the event and until when (crashed workers lose it). */
    claimedBy: text('claimed_by'),
    claimedUntil: timestamp('claimed_until', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    index('system_events_status_created_idx').on(t.status, t.createdAt),
    index('system_events_aggregate_idx').on(t.aggregateType, t.aggregateId),
  ],
);
