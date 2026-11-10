import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createTestDatabase, type DatabaseConnection } from '@platform/db';
import { createLogger } from '@platform/observability';
import { LocalStorage } from '@platform/storage';
import { buildApp } from '../src/app.js';

/** B1: the API serves the built Web UI at `/` (same origin) without shadowing the API. */
let app: FastifyInstance;
let conn: DatabaseConnection;
let dir: string;

beforeAll(async () => {
  conn = await createTestDatabase();
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'web-'));
  const dist = path.join(dir, 'dist');
  await fs.mkdir(path.join(dist, 'assets'), { recursive: true });
  await fs.writeFile(path.join(dist, 'index.html'), '<!doctype html><div id="root"></div>');
  await fs.writeFile(path.join(dist, 'assets', 'app.js'), 'console.log("ui")');
  app = await buildApp({ db: conn.db, storage: new LocalStorage(path.join(dir, 'storage')), logger: createLogger({ sink: () => undefined }), webDistDir: dist });
});

afterAll(async () => {
  await app.close();
  await conn.close();
  await fs.rm(dir, { recursive: true, force: true });
});

describe('Web UI hosting', () => {
  it('serves the app shell, its assets, and deep links', async () => {
    const root = await app.inject({ method: 'GET', url: '/' });
    expect(root.statusCode).toBe(200);
    expect(root.headers['content-type']).toMatch(/text\/html/);
    expect(root.body).toContain('id="root"');
    expect((await app.inject({ method: 'GET', url: '/assets/app.js' })).body).toContain('console.log');
    const deep = await app.inject({ method: 'GET', url: '/projects/0198f0c2-0000-7000-8000-000000000000' });
    expect(deep.statusCode).toBe(200);
    expect(deep.body).toContain('id="root"');
  });

  it('keeps API routes and API errors as JSON', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/v1/health' })).json()).toEqual({ status: 'ok' });
    const missing = await app.inject({ method: 'GET', url: '/api/v1/does-not-exist' });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toMatchObject({ code: 'route_not_found' });
    expect((await app.inject({ method: 'POST', url: '/somewhere' })).statusCode).toBe(404);
    // No path traversal out of the dist folder: a file next to it must stay unreachable.
    await fs.writeFile(path.join(dir, 'secret.txt'), 'TOP-SECRET-OUTSIDE-DIST');
    for (const url of ['/../secret.txt', '/..%2fsecret.txt', '/%2e%2e/secret.txt', '/assets/..%2f..%2fsecret.txt']) {
      expect((await app.inject({ method: 'GET', url })).body, url).not.toContain('TOP-SECRET');
    }
  });
});
