import { fileURLToPath } from 'node:url';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { drizzle as drizzlePglite } from 'drizzle-orm/pglite';
import { migrate as migratePglite } from 'drizzle-orm/pglite/migrator';
import { drizzle as drizzlePg } from 'drizzle-orm/node-postgres';
import { migrate as migratePg } from 'drizzle-orm/node-postgres/migrator';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import pg from 'pg';
import * as schema from './schema/index.js';

export type Schema = typeof schema;
/** Database handle usable for both the root connection and transactions. */
export type Db = PgDatabase<PgQueryResultHKT, Schema>;

export interface DatabaseConnection {
  db: Db;
  driver: 'pglite' | 'postgres';
  migrate(): Promise<void>;
  close(): Promise<void>;
}

export const MIGRATIONS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../migrations');

export interface ConnectOptions {
  /**
   * `postgres://...` → PostgreSQL via node-postgres.
   * `pglite://memory` → in-memory embedded Postgres (tests).
   * `pglite://<dir>` or a filesystem path → persistent embedded Postgres (local-first mode).
   */
  url: string;
}

export async function connect({ url }: ConnectOptions): Promise<DatabaseConnection> {
  if (url.startsWith('postgres://') || url.startsWith('postgresql://')) {
    const pool = new pg.Pool({ connectionString: url, max: 10 });
    const db = drizzlePg(pool, { schema }) as unknown as Db;
    return {
      db,
      driver: 'postgres',
      migrate: () => migratePg(db as never, { migrationsFolder: MIGRATIONS_DIR }),
      close: () => pool.end(),
    };
  }

  const target = url.replace(/^pglite:\/\//, '');
  const inMemory = target === 'memory' || target === '';
  if (!inMemory) await mkdir(path.dirname(path.resolve(target)), { recursive: true }); // first-run: create data dir
  const client = inMemory ? new PGlite() : new PGlite(path.resolve(target));
  await client.waitReady;
  const db = drizzlePglite(client, { schema }) as unknown as Db;
  return {
    db,
    driver: 'pglite',
    migrate: () => migratePglite(db as never, { migrationsFolder: MIGRATIONS_DIR }),
    close: () => client.close(),
  };
}

/** Convenience for tests: fresh in-memory database with all migrations applied. */
export async function createTestDatabase(): Promise<DatabaseConnection> {
  const conn = await connect({ url: 'pglite://memory' });
  await conn.migrate();
  return conn;
}
