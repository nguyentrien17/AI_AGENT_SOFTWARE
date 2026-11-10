import { sql } from 'drizzle-orm';
import { integer, timestamp, uuid } from 'drizzle-orm/pg-core';
import { uuidv7 } from '@platform/shared';

/** Standard columns (Blueprint §13.10). */
export const id = () =>
  uuid('id')
    .primaryKey()
    .$defaultFn(() => uuidv7());

export const createdAt = () =>
  timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow();

export const updatedAt = () =>
  timestamp('updated_at', { withTimezone: true, mode: 'date' })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date());

/** Optimistic locking column. */
export const version = () => integer('version').notNull().default(1);

export const nowSql = sql`now()`;
