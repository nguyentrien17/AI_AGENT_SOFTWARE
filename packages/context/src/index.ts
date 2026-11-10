import { asc, eq } from 'drizzle-orm';
import { contextItems, type Db, projects } from '@platform/db';
import { authorize } from '@platform/iam';
import { type Actor, NotFoundError } from '@platform/shared';

export * from './tokens.js';
export * from './handoff.js';
export * from './builder.js';
export * from './render.js';
export * from './memories.js';
export * from './checkpoints.js';

/** Context index for a project (Blueprint §7.6 `GET /projects/{id}/context`). */
export async function getProjectContextIndex(db: Db, actor: Actor, projectId: string) {
  await authorize(db, actor, 'artifact.read', { projectId });
  const [p] = await db
    .select({ cv: projects.contextVersion })
    .from(projects)
    .where(eq(projects.id, projectId));
  if (!p) throw new NotFoundError('Project', projectId);
  const items = await db
    .select()
    .from(contextItems)
    .where(eq(contextItems.projectId, projectId))
    .orderBy(asc(contextItems.path));
  return { contextVersion: p.cv, items };
}
