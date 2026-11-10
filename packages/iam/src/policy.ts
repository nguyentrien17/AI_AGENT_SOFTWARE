import { and, eq } from 'drizzle-orm';
import { type Db, projectMembers, projects, workspaceMembers } from '@platform/db';
import { type Actor, ForbiddenError, NotFoundError } from '@platform/shared';

export const ROLES = [
  'owner',
  'administrator',
  'project_manager',
  'developer',
  'reviewer',
  'viewer',
] as const;
export type Role = (typeof ROLES)[number];

export const PERMISSIONS = [
  'workspace.read',
  'workspace.update',
  'workspace.members.manage',
  'user.manage',
  'project.create',
  'project.read',
  'project.update',
  'project.archive',
  'project.members.manage',
  'requirement.read',
  'requirement.write',
  'requirement.approve',
  'artifact.read',
  'artifact.write',
  'artifact.approve',
  'task.read',
  'task.write',
  'task.transition',
  'audit.read',
] as const;
export type Permission = (typeof PERMISSIONS)[number];

const READ: Permission[] = [
  'workspace.read',
  'project.read',
  'requirement.read',
  'artifact.read',
  'task.read',
];

/** RBAC matrix (docs/phase-0/07-security-model.md §3). Deny by default. */
export const ROLE_PERMISSIONS: Readonly<Record<Role, ReadonlySet<Permission>>> = {
  owner: new Set(PERMISSIONS),
  administrator: new Set(PERMISSIONS),
  project_manager: new Set<Permission>([
    ...READ,
    'project.create',
    'project.update',
    'project.archive',
    'project.members.manage',
    'requirement.write',
    'requirement.approve',
    'artifact.write',
    'artifact.approve',
    'task.write',
    'task.transition',
    'audit.read',
  ]),
  developer: new Set<Permission>([
    ...READ,
    'requirement.write',
    'artifact.write',
    'task.write',
    'task.transition',
  ]),
  reviewer: new Set<Permission>([...READ, 'artifact.approve']),
  viewer: new Set<Permission>(READ),
};

/** Workspace-wide roles that see every project in the workspace without explicit membership. */
const WORKSPACE_WIDE: ReadonlySet<Role> = new Set(['owner', 'administrator']);

export function roleHasPermission(role: Role, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role].has(permission);
}

/**
 * Effective role for a project: owners/administrators keep their workspace role; everybody else needs an
 * explicit project membership and acts with the project role.
 */
export function effectiveProjectRole(workspaceRole: Role | null, projectRole: Role | null): Role | null {
  if (!workspaceRole) return null;
  if (WORKSPACE_WIDE.has(workspaceRole)) return workspaceRole;
  return projectRole;
}

export interface AuthorizationResult {
  role: Role | 'system';
}

/**
 * Central authorization check. Agents are rejected here: agent permissions are evaluated by the
 * 7-dimension agent permission engine (Phase 2/6), never through human RBAC.
 */
export async function authorize(
  db: Db,
  actor: Actor,
  permission: Permission,
  scope: { projectId?: string } = {},
): Promise<AuthorizationResult> {
  if (actor.type === 'system') return { role: 'system' };
  if (actor.type !== 'user') throw new ForbiddenError('Agents cannot use human RBAC permissions');

  const [wm] = await db
    .select({ role: workspaceMembers.role })
    .from(workspaceMembers)
    .where(
      and(eq(workspaceMembers.workspaceId, actor.workspaceId), eq(workspaceMembers.userId, actor.userId)),
    )
    .limit(1);
  const workspaceRole = (wm?.role ?? null) as Role | null;
  if (!workspaceRole) throw new ForbiddenError('Not a member of this workspace');

  let role: Role | null = workspaceRole;
  if (scope.projectId) {
    const [p] = await db
      .select({ workspaceId: projects.workspaceId })
      .from(projects)
      .where(eq(projects.id, scope.projectId))
      .limit(1);
    // Do not leak existence of projects in other workspaces.
    if (!p || p.workspaceId !== actor.workspaceId) throw new NotFoundError('Project', scope.projectId);
    const [pm] = await db
      .select({ role: projectMembers.role })
      .from(projectMembers)
      .where(and(eq(projectMembers.projectId, scope.projectId), eq(projectMembers.userId, actor.userId)))
      .limit(1);
    role = effectiveProjectRole(workspaceRole, (pm?.role ?? null) as Role | null);
    if (!role) throw new NotFoundError('Project', scope.projectId);
  }

  if (!roleHasPermission(role, permission)) {
    throw new ForbiddenError(`Role '${role}' lacks permission '${permission}'`);
  }
  return { role };
}
