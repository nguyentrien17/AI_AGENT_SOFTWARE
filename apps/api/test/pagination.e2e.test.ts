import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createTestDatabase, type DatabaseConnection } from '@platform/db';
import { createLogger } from '@platform/observability';
import { LocalStorage } from '@platform/storage';
import { dispatchOutboxBatch } from '@platform/observability';
import { buildApp } from '../src/app.js';
import { createOutboxHandlers } from '../src/outbox-handlers.js';

/** R2: cursor pagination on task and artifact lists. */
let app: FastifyInstance;
let conn: DatabaseConnection;
let dir: string;
let cookie: string;
let projectId: string;

async function call(method: string, url: string, body?: unknown) {
  return app.inject({ method: method as never, url: `/api/v1${url}`, headers: { cookie }, ...(body ? { payload: body as object } : {}) });
}

async function collect(url: string, limit: number) {
  const pages: Array<Array<Record<string, string>>> = [];
  let cursor: string | null = null;
  do {
    const res = await call('GET', `${url}?limit=${limit}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json() as { items: Array<Record<string, string>>; nextCursor: string | null };
    pages.push(body.items);
    cursor = body.nextCursor;
  } while (cursor);
  return pages;
}

beforeAll(async () => {
  conn = await createTestDatabase();
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pages-'));
  app = await buildApp({ db: conn.db, storage: new LocalStorage(dir), logger: createLogger({ sink: () => undefined }), initGit: false });
  await app.inject({ method: 'POST', url: '/api/v1/auth/bootstrap', payload: { email: 'o@example.com', password: 'correct-horse-battery', displayName: 'O' } });
  const login = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email: 'o@example.com', password: 'correct-horse-battery' } });
  cookie = String(login.headers['set-cookie']).split(';')[0]!;
  projectId = (await call('POST', '/projects', { key: 'pages', name: 'Pages' })).json().id;
  for (let i = 0; i < 5; i++) {
    await call('POST', `/projects/${projectId}/tasks`, { title: `Task ${i}`, objective: 'x' });
    await call('POST', `/projects/${projectId}/artifacts`, { path: `.ai-context/08-knowledge/note-${i}.md`, type: 'note', content: `# ${i}` });
  }
});

afterAll(async () => {
  await app.close();
  await conn.close();
  await fs.rm(dir, { recursive: true, force: true });
});

describe('cursor pagination (R2)', () => {
  it('pages through tasks in creation order without gaps or duplicates', async () => {
    const pages = await collect(`/projects/${projectId}/tasks`, 2);
    expect(pages.map((p) => p.length)).toEqual([2, 2, 1]);
    expect(pages.flat().map((t) => t['title'])).toEqual(['Task 0', 'Task 1', 'Task 2', 'Task 3', 'Task 4']);
    const all = await call('GET', `/projects/${projectId}/tasks`);
    expect(all.json()).toMatchObject({ nextCursor: null });
    expect(all.json().items).toHaveLength(5);
  });

  it('pages through artifacts by path', async () => {
    const pages = await collect(`/projects/${projectId}/artifacts`, 3);
    const paths = pages.flat().map((a) => a['path']);
    expect(paths).toEqual([...paths].sort());
    expect(paths.filter((p) => p!.includes('note-'))).toHaveLength(5);
    expect(new Set(paths).size).toBe(paths.length);
  });

  it('rejects malformed cursors and limits', async () => {
    expect((await call('GET', `/projects/${projectId}/tasks?cursor=not-a-uuid`)).statusCode).toBe(400);
    expect((await call('GET', `/projects/${projectId}/tasks?limit=0`)).statusCode).toBe(400);
    expect((await call('GET', `/projects/${projectId}/tasks?limit=1000`)).statusCode).toBe(400);
  });
});

describe('OpenAPI response documentation (R3)', () => {
  it('documents success and error responses without truncating payloads', async () => {
    const spec = (await app.inject({ method: 'GET', url: '/api/v1/openapi.json' })).json();
    const tasksGet = spec.paths['/api/v1/projects/{id}/tasks'].get.responses;
    expect(Object.keys(tasksGet)).toEqual(expect.arrayContaining(['200', '4XX', '5XX']));
    expect(JSON.stringify(tasksGet['200'])).toContain('nextCursor');
    expect(JSON.stringify(tasksGet['4XX'])).toContain('RFC 7807');
    // Every route documents errors, even those without a documented success schema.
    expect(Object.keys(spec.paths['/api/v1/budgets'].put.responses)).toContain('4XX');

    // Undeclared fields still reach the client.
    const page = (await call('GET', `/projects/${projectId}/tasks?limit=1`)).json();
    expect(page.items[0]).toHaveProperty('inputRefs');
    expect(page.items[0]).toHaveProperty('acceptanceCriteria');
    // Error bodies keep their extension fields.
    const bad = (await call('GET', `/projects/${projectId}/tasks?cursor=nope`)).json();
    expect(bad).toMatchObject({ status: 400, code: 'validation_error' });
    expect(bad).toHaveProperty('requestId');
  });
});

describe('outbox consumers (R4, R6)', () => {
  it('re-syncs a stale context map from the database when artifact events are dispatched', async () => {
    const project = (await call('GET', `/projects/${projectId}`)).json();
    const mapFile = path.join(dir, project.storagePath, '.ai-context', '00-index', 'context-map.json');
    await fs.writeFile(mapFile, JSON.stringify({ schema_version: '1.0', items: [] })); // simulate a lost race
    const handlers = createOutboxHandlers(conn.db, new LocalStorage(dir));
    let dispatched = 0;
    for (let i = 0; i < 20; i++) {
      const r = await dispatchOutboxBatch(conn.db, handlers);
      dispatched += r.dispatched;
      if (r.dispatched === 0) break;
    }
    expect(dispatched).toBeGreaterThan(0);
    const map = JSON.parse(await fs.readFile(mapFile, 'utf8')) as { items: Array<{ path: string }> };
    expect(map.items.filter((i) => i.path.includes('note-'))).toHaveLength(5);
  });
});
