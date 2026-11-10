import { and, desc, eq, lt } from 'drizzle-orm';
import { auditLogs, type Db } from '@platform/db';
import { type Actor, clampLimit, isUuid, type Page, ValidationError } from '@platform/shared';
import { authorize } from './policy.js';

export type AuditLogRow = typeof auditLogs.$inferSelect;

/**
 * Cursor-paginated audit trail (newest first). Cursor = id of the last row returned (UUIDv7 is time-ordered).
 * Project-scoped queries require project access; workspace-wide queries require workspace-level `audit.read`.
 */
export async function listAuditLogs(
  db: Db,
  actor: Actor,
  opts: { projectId?: string; targetType?: string; targetId?: string; cursor?: string; limit?: number } = {},
): Promise<Page<AuditLogRow>> {
  await authorize(db, actor, 'audit.read', opts.projectId ? { projectId: opts.projectId } : {});
  if (opts.cursor && !isUuid(opts.cursor)) throw new ValidationError('Invalid cursor');
  const limit = clampLimit(opts.limit);
  const conds = [eq(auditLogs.workspaceId, actor.workspaceId!)];
  if (opts.projectId) conds.push(eq(auditLogs.projectId, opts.projectId));
  if (opts.targetType) conds.push(eq(auditLogs.targetType, opts.targetType));
  if (opts.targetId) conds.push(eq(auditLogs.targetId, opts.targetId));
  if (opts.cursor) conds.push(lt(auditLogs.id, opts.cursor));
  const rows = await db
    .select()
    .from(auditLogs)
    .where(and(...conds))
    .orderBy(desc(auditLogs.id))
    .limit(limit + 1);
  const items = rows.slice(0, limit);
  return { items, nextCursor: rows.length > limit ? items[items.length - 1]!.id : null };
}
