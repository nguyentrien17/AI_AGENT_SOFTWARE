import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import {
  auditLogs,
  createTestDatabase,
  type DatabaseConnection,
  projectMembers,
  projects,
} from '@platform/db';
import { type Actor, ForbiddenError, NotFoundError, UnauthenticatedError } from '@platform/shared';
import {
  authenticate,
  authorize,
  bootstrapOwner,
  createUser,
  effectiveProjectRole,
  isBootstrapped,
  login,
  logout,
  PERMISSIONS,
  removeWorkspaceMember,
  ROLES,
  roleHasPermission,
  type Role,
  setWorkspaceMemberRole,
} from '../src/index.js';

const PW = 'correct-horse-battery';

describe('RBAC matrix', () => {
  const expectations: Record<Role, { allow: string[]; deny: string[] }> = {
    owner: { allow: [...PERMISSIONS], deny: [] },
    administrator: { allow: ['user.manage', 'workspace.members.manage', 'project.archive'], deny: [] },
    project_manager: {
      allow: ['project.create', 'requirement.approve', 'task.transition', 'audit.read'],
      deny: ['user.manage', 'workspace.members.manage', 'workspace.update'],
    },
    developer: {
      allow: ['task.write', 'task.transition', 'artifact.write', 'requirement.write'],
      deny: ['project.create', 'requirement.approve', 'artifact.approve', 'audit.read', 'user.manage'],
    },
    reviewer: {
      allow: ['artifact.approve', 'task.read'],
      deny: ['task.write', 'artifact.write', 'project.create'],
    },
    viewer: {
      allow: ['project.read', 'task.read', 'artifact.read'],
      deny: ['task.write', 'artifact.write', 'artifact.approve', 'audit.read', 'project.create'],
    },
  };
  for (const role of ROLES) {
    it(`${role} permissions`, () => {
      for (const p of expectations[role].allow)
        expect(roleHasPermission(role, p as never), `${role} → ${p}`).toBe(true);
      for (const p of expectations[role].deny)
        expect(roleHasPermission(role, p as never), `${role} ✗ ${p}`).toBe(false);
    });
  }

  it('effective project role', () => {
    expect(effectiveProjectRole('owner', null)).toBe('owner');
    expect(effectiveProjectRole('administrator', 'viewer')).toBe('administrator');
    expect(effectiveProjectRole('developer', null)).toBeNull();
    expect(effectiveProjectRole('developer', 'viewer')).toBe('viewer');
    expect(effectiveProjectRole(null, 'owner')).toBeNull();
  });
});

