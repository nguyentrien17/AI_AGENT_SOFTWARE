import { and, asc, eq, gt } from 'drizzle-orm';
import { type Db, systemEvents } from '@platform/db';
import { authorize } from '@platform/iam';
import type { Actor } from '@platform/shared';

export type ProjectEvent = Pick<
  typeof systemEvents.$inferSelect,
  'id' | 'type' | 'aggregateType' | 'aggregateId' | 'payload' | 'createdAt'
>;

/**
 * Project event feed read from the transactional outbox. Event ids are UUIDv7 (time-ordered), so `after`
 * is a stable resume cursor for the SSE stream (`Last-Event-ID`).
 */
export async function listProjectEvents(
  db: Db,
  actor: Actor,
  projectId: string,
  opts: { after?: string; limit?: number } = {},
): Promise<ProjectEvent[]> {
  await authorize(db, actor, 'project.read', { projectId });
  const limit = Math.min(Math.max(1, opts.limit ?? 100), 500);
  return db
    .select({
      id: systemEvents.id,
      type: systemEvents.type,
      aggregateType: systemEvents.aggregateType,
      aggregateId: systemEvents.aggregateId,
      payload: systemEvents.payload,
      createdAt: systemEvents.createdAt,
    })
    .from(systemEvents)
    .where(and(eq(systemEvents.projectId, projectId), opts.after ? gt(systemEvents.id, opts.after) : undefined))
    .orderBy(asc(systemEvents.id))
    .limit(limit);
}
