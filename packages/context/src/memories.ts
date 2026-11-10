import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { requireAgentTaskBinding } from '@platform/artifacts';
import { contextPackages, type Db, projectMemories, projects } from '@platform/db';
import { authorize } from '@platform/iam';
import { audit, emitEvent } from '@platform/observability';
import { type Actor, actorId, NotFoundError, ValidationError } from '@platform/shared';

export type MemoryKind = 'decision' | 'fact' | 'constraint' | 'lesson';
const KINDS: MemoryKind[] = ['decision', 'fact', 'constraint', 'lesson'];

async function invalidateProjectPackages(tx: Db, projectId: string, reason: string) {
  await tx
    .update(contextPackages)
    .set({ invalidatedAt: new Date(), invalidationReason: reason })
    .where(and(eq(contextPackages.projectId, projectId), isNull(contextPackages.invalidatedAt)));
}

async function authorizeMemoryWrite(db: Db, actor: Actor, projectId: string) {
  if (actor.type === 'system') return;
  if (actor.type === 'user') await authorize(db, actor, 'artifact.write', { projectId });
  else await requireAgentTaskBinding(db, actor, projectId, 'write');
}

export async function addProjectMemory(
  db: Db,
  actor: Actor,
  projectId: string,
  input: { kind: MemoryKind; content: string; sourceRef?: string | null },
) {
  await authorizeMemoryWrite(db, actor, projectId);
  if (!KINDS.includes(input.kind)) throw new ValidationError('Invalid memory kind');
  const content = input.content.trim();
  if (!content || content.length > 4000)
    throw new ValidationError('Memory content must be 1-4000 characters');
  return db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Db;
    const [m] = await tx
      .insert(projectMemories)
      .values({
        projectId,
        kind: input.kind,
        content,
        sourceRef: input.sourceRef ?? null,
        createdByType: actor.type,
        createdById: actorId(actor),
      })
      .returning();
    // Constraints are part of every package's cache key → stale packages must be invalidated immediately.
    if (input.kind === 'constraint')
      await invalidateProjectPackages(tx, projectId, 'project constraint added');
    await tx
      .update(projects)
      .set({ contextVersion: sql`${projects.contextVersion} + 1` })
      .where(eq(projects.id, projectId));
    await audit(tx, actor, {
      action: 'memory.add',
      targetType: 'memory',
      targetId: m!.id,
      projectId,
      payload: { kind: input.kind },
    });
    await emitEvent(tx, {
      type: 'context.updated',
      aggregateType: 'project',
      aggregateId: projectId,
      workspaceId: actor.workspaceId,
      projectId,
      payload: { memory: m!.id },
    });
    return m!;
  });
}

export async function listProjectMemories(
  db: Db,
  actor: Actor,
  projectId: string,
  opts: { kind?: MemoryKind; includeArchived?: boolean } = {},
) {
  if (actor.type === 'agent') await requireAgentTaskBinding(db, actor, projectId, 'read');
  else if (actor.type === 'user') await authorize(db, actor, 'artifact.read', { projectId });
  const conds = [eq(projectMemories.projectId, projectId)];
  if (opts.kind) conds.push(eq(projectMemories.kind, opts.kind));
  if (!opts.includeArchived) conds.push(isNull(projectMemories.archivedAt));
  return db
    .select()
    .from(projectMemories)
    .where(and(...conds))
    .orderBy(desc(projectMemories.createdAt));
}

export async function archiveProjectMemory(db: Db, actor: Actor, memoryId: string) {
  const [m] = await db.select().from(projectMemories).where(eq(projectMemories.id, memoryId)).limit(1);
  if (!m) throw new NotFoundError('Memory', memoryId);
  if (actor.type === 'agent') throw new ValidationError('Agents cannot archive project memories');
  await authorizeMemoryWrite(db, actor, m.projectId);
  if (m.archivedAt) return m;
  return db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Db;
    const [row] = await tx
      .update(projectMemories)
      .set({ archivedAt: new Date() })
      .where(eq(projectMemories.id, memoryId))
      .returning();
    if (m.kind === 'constraint')
      await invalidateProjectPackages(tx, m.projectId, 'project constraint archived');
    await tx
      .update(projects)
      .set({ contextVersion: sql`${projects.contextVersion} + 1` })
      .where(eq(projects.id, m.projectId));
    await audit(tx, actor, {
      action: 'memory.archive',
      targetType: 'memory',
      targetId: memoryId,
      projectId: m.projectId,
    });
    return row!;
  });
}
