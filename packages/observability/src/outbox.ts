import { randomUUID } from 'node:crypto';
import { and, asc, eq, inArray, isNull, lt, or } from 'drizzle-orm';
import { type Db, systemEvents } from '@platform/db';
import { redact } from '@platform/shared';

export type OutboxEvent = typeof systemEvents.$inferSelect;

/** Handles one event type. Throwing marks the attempt failed; the event is retried later. */
export type OutboxHandler = (event: OutboxEvent) => Promise<void>;

export interface DispatchResult {
  dispatched: number;
  retried: number;
  failed: number;
}

export interface DispatchOptions {
  batchSize?: number;
  maxAttempts?: number;
  /** How long a claimed batch stays reserved for this dispatcher. */
  leaseSeconds?: number;
  dispatcherId?: string;
  now?: () => Date;
}

/**
 * Transactional outbox dispatcher (ADR-005, Phase 1 risk R4).
 *
 * 1. Claim: one short transaction reserves up to `batchSize` pending events for this dispatcher with a
 *    lease (`FOR UPDATE SKIP LOCKED`, so concurrent dispatchers never claim the same event).
 * 2. Handle: handlers run outside any transaction — they are free to use the database.
 * 3. Settle: each event is marked `dispatched`, kept `pending` for a retry, or — after `maxAttempts` —
 *    `failed`; only the lease holder can settle it. A crashed dispatcher's lease simply expires.
 *
 * Events without a handler are marked dispatched. Handlers must be idempotent: a crash between handling
 * and settling re-delivers the event.
 */
export async function dispatchOutboxBatch(
  db: Db,
  handlers: Readonly<Record<string, OutboxHandler[]>>,
  opts: DispatchOptions = {},
): Promise<DispatchResult> {
  const batchSize = opts.batchSize ?? 50;
  const maxAttempts = opts.maxAttempts ?? 5;
  const now = opts.now ?? (() => new Date());
  const me = opts.dispatcherId ?? randomUUID();
  const leaseMs = (opts.leaseSeconds ?? 120) * 1000;

  const claimed = await db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Db;
    const at = now();
    const free = await tx
      .select({ id: systemEvents.id })
      .from(systemEvents)
      .where(and(eq(systemEvents.status, 'pending'), or(isNull(systemEvents.claimedUntil), lt(systemEvents.claimedUntil, at))))
      .orderBy(asc(systemEvents.id))
      .limit(batchSize)
      .for('update', { skipLocked: true });
    if (free.length === 0) return [] as OutboxEvent[];
    return tx
      .update(systemEvents)
      .set({ claimedBy: me, claimedUntil: new Date(at.getTime() + leaseMs) })
      .where(inArray(systemEvents.id, free.map((f) => f.id)))
      .returning();
  });
  claimed.sort((a, b) => (a.id < b.id ? -1 : 1));

  const result: DispatchResult = { dispatched: 0, retried: 0, failed: 0 };
  for (const event of claimed) {
    let error: string | null = null;
    for (const handler of handlers[event.type] ?? []) {
      try {
        await handler(event);
      } catch (err) {
        error = String(redact(err instanceof Error ? err.message : String(err))).slice(0, 2000);
        break;
      }
    }
    const mine = and(eq(systemEvents.id, event.id), eq(systemEvents.claimedBy, me));
    if (error === null) {
      await db
        .update(systemEvents)
        .set({ status: 'dispatched', dispatchedAt: now(), lastError: null, claimedUntil: null })
        .where(mine);
      result.dispatched++;
      continue;
    }
    const attempts = event.attempts + 1;
    const giveUp = attempts >= maxAttempts;
    await db
      .update(systemEvents)
      .set({ attempts, lastError: error, status: giveUp ? 'failed' : 'pending', claimedUntil: null })
      .where(mine);
    if (giveUp) result.failed++;
    else result.retried++;
  }
  return result;
}
