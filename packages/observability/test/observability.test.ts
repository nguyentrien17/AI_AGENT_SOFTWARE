import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  auditLogs,
  createTestDatabase,
  type DatabaseConnection,
  systemEvents,
  workspaces,
} from '@platform/db';
import { audit, createLogger, emitEvent } from '../src/index.js';

let conn: DatabaseConnection;
let workspaceId: string;

beforeAll(async () => {
  conn = await createTestDatabase();
  const [ws] = await conn.db.insert(workspaces).values({ name: 'W', slug: 'w' }).returning();
  workspaceId = ws!.id;
});
afterAll(async () => conn.close());

describe('audit + outbox', () => {
  it('persists redacted audit entries', async () => {
    await audit(
      conn.db,
      { type: 'user', userId: 'u1', workspaceId },
      {
        action: 'provider.create',
        targetType: 'provider',
        targetId: 'p1',
        payload: { apiKey: 'sk-supersecretvalue123', note: 'uses Bearer abcdefghijkl' },
      },
    );
    const [row] = await conn.db.select().from(auditLogs);
    expect(row!.actorId).toBe('u1');
    expect(JSON.stringify(row!.payload)).not.toContain('supersecret');
    expect(JSON.stringify(row!.payload)).not.toContain('abcdefghijkl');
  });

  it('writes outbox events atomically with the transaction', async () => {
    await expect(
      conn.db.transaction(async (tx) => {
        await emitEvent(tx as never, { type: 'task.created', aggregateType: 'task', aggregateId: 't1' });
        throw new Error('rollback');
      }),
    ).rejects.toThrow('rollback');
    expect(await conn.db.select().from(systemEvents)).toHaveLength(0);

    await emitEvent(conn.db, { type: 'task.created', aggregateType: 'task', aggregateId: 't1' });
    const rows = await conn.db.select().from(systemEvents);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe('pending');
  });
});

describe('logger', () => {
  it('redacts secrets in messages and context', () => {
    const lines: string[] = [];
    const log = createLogger({ sink: (l) => lines.push(l) });
    log.info('calling with sk-abcdefghijklmnop', {
      password: 'p@ss',
      nested: { authorization: 'Bearer xyzxyzxyzxyz' },
    });
    log.debug('hidden');
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain('abcdefghijklmnop');
    expect(lines[0]).not.toContain('p@ss');
    expect(lines[0]).not.toContain('xyzxyz');
  });
});
