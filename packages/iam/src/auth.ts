import { and, asc, count, eq, gt, isNull, sql } from 'drizzle-orm';
import { hash, verify } from '@node-rs/argon2';
import { type Db, sessions, users, workspaceMembers, workspaces } from '@platform/db';
import { audit } from '@platform/observability';
import {
  type Actor,
  ConflictError,
  ForbiddenError,
  NotFoundError,
  randomToken,
  sha256Hex,
  UnauthenticatedError,
  ValidationError,
} from '@platform/shared';
import { authorize, ROLES, type Role } from './policy.js';

export const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const MIN_PASSWORD = 12;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Hash used to equalize timing when the user does not exist.
let dummyHash: Promise<string> | null = null;
const getDummyHash = () => (dummyHash ??= hash('dummy-password-for-timing'));

export interface PublicUser {
  id: string;
  email: string;
  displayName: string;
  status: 'active' | 'disabled';
}

export interface AuthContext {
  user: PublicUser;
  workspaceId: string;
  role: Role;
  sessionId: string;
}

function toPublic(u: typeof users.$inferSelect): PublicUser {
  return { id: u.id, email: u.email, displayName: u.displayName, status: u.status };
}

function validateCredentials(email: string, password: string): string {
  const normalized = email.trim().toLowerCase();
  if (!EMAIL_RE.test(normalized))
    throw new ValidationError('Invalid email address', [{ path: 'email', message: 'invalid email' }]);
  if (password.length < MIN_PASSWORD) {
    throw new ValidationError(`Password must be at least ${MIN_PASSWORD} characters`, [
      { path: 'password', message: `min length ${MIN_PASSWORD}` },
    ]);
  }
  return normalized;
}

function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || 'workspace'
  );
}

export async function isBootstrapped(db: Db): Promise<boolean> {
  const [row] = await db.select({ n: count() }).from(users);
  return (row?.n ?? 0) > 0;
}

