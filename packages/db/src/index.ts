import { sql } from 'drizzle-orm';
import type { Db } from './client.js';

export * from './client.js';
export * as schema from './schema/index.js';
export * from './schema/index.js';
export { sql };

/** Postgres unique-violation detector (works for node-postgres and PGlite). */
export function isUniqueViolation(e: unknown): boolean {
  const err = e as { code?: string; cause?: { code?: string } } | undefined;
  return err?.code === '23505' || err?.cause?.code === '23505';
}

/** Run `fn` inside a transaction (nested calls create a savepoint). */
export async function inTransaction<T>(db: Db, fn: (tx: Db) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => fn(tx as unknown as Db));
}
