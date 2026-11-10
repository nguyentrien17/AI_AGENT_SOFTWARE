import { auditLogs, type Db, systemEvents } from '@platform/db';
import { type Actor, actorId, redact } from '@platform/shared';

export interface AuditEntry {
  action: string;
  targetType: string;
  targetId?: string | null;
  projectId?: string | null;
  payload?: Record<string, unknown>;
  requestId?: string | null;
}

/**
 * Writes an immutable audit record. Must be called with the same transaction handle as the state change
 * so that audit and state are committed atomically. Payloads are always redacted.
 */
export async function audit(db: Db, actor: Actor, entry: AuditEntry): Promise<void> {
  await db.insert(auditLogs).values({
    workspaceId: actor.workspaceId,
    projectId: entry.projectId ?? null,
    actorType: actor.type,
    actorId: actorId(actor),
    action: entry.action,
    targetType: entry.targetType,
    targetId: entry.targetId ?? null,
    payload: redact(entry.payload ?? {}),
    requestId: entry.requestId ?? null,
  });
}

export interface DomainEvent {
  type: string;
  aggregateType: string;
  aggregateId: string;
  workspaceId?: string | null;
  projectId?: string | null;
  payload?: Record<string, unknown>;
}

/** Transactional outbox write (ADR-005). Dispatching happens asynchronously in the worker. */
export async function emitEvent(db: Db, event: DomainEvent): Promise<void> {
  await db.insert(systemEvents).values({
    type: event.type,
    aggregateType: event.aggregateType,
    aggregateId: event.aggregateId,
    workspaceId: event.workspaceId ?? null,
    projectId: event.projectId ?? null,
    payload: redact(event.payload ?? {}),
  });
}
