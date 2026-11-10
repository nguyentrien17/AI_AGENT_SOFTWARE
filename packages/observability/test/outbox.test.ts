import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDatabase, type DatabaseConnection, systemEvents } from '@platform/db';
import { uuidv7 } from '@platform/shared';
import { dispatchOutboxBatch, emitEvent, type OutboxEvent } from '../src/index.js';

let conn: DatabaseConnection;
beforeAll(async () => {
  conn = await createTestDatabase();
});
afterAll(async () => conn.close());

const emit = (type: string) =>
  emitEvent(conn.db, { type, aggregateType: 'test', aggregateId: uuidv7(), payload: { n: 1 } });
const statusOf = async (type: string) =>
  (await conn.db.select().from(systemEvents).where(eq(systemEvents.type, type))).map((e) => [e.status, e.attempts]);

describe('outbox dispatcher (R4)', () => {
  it('runs handlers, marks events dispatched, and passes through events nobody handles', async () => {
    const seen: string[] = [];
    await emit('t.ok');
    await emit('t.unhandled');
    const res = await dispatchOutboxBatch(conn.db, { 't.ok': [async (e: OutboxEvent) => void seen.push(e.type)] });
    expect(res).toEqual({ dispatched: 2, retried: 0, failed: 0 });
    expect(seen).toEqual(['t.ok']);
    expect(await statusOf('t.ok')).toEqual([['dispatched', 0]]);
    expect(await statusOf('t.unhandled')).toEqual([['dispatched', 0]]);
    expect(await dispatchOutboxBatch(conn.db, {})).toEqual({ dispatched: 0, retried: 0, failed: 0 });
  });

  it('retries a failing handler and gives up after maxAttempts, keeping the redacted error', async () => {
    await emit('t.flaky');
    const failing = { 't.flaky': [async () => Promise.reject(new Error('downstream unavailable'))] };
    expect(await dispatchOutboxBatch(conn.db, failing, { maxAttempts: 3 })).toMatchObject({ retried: 1 });
    expect(await dispatchOutboxBatch(conn.db, failing, { maxAttempts: 3 })).toMatchObject({ retried: 1 });
    expect(await dispatchOutboxBatch(conn.db, failing, { maxAttempts: 3 })).toMatchObject({ failed: 1 });
    const [row] = await conn.db.select().from(systemEvents).where(eq(systemEvents.type, 't.flaky'));
    expect(row).toMatchObject({ status: 'failed', attempts: 3, lastError: 'downstream unavailable' });
    // A permanently failed event is not picked up again.
    expect(await dispatchOutboxBatch(conn.db, failing, { maxAttempts: 3 })).toEqual({ dispatched: 0, retried: 0, failed: 0 });
  });

  it('never delivers an event twice when dispatchers run concurrently', async () => {
    for (let i = 0; i < 20; i++) await emit('t.parallel');
    const delivered: string[] = [];
    const handlers = { 't.parallel': [async (e: OutboxEvent) => void delivered.push(e.id)] };
    const results = await Promise.all([1, 2, 3, 4].map(() => dispatchOutboxBatch(conn.db, handlers, { batchSize: 7 })));
    let total = results.reduce((n, r) => n + r.dispatched, 0);
    while (total < 20) total += (await dispatchOutboxBatch(conn.db, handlers, { batchSize: 7 })).dispatched;
    expect(delivered).toHaveLength(20);
    expect(new Set(delivered).size).toBe(20);
  });

  it('lets another dispatcher take over an event whose holder died without settling it', async () => {
    await emit('t.crash');
    const t0 = new Date();
    // Dispatcher A claimed the event and then died: the lease is set, nothing was settled.
    await conn.db
      .update(systemEvents)
      .set({ claimedBy: 'A', claimedUntil: new Date(t0.getTime() + 60_000) })
      .where(eq(systemEvents.type, 't.crash'));
    const handled: string[] = [];
    const handlers = { 't.crash': [async (e: OutboxEvent) => void handled.push(e.id)] };
    // While A's lease is valid, B cannot take it…
    await dispatchOutboxBatch(conn.db, handlers, { dispatcherId: 'B', now: () => new Date(t0.getTime() + 30_000) });
    expect(handled).toEqual([]);
    expect(await statusOf('t.crash')).toEqual([['pending', 0]]);
    // …after it expires, B handles and settles it.
    await dispatchOutboxBatch(conn.db, handlers, { dispatcherId: 'B', now: () => new Date(t0.getTime() + 61_000) });
    expect(handled).toHaveLength(1);
    const [row] = await conn.db.select().from(systemEvents).where(eq(systemEvents.type, 't.crash'));
    expect(row).toMatchObject({ status: 'dispatched', claimedBy: 'B', claimedUntil: null });
  });
});

