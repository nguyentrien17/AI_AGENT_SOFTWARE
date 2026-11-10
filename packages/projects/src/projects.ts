import { promises as fs } from 'node:fs';
import { and, asc, desc, eq, inArray } from 'drizzle-orm';
import {
  type Db,
  isUniqueViolation,
  projectMembers,
  projects,
  projectSettings,
  repositories,
  users,
  workspaceMembers,
} from '@platform/db';
import { authorize, ROLES, type Role } from '@platform/iam';
import { audit, emitEvent } from '@platform/observability';
import {
  type Actor,
  ConflictError,
  NotFoundError,
  ValidationError,
  VersionConflictError,
} from '@platform/shared';
import type { StorageAdapter } from '@platform/storage';
import { gitInit } from './git.js';
import { scaffoldProjectWorkspace } from './scaffold.js';

export interface ProjectDeps {
  db: Db;
  /** Root storage; each project gets `projects/<workspaceId>/<key>`. */
  storage: StorageAdapter;
  /** Skip `git init` (used only when git is unavailable; production requires git). */
  initGit?: boolean;
}

export type Project = typeof projects.$inferSelect;

const KEY_RE = /^[a-z][a-z0-9-]{1,39}$/;

export function projectStorage(deps: Pick<ProjectDeps, 'storage'>, project: Pick<Project, 'storagePath'>): StorageAdapter {
  return deps.storage.scoped(project.storagePath);
}

export async function createProject(
  deps: ProjectDeps,
  actor: Actor,
  input: { key: string; name: string; description?: string },
): Promise<Project> {
  const { role } = await authorize(deps.db, actor, 'project.create');
  const key = input.key.trim().toLowerCase();
  if (!KEY_RE.test(key)) {
    throw new ValidationError('Project key must be 2-40 chars: lowercase letters, digits, hyphens; start with a letter', [
      { path: 'key', message: 'invalid format' },
    ]);
  }
  const name = input.name.trim();
  if (!name) throw new ValidationError('Project name is required', [{ path: 'name', message: 'required' }]);
  const workspaceId = actor.workspaceId!;
  const storagePath = `projects/${workspaceId}/${key}`;
  let createdDir: string | null = null;

  try {
    return await deps.db.transaction(async (txRaw) => {
      const tx = txRaw as unknown as Db;
      const [dup] = await tx
        .select({ id: projects.id })
        .from(projects)
        .where(and(eq(projects.workspaceId, workspaceId), eq(projects.key, key)))
        .limit(1);
      if (dup) throw new ConflictError(`Project key '${key}' already exists`, 'project_key_taken');

      const [p] = await tx
        .insert(projects)
        .values({
          workspaceId,
          key,
          name,
          description: input.description?.trim() ?? '',
          storagePath,
          createdBy: actor.type === 'user' ? actor.userId : null,
        })
        .returning();
      await tx.insert(projectSettings).values({ projectId: p!.id, settings: {} });
      await tx.insert(repositories).values({ projectId: p!.id, localPath: storagePath });
      if (actor.type === 'user') {
        // Owners/administrators already have workspace-wide access; record them as project managers.
        const memberRole: Role = role === 'system' || role === 'owner' || role === 'administrator' ? 'project_manager' : (role as Role);
        await tx.insert(projectMembers).values({ projectId: p!.id, userId: actor.userId, role: memberRole });
      }
      await audit(tx, actor, { action: 'project.create', targetType: 'project', targetId: p!.id, projectId: p!.id, payload: { key, name } });
      await emitEvent(tx, { type: 'project.created', aggregateType: 'project', aggregateId: p!.id, workspaceId, projectId: p!.id });

      // Filesystem scaffold inside the transaction scope: failure rolls back DB rows.
      const ps = projectStorage(deps, p!);
      if (await deps.storage.exists(storagePath)) {
        throw new ConflictError(`Storage path '${storagePath}' already exists`, 'storage_path_exists');
      }
      createdDir = ps.root;
      await scaffoldProjectWorkspace(ps, { projectId: p!.id, key, name, description: p!.description, createdAt: p!.createdAt });
      if (deps.initGit !== false) await gitInit(ps.root);
      return p!;
    });
  } catch (e) {
    if (createdDir) await fs.rm(createdDir, { recursive: true, force: true }).catch(() => undefined);
    if (isUniqueViolation(e)) throw new ConflictError(`Project key '${key}' already exists`, 'project_key_taken');
    throw e;
  }
}