describe('auth & workspace membership', () => {
  let conn: DatabaseConnection;
  let owner: Actor;
  let workspaceId: string;

  beforeAll(async () => {
    conn = await createTestDatabase();
  });
  afterAll(async () => conn.close());

  it('bootstraps the first owner exactly once', async () => {
    expect(await isBootstrapped(conn.db)).toBe(false);
    const r = await bootstrapOwner(conn.db, {
      email: 'Owner@Example.com',
      password: PW,
      displayName: 'Owner',
    });
    workspaceId = r.workspaceId;
    owner = { type: 'user', userId: r.user.id, workspaceId };
    expect(r.user.email).toBe('owner@example.com');
    expect(await isBootstrapped(conn.db)).toBe(true);
    await expect(
      bootstrapOwner(conn.db, { email: 'x@example.com', password: PW, displayName: 'X' }),
    ).rejects.toMatchObject({
      code: 'already_bootstrapped',
    });
  });

  it('rejects weak passwords', async () => {
    await expect(
      createUser(conn.db, owner, {
        email: 'weak@example.com',
        displayName: 'W',
        password: 'short',
        role: 'viewer',
      }),
    ).rejects.toMatchObject({ code: 'validation_error' });
  });

  it('login → authenticate → logout lifecycle, never storing raw token', async () => {
    const { token, context } = await login(conn.db, { email: 'owner@example.com', password: PW });
    expect(context.role).toBe('owner');
    const auth = await authenticate(conn.db, token);
    expect(auth.user.email).toBe('owner@example.com');
    const dump = JSON.stringify(await conn.db.execute(sql`select token_hash from sessions`));
    expect(dump).not.toContain(token);
    await logout(conn.db, token);
    await expect(authenticate(conn.db, token)).rejects.toBeInstanceOf(UnauthenticatedError);
  });

  it('rejects wrong password and expired sessions', async () => {
    await expect(
      login(conn.db, { email: 'owner@example.com', password: 'wrong-password-123' }),
    ).rejects.toBeInstanceOf(UnauthenticatedError);
    await expect(login(conn.db, { email: 'nobody@example.com', password: PW })).rejects.toBeInstanceOf(
      UnauthenticatedError,
    );
    const { token } = await login(conn.db, { email: 'owner@example.com', password: PW });
    await expect(authenticate(conn.db, token, new Date(Date.now() + 13 * 3600_000))).rejects.toBeInstanceOf(
      UnauthenticatedError,
    );
  });

  it('enforces RBAC on user management and role escalation', async () => {
    const dev = await createUser(conn.db, owner, {
      email: 'dev@example.com',
      displayName: 'Dev',
      password: PW,
      role: 'developer',
    });
    const admin = await createUser(conn.db, owner, {
      email: 'admin@example.com',
      displayName: 'Adm',
      password: PW,
      role: 'administrator',
    });
    const devActor: Actor = { type: 'user', userId: dev.id, workspaceId };
    const adminActor: Actor = { type: 'user', userId: admin.id, workspaceId };

    await expect(
      createUser(conn.db, devActor, {
        email: 'x2@example.com',
        displayName: 'X',
        password: PW,
        role: 'viewer',
      }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    // administrators cannot mint owners
    await expect(setWorkspaceMemberRole(conn.db, adminActor, dev.id, 'owner')).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    await setWorkspaceMemberRole(conn.db, adminActor, dev.id, 'reviewer');
    // last owner protection
    await expect(
      setWorkspaceMemberRole(conn.db, owner, owner.type === 'user' ? owner.userId : '', 'viewer'),
    ).rejects.toMatchObject({
      code: 'last_owner',
    });
    // removing a member revokes their sessions
    const { token } = await login(conn.db, { email: 'dev@example.com', password: PW });
    await removeWorkspaceMember(conn.db, adminActor, dev.id);
    await expect(authenticate(conn.db, token)).rejects.toBeInstanceOf(UnauthenticatedError);

    const actions = (await conn.db.select().from(auditLogs)).map((a) => a.action);
    expect(actions).toEqual(
      expect.arrayContaining([
        'platform.bootstrap',
        'user.create',
        'workspace.member.role_changed',
        'workspace.member.removed',
      ]),
    );
  });

  it('project-scoped authorization requires membership for non-admin roles', async () => {
    const pm = await createUser(conn.db, owner, {
      email: 'pm@example.com',
      displayName: 'PM',
      password: PW,
      role: 'project_manager',
    });
    const pmActor: Actor = { type: 'user', userId: pm.id, workspaceId };
    const [p] = await conn.db
      .insert(projects)
      .values({ workspaceId, key: 'alpha', name: 'Alpha', storagePath: 'x' })
      .returning();

    await expect(authorize(conn.db, pmActor, 'project.read', { projectId: p!.id })).rejects.toBeInstanceOf(
      NotFoundError,
    );
    await conn.db.insert(projectMembers).values({ projectId: p!.id, userId: pm.id, role: 'viewer' });
    await expect(authorize(conn.db, pmActor, 'project.read', { projectId: p!.id })).resolves.toEqual({
      role: 'viewer',
    });
    await expect(authorize(conn.db, pmActor, 'task.write', { projectId: p!.id })).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    await expect(authorize(conn.db, owner, 'task.write', { projectId: p!.id })).resolves.toEqual({
      role: 'owner',
    });

    const agent: Actor = { type: 'agent', agentKey: 'developer', agentVersion: 1, workspaceId };
    await expect(authorize(conn.db, agent, 'project.read')).rejects.toBeInstanceOf(ForbiddenError);
  });
});
