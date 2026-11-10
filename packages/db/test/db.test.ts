import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  auditLogs,
  contextItems,
  contextVersions,
  createTestDatabase,
  type DatabaseConnection,
  isUniqueViolation,
  projects,
  users,
  workspaces,
} from '../src/index.js';

let conn: DatabaseConnection;

beforeAll(async () => {
  conn = await createTestDatabase();
});
afterAll(async () => {
  await conn.close();
});

describe('database migrations', () => {
  it('applies all migrations and supports CRUD with uuidv7 ids', async () => {
    const [ws] = await conn.db.insert(workspaces).values({ name: 'Default', slug: 'default' }).returning();
    expect(ws!.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(ws!.version).toBe(1);
    expect(ws!.createdAt).toBeInstanceOf(Date);
  });

  it('enforces unique constraints', async () => {
    await conn.db.insert(users).values({ email: 'a@x.io', displayName: 'A', passwordHash: 'h' });
    let err: unknown;
    try {
      await conn.db.insert(users).values({ email: 'a@x.io', displayName: 'B', passwordHash: 'h' });
    } catch (e) {
      err = e;
    }
    expect(isUniqueViolation(err)).toBe(true);
  });

  it('rejects update and delete on append-only audit_logs', async () => {
    const [row] = await conn.db
      .insert(auditLogs)
      .values({ actorType: 'system', actorId: 'test', action: 'x', targetType: 't' })
      .returning();
    await expect(
      conn.db.update(auditLogs).set({ action: 'y' }).where(eq(auditLogs.id, row!.id)),
    ).rejects.toThrow();
    await expect(conn.db.delete(auditLogs).where(eq(auditLogs.id, row!.id))).rejects.toThrow();
  });

  it('protects context_versions content columns while allowing approval', async () => {
    const [ws] = await conn.db.select().from(workspaces).limit(1);
    const [p] = await conn.db
      .insert(projects)
      .values({ workspaceId: ws!.id, key: 'p1', name: 'P1', storagePath: '/tmp/p1' })
      .returning();
    const [item] = await conn.db
      .insert(contextItems)
      .values({ projectId: p!.id, path: '.ai-context/01-requirements/overview.md', type: 'requirement' })
      .returning();
    const [v] = await conn.db
      .insert(contextVersions)
      .values({
        contextItemId: item!.id,
        versionNo: 1,
        sha256: 'a'.repeat(64),
        sizeBytes: 1,
        storageUri: 'blob://a',
        authorType: 'user',
        authorId: 'u',
      })
      .returning();
    await expect(
      conn.db
        .update(contextVersions)
        .set({ sha256: 'b'.repeat(64) })
        .where(eq(contextVersions.id, v!.id)),
    ).rejects.toThrow();
    await conn.db
      .update(contextVersions)
      .set({ status: 'approved', approvedAt: new Date() })
      .where(eq(contextVersions.id, v!.id));
    await expect(
      conn.db.update(contextVersions).set({ status: 'draft' }).where(eq(contextVersions.id, v!.id)),
    ).rejects.toThrow();
  });
});