export async function listProjects(deps: Pick<ProjectDeps, 'db'>, actor: Actor, opts: { status?: 'active' | 'archived' } = {}) {
  const { role } = await authorize(deps.db, actor, 'workspace.read');
  const conds = [eq(projects.workspaceId, actor.workspaceId!)];
  if (opts.status) conds.push(eq(projects.status, opts.status));
  if (role !== 'owner' && role !== 'administrator' && role !== 'system' && actor.type === 'user') {
    const memberOf = deps.db
      .select({ id: projectMembers.projectId })
      .from(projectMembers)
      .where(eq(projectMembers.userId, actor.userId));
    conds.push(inArray(projects.id, memberOf));
  }
  return deps.db.select().from(projects).where(and(...conds)).orderBy(desc(projects.createdAt));
}

export async function getProject(deps: Pick<ProjectDeps, 'db'>, actor: Actor, projectId: string): Promise<Project> {
  await authorize(deps.db, actor, 'project.read', { projectId });
  const [p] = await deps.db.select().from(projects).where(eq(projects.id, projectId)).limit(1);
  if (!p) throw new NotFoundError('Project', projectId);
  return p;
}

export async function updateProject(
  deps: Pick<ProjectDeps, 'db'>,
  actor: Actor,
  projectId: string,
  input: { name?: string; description?: string; expectedVersion: number },
): Promise<Project> {
  await authorize(deps.db, actor, 'project.update', { projectId });
  const patch: Partial<typeof projects.$inferInsert> = { version: input.expectedVersion + 1 };
  if (input.name !== undefined) {
    if (!input.name.trim()) throw new ValidationError('Project name cannot be empty');
    patch.name = input.name.trim();
  }
  if (input.description !== undefined) patch.description = input.description.trim();
  return deps.db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Db;
    const [p] = await tx
      .update(projects)
      .set(patch)
      .where(and(eq(projects.id, projectId), eq(projects.version, input.expectedVersion)))
      .returning();
    if (!p) {
      const [cur] = await tx.select({ v: projects.version }).from(projects).where(eq(projects.id, projectId));
      if (!cur) throw new NotFoundError('Project', projectId);
      throw new VersionConflictError('Project', input.expectedVersion, cur.v);
    }
    await audit(tx, actor, { action: 'project.update', targetType: 'project', targetId: projectId, projectId, payload: { name: patch.name, description: patch.description } });
    await emitEvent(tx, { type: 'project.updated', aggregateType: 'project', aggregateId: projectId, workspaceId: p.workspaceId, projectId });
    return p;
  });
}

/**
 * Archiving is non-destructive. Hard deletion of project data is a mandatory human-approval action
 * (Blueprint §16.3) and is delivered with the Approval Manager in Phase 8.
 */
export async function setProjectArchived(
  deps: Pick<ProjectDeps, 'db'>,
  actor: Actor,
  projectId: string,
  archived: boolean,
): Promise<Project> {
  await authorize(deps.db, actor, 'project.archive', { projectId });
  return deps.db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Db;
    const [cur] = await tx.select().from(projects).where(eq(projects.id, projectId)).limit(1);
    if (!cur) throw new NotFoundError('Project', projectId);
    const status = archived ? 'archived' : 'active';
    if (cur.status === status) return cur;
    const [p] = await tx
      .update(projects)
      .set({ status, version: cur.version + 1 })
      .where(and(eq(projects.id, projectId), eq(projects.version, cur.version)))
      .returning();
    if (!p) throw new VersionConflictError('Project', cur.version, cur.version + 1);
    await audit(tx, actor, { action: archived ? 'project.archive' : 'project.restore', targetType: 'project', targetId: projectId, projectId });
    await emitEvent(tx, { type: archived ? 'project.archived' : 'project.restored', aggregateType: 'project', aggregateId: projectId, workspaceId: p.workspaceId, projectId });
    return p;
  });
}