/** First-run setup: creates the platform owner and the default workspace. Fails once any user exists. */
export async function bootstrapOwner(
  db: Db,
  input: { email: string; password: string; displayName: string; workspaceName?: string },
): Promise<{ user: PublicUser; workspaceId: string }> {
  const email = validateCredentials(input.email, input.password);
  const passwordHash = await hash(input.password);
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(7001)`);
    const [existing] = await tx.select({ n: count() }).from(users);
    if ((existing?.n ?? 0) > 0)
      throw new ConflictError('Platform already initialized', 'already_bootstrapped');
    const wsName = input.workspaceName?.trim() || 'Default Workspace';
    const [ws] = await tx
      .insert(workspaces)
      .values({ name: wsName, slug: slugify(wsName) })
      .returning();
    const [u] = await tx
      .insert(users)
      .values({ email, displayName: input.displayName.trim() || email, passwordHash, isPlatformOwner: true })
      .returning();
    await tx.insert(workspaceMembers).values({ workspaceId: ws!.id, userId: u!.id, role: 'owner' });
    const actor: Actor = { type: 'user', userId: u!.id, workspaceId: ws!.id };
    await audit(tx as unknown as Db, actor, {
      action: 'platform.bootstrap',
      targetType: 'workspace',
      targetId: ws!.id,
    });
    return { user: toPublic(u!), workspaceId: ws!.id };
  });
}

export async function login(
  db: Db,
  input: { email: string; password: string; workspaceId?: string },
  now: Date = new Date(),
): Promise<{ token: string; context: AuthContext; expiresAt: Date }> {
  const email = input.email.trim().toLowerCase();
  const [u] = await db.select().from(users).where(eq(users.email, email)).limit(1);
  const ok = u
    ? await verify(u.passwordHash, input.password)
    : (await verify(await getDummyHash(), input.password), false);
  if (!u || !ok || u.status !== 'active') throw new UnauthenticatedError('Invalid email or password');

  const memberships = await db
    .select({ workspaceId: workspaceMembers.workspaceId, role: workspaceMembers.role })
    .from(workspaceMembers)
    .where(eq(workspaceMembers.userId, u.id))
    .orderBy(asc(workspaceMembers.createdAt));
  const membership = input.workspaceId
    ? memberships.find((m) => m.workspaceId === input.workspaceId)
    : memberships[0];
  if (!membership) throw new ForbiddenError('User is not a member of any workspace');

  const token = randomToken(32);
  const expiresAt = new Date(now.getTime() + SESSION_TTL_MS);
  const [s] = await db
    .insert(sessions)
    .values({ userId: u.id, workspaceId: membership.workspaceId, tokenHash: sha256Hex(token), expiresAt })
    .returning();
  await audit(
    db,
    { type: 'user', userId: u.id, workspaceId: membership.workspaceId },
    {
      action: 'auth.login',
      targetType: 'session',
      targetId: s!.id,
    },
  );
  return {
    token,
    expiresAt,
    context: {
      user: toPublic(u),
      workspaceId: membership.workspaceId,
      role: membership.role as Role,
      sessionId: s!.id,
    },
  };
}

export async function authenticate(
  db: Db,
  token: string | undefined,
  now: Date = new Date(),
): Promise<AuthContext> {
  if (!token) throw new UnauthenticatedError();
  const rows = await db
    .select({ session: sessions, user: users, role: workspaceMembers.role })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .innerJoin(
      workspaceMembers,
      and(
        eq(workspaceMembers.userId, sessions.userId),
        eq(workspaceMembers.workspaceId, sessions.workspaceId),
      ),
    )
    .where(
      and(eq(sessions.tokenHash, sha256Hex(token)), isNull(sessions.revokedAt), gt(sessions.expiresAt, now)),
    )
    .limit(1);
  const row = rows[0];
  if (!row || row.user.status !== 'active') throw new UnauthenticatedError('Session invalid or expired');
  return {
    user: toPublic(row.user),
    workspaceId: row.session.workspaceId,
    role: row.role as Role,
    sessionId: row.session.id,
  };
}

export async function logout(db: Db, token: string): Promise<void> {
  await db
    .update(sessions)
    .set({ revokedAt: new Date() })
    .where(eq(sessions.tokenHash, sha256Hex(token)));
}

export async function createUser(
  db: Db,
  actor: Actor,
  input: { email: string; displayName: string; password: string; role: Role },
): Promise<PublicUser & { role: Role }> {
  await authorize(db, actor, 'user.manage');
  if (!ROLES.includes(input.role)) throw new ValidationError('Invalid role');
  if (input.role === 'owner') await requireOwner(db, actor);
  const email = validateCredentials(input.email, input.password);
  const passwordHash = await hash(input.password);
  return db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Db;
    const [dup] = await tx.select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1);
    if (dup) throw new ConflictError('A user with this email already exists', 'email_taken');
    const [u] = await tx
      .insert(users)
      .values({ email, displayName: input.displayName.trim() || email, passwordHash })
      .returning();
    await tx
      .insert(workspaceMembers)
      .values({ workspaceId: actor.workspaceId!, userId: u!.id, role: input.role });
    await audit(tx, actor, {
      action: 'user.create',
      targetType: 'user',
      targetId: u!.id,
      payload: { email, role: input.role },
    });
    return { ...toPublic(u!), role: input.role };
  });
}

export async function listWorkspaceMembers(db: Db, actor: Actor) {
  await authorize(db, actor, 'workspace.read');
  const rows = await db
    .select({ user: users, role: workspaceMembers.role })
    .from(workspaceMembers)
    .innerJoin(users, eq(users.id, workspaceMembers.userId))
    .where(eq(workspaceMembers.workspaceId, actor.workspaceId!))
    .orderBy(asc(users.email));
  return rows.map((r) => ({ ...toPublic(r.user), role: r.role as Role }));
}

async function requireOwner(db: Db, actor: Actor): Promise<void> {
  if (actor.type !== 'user') throw new ForbiddenError();
  const [m] = await db
    .select({ role: workspaceMembers.role })
    .from(workspaceMembers)
    .where(
      and(eq(workspaceMembers.workspaceId, actor.workspaceId), eq(workspaceMembers.userId, actor.userId)),
    )
    .limit(1);
  if (m?.role !== 'owner') throw new ForbiddenError('Only owners can grant or revoke the owner role');
}

async function ownerCount(db: Db, workspaceId: string): Promise<number> {
  const [r] = await db
    .select({ n: count() })
    .from(workspaceMembers)
    .where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.role, 'owner')));
  return r?.n ?? 0;
}

/** Changing roles is a permission escalation boundary: owner role changes require an owner. */
export async function setWorkspaceMemberRole(
  db: Db,
  actor: Actor,
  userId: string,
  role: Role,
): Promise<void> {
  await authorize(db, actor, 'workspace.members.manage');
  if (!ROLES.includes(role)) throw new ValidationError('Invalid role');
  await db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Db;
    const [m] = await tx
      .select()
      .from(workspaceMembers)
      .where(and(eq(workspaceMembers.workspaceId, actor.workspaceId!), eq(workspaceMembers.userId, userId)))
      .limit(1);
    if (!m) throw new NotFoundError('Workspace member', userId);
    if (m.role === 'owner' || role === 'owner') await requireOwner(tx, actor);
    if (m.role === 'owner' && role !== 'owner' && (await ownerCount(tx, actor.workspaceId!)) <= 1) {
      throw new ConflictError('Cannot demote the last owner', 'last_owner');
    }
    await tx
      .update(workspaceMembers)
      .set({ role, version: m.version + 1 })
      .where(eq(workspaceMembers.id, m.id));
    await audit(tx, actor, {
      action: 'workspace.member.role_changed',
      targetType: 'user',
      targetId: userId,
      payload: { from: m.role, to: role },
    });
  });
}

export async function removeWorkspaceMember(db: Db, actor: Actor, userId: string): Promise<void> {
  await authorize(db, actor, 'workspace.members.manage');
  await db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Db;
    const [m] = await tx
      .select()
      .from(workspaceMembers)
      .where(and(eq(workspaceMembers.workspaceId, actor.workspaceId!), eq(workspaceMembers.userId, userId)))
      .limit(1);
    if (!m) throw new NotFoundError('Workspace member', userId);
    if (m.role === 'owner') {
      await requireOwner(tx, actor);
      if ((await ownerCount(tx, actor.workspaceId!)) <= 1)
        throw new ConflictError('Cannot remove the last owner', 'last_owner');
    }
    await tx.delete(workspaceMembers).where(eq(workspaceMembers.id, m.id));
    await tx
      .update(sessions)
      .set({ revokedAt: new Date() })
      .where(and(eq(sessions.userId, userId), eq(sessions.workspaceId, actor.workspaceId!)));
    await audit(tx, actor, { action: 'workspace.member.removed', targetType: 'user', targetId: userId });
  });
}

export async function getWorkspace(db: Db, actor: Actor) {
  await authorize(db, actor, 'workspace.read');
  const [ws] = await db.select().from(workspaces).where(eq(workspaces.id, actor.workspaceId!)).limit(1);
  if (!ws) throw new NotFoundError('Workspace', actor.workspaceId ?? undefined);
  return ws;
}

export async function updateWorkspace(
  db: Db,
  actor: Actor,
  input: { name: string; expectedVersion: number },
) {
  await authorize(db, actor, 'workspace.update');
  const name = input.name.trim();
  if (!name) throw new ValidationError('Name is required');
  const [ws] = await db
    .update(workspaces)
    .set({ name, version: input.expectedVersion + 1 })
    .where(and(eq(workspaces.id, actor.workspaceId!), eq(workspaces.version, input.expectedVersion)))
    .returning();
  if (!ws) throw new ConflictError('Workspace was modified concurrently', 'version_conflict');
  await audit(db, actor, {
    action: 'workspace.update',
    targetType: 'workspace',
    targetId: ws.id,
    payload: { name },
  });
  return ws;
}