// ---------------------------------------------------------------- members

export async function listProjectMembers(deps: Pick<ProjectDeps, 'db'>, actor: Actor, projectId: string) {
  await authorize(deps.db, actor, 'project.read', { projectId });
  const rows = await deps.db
    .select({ userId: users.id, email: users.email, displayName: users.displayName, role: projectMembers.role })
    .from(projectMembers)
    .innerJoin(users, eq(users.id, projectMembers.userId))
    .where(eq(projectMembers.projectId, projectId))
    .orderBy(asc(users.email));
  return rows;
}

export async function upsertProjectMember(
  deps: Pick<ProjectDeps, 'db'>,
  actor: Actor,
  projectId: string,
  input: { userId: string; role: Role },
): Promise<void> {
  await authorize(deps.db, actor, 'project.members.manage', { projectId });
  if (!ROLES.includes(input.role) || input.role === 'owner') {
    throw new ValidationError('Invalid project role (owner is a workspace-level role)');
  }
  await deps.db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Db;
    const [ws] = await tx
      .select({ id: workspaceMembers.id })
      .from(workspaceMembers)
      .where(and(eq(workspaceMembers.workspaceId, actor.workspaceId!), eq(workspaceMembers.userId, input.userId)))
      .limit(1);
    if (!ws) throw new ValidationError('User must be a member of the workspace first');
    const [existing] = await tx
      .select()
      .from(projectMembers)
      .where(and(eq(projectMembers.projectId, projectId), eq(projectMembers.userId, input.userId)))
      .limit(1);
    if (existing) {
      await tx.update(projectMembers).set({ role: input.role, version: existing.version + 1 }).where(eq(projectMembers.id, existing.id));
    } else {
      await tx.insert(projectMembers).values({ projectId, userId: input.userId, role: input.role });
    }
    await audit(tx, actor, {
      action: existing ? 'project.member.role_changed' : 'project.member.added',
      targetType: 'user',
      targetId: input.userId,
      projectId,
      payload: { from: existing?.role ?? null, to: input.role },
    });
  });
}

export async function removeProjectMember(deps: Pick<ProjectDeps, 'db'>, actor: Actor, projectId: string, userId: string) {
  await authorize(deps.db, actor, 'project.members.manage', { projectId });
  const deleted = await deps.db
    .delete(projectMembers)
    .where(and(eq(projectMembers.projectId, projectId), eq(projectMembers.userId, userId)))
    .returning();
  if (deleted.length === 0) throw new NotFoundError('Project member', userId);
  await audit(deps.db, actor, { action: 'project.member.removed', targetType: 'user', targetId: userId, projectId });
}

// ---------------------------------------------------------------- settings

export async function getProjectSettings(deps: Pick<ProjectDeps, 'db'>, actor: Actor, projectId: string) {
  await authorize(deps.db, actor, 'project.read', { projectId });
  const [s] = await deps.db.select().from(projectSettings).where(eq(projectSettings.projectId, projectId)).limit(1);
  if (!s) throw new NotFoundError('Project settings', projectId);
  return s;
}

export async function updateProjectSettings(
  deps: Pick<ProjectDeps, 'db'>,
  actor: Actor,
  projectId: string,
  input: { settings: Record<string, unknown>; expectedVersion: number },
) {
  await authorize(deps.db, actor, 'project.update', { projectId });
  const [cur] = await deps.db.select().from(projectSettings).where(eq(projectSettings.projectId, projectId)).limit(1);
  if (!cur) throw new NotFoundError('Project settings', projectId);
  const [s] = await deps.db
    .update(projectSettings)
    .set({ settings: input.settings, version: input.expectedVersion + 1, configVersion: cur.configVersion + 1 })
    .where(and(eq(projectSettings.projectId, projectId), eq(projectSettings.version, input.expectedVersion)))
    .returning();
  if (!s) throw new VersionConflictError('Project settings', input.expectedVersion, cur.version);
  await audit(deps.db, actor, { action: 'project.settings.update', targetType: 'project', targetId: projectId, projectId, payload: { settings: input.settings } });
  return s;
}
