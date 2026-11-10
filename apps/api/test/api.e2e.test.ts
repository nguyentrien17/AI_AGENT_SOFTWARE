import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { connect, type DatabaseConnection } from '@platform/db';
import { createLogger } from '@platform/observability';
import { LocalStorage } from '@platform/storage';
import { buildApp } from '../src/app.js';

/**
 * Phase 1 Gate (docs/phase-0/08-roadmap.md): end-to-end persistence, retrieval and state recovery of
 * projects and tasks through the public HTTP API, using a persistent embedded Postgres that is restarted.
 */
const PW = 'correct-horse-battery';
let dir: string;
let conn: DatabaseConnection;
let app: FastifyInstance;
const silent = createLogger({ sink: () => undefined });

async function start() {
  conn = await connect({ url: `pglite://${path.join(dir, 'pgdata')}` });
  await conn.migrate();
  app = await buildApp({ db: conn.db, storage: new LocalStorage(path.join(dir, 'storage')), logger: silent });
}
async function stop() {
  await app.close();
  await conn.close();
}

function cookieOf(res: LightMyRequestResponse): string {
  const raw = res.headers['set-cookie'];
  const c = (Array.isArray(raw) ? raw : [raw]).find((x) => x?.startsWith('sid='));
  if (!c) throw new Error('no session cookie');
  return c.split(';')[0]!;
}

async function call(
  method: string,
  url: string,
  cookie?: string,
  body?: unknown,
  headers: Record<string, string> = {},
) {
  return app.inject({
    method: method as never,
    url: `/api/v1${url}`,
    headers: { ...(cookie ? { cookie } : {}), ...headers },
    ...(body !== undefined ? { payload: body as object } : {}),
  });
}

beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'api-test-'));
  await start();
});
afterAll(async () => {
  await stop().catch(() => undefined);
  await fs.rm(dir, { recursive: true, force: true });
});

describe('Phase 1 gate — HTTP API end to end', () => {
  let ownerCookie: string;
  let devCookie: string;
  let viewerCookie: string;
  let devId: string;
  let viewerId: string;
  let projectId: string;
  let taskA: string;
  let taskB: string;
  let artifactId: string;

  it('is deny-by-default and reports bootstrap status', async () => {
    expect((await call('GET', '/health')).statusCode).toBe(200);
    const s = await call('GET', '/auth/status');
    expect(s.json()).toEqual({ bootstrapped: false, authenticated: false });
    const r = await call('GET', '/projects');
    expect(r.statusCode).toBe(401);
    expect(r.headers['content-type']).toContain('application/problem+json');
    expect(r.json()).toMatchObject({ status: 401, code: 'unauthenticated', title: 'Unauthenticated' });
  });

  it('bootstraps owner, logs in with an httpOnly SameSite cookie', async () => {
    const b = await call('POST', '/auth/bootstrap', undefined, {
      email: 'owner@example.com',
      password: PW,
      displayName: 'Owner',
    });
    expect(b.statusCode).toBe(201);
    expect(
      (
        await call('POST', '/auth/bootstrap', undefined, {
          email: 'x@example.com',
          password: PW,
          displayName: 'X',
        })
      ).statusCode,
    ).toBe(409);
    const login = await call('POST', '/auth/login', undefined, { email: 'owner@example.com', password: PW });
    expect(login.statusCode).toBe(200);
    const setCookie = String(login.headers['set-cookie']);
    expect(setCookie).toMatch(/HttpOnly/i);
    expect(setCookie).toMatch(/SameSite=Strict/i);
    ownerCookie = cookieOf(login);
    expect((await call('GET', '/auth/me', ownerCookie)).json().role).toBe('owner');
    expect(
      (
        await call('POST', '/auth/login', undefined, {
          email: 'owner@example.com',
          password: 'wrong-password!!',
        })
      ).statusCode,
    ).toBe(401);
  });

  it('creates users and validates payloads with RFC 7807 errors', async () => {
    const bad = await call('POST', '/users', ownerCookie, {
      email: 'dev@example.com',
      displayName: 'Dev',
      password: PW,
      role: 'god',
      extra: 1,
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json()).toMatchObject({ code: 'validation_error', status: 400 });
    expect(bad.json().errors.length).toBeGreaterThan(0);

    const dev = await call('POST', '/users', ownerCookie, {
      email: 'dev@example.com',
      displayName: 'Dev',
      password: PW,
      role: 'developer',
    });
    expect(dev.statusCode).toBe(201);
    devId = dev.json().id;
    const viewer = await call('POST', '/users', ownerCookie, {
      email: 'viewer@example.com',
      displayName: 'Viewer',
      password: PW,
      role: 'viewer',
    });
    viewerId = viewer.json().id;
    devCookie = cookieOf(
      await call('POST', '/auth/login', undefined, { email: 'dev@example.com', password: PW }),
    );
    viewerCookie = cookieOf(
      await call('POST', '/auth/login', undefined, { email: 'viewer@example.com', password: PW }),
    );
    expect(JSON.stringify(dev.json())).not.toContain('password');
  });

  it('creates a project idempotently and enforces RBAC', async () => {
    const body = { key: 'shop', name: 'Shop', description: 'Online shop' };
    const headers = { 'idempotency-key': 'create-shop-0001' };
    const first = await call('POST', '/projects', ownerCookie, body, headers);
    expect(first.statusCode).toBe(201);
    projectId = first.json().id;
    const replay = await call('POST', '/projects', ownerCookie, body, headers);
    expect(replay.statusCode).toBe(201);
    expect(replay.headers['idempotent-replayed']).toBe('true');
    expect(replay.json().id).toBe(projectId);
    const reuse = await call('POST', '/projects', ownerCookie, { ...body, name: 'Other' }, headers);
    expect(reuse.statusCode).toBe(422);
    expect(reuse.json().code).toBe('idempotency_key_reused');

    expect((await call('POST', '/projects', devCookie, { key: 'dev-proj', name: 'X' })).statusCode).toBe(403);
    expect((await call('GET', `/projects/${projectId}`, devCookie)).statusCode).toBe(404);
    expect(
      (await call('PUT', `/projects/${projectId}/members`, ownerCookie, { userId: devId, role: 'developer' }))
        .statusCode,
    ).toBe(204);
    expect(
      (await call('PUT', `/projects/${projectId}/members`, ownerCookie, { userId: viewerId, role: 'viewer' }))
        .statusCode,
    ).toBe(204);
    expect((await call('GET', `/projects/${projectId}`, devCookie)).statusCode).toBe(200);
    expect((await call('GET', '/projects', devCookie)).json().items).toHaveLength(1);
    const stale = await call('PUT', `/projects/${projectId}`, ownerCookie, {
      name: 'Shop 2',
      expectedVersion: 99,
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().code).toBe('version_conflict');
  });

  it('manages requirements and stories', async () => {
    const req = await call('POST', `/projects/${projectId}/requirements`, devCookie, {
      title: 'Checkout',
      body: 'Users can pay',
    });
    expect(req.statusCode).toBe(201);
    const r = req.json();
    const inReview = await call('POST', `/requirements/${r.id}/transitions`, devCookie, {
      to: 'in_review',
      expectedVersion: r.version,
    });
    expect(inReview.statusCode).toBe(200);
    expect(
      (
        await call('POST', `/requirements/${r.id}/transitions`, devCookie, {
          to: 'approved',
          expectedVersion: inReview.json().version,
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await call('POST', `/requirements/${r.id}/transitions`, ownerCookie, {
          to: 'approved',
          expectedVersion: inReview.json().version,
        })
      ).statusCode,
    ).toBe(200);
    const story = await call('POST', `/projects/${projectId}/user-stories`, devCookie, {
      requirementId: r.id,
      asA: 'buyer',
      iWant: 'to pay by card',
    });
    expect(story.statusCode).toBe(201);
    const ac = await call('POST', `/user-stories/${story.json().id}/acceptance-criteria`, devCookie, {
      then: 'payment is captured',
    });
    expect(ac.statusCode).toBe(201);
  });

  it('versions artifacts with hashes and approval', async () => {
    const c = await call('POST', `/projects/${projectId}/artifacts`, devCookie, {
      path: '.ai-context/01-requirements/overview.md',
      type: 'requirement',
      content: '# v1',
    });
    expect(c.statusCode).toBe(201);
    artifactId = c.json().item.id;
    expect(
      (
        await call('POST', `/artifacts/${artifactId}/versions`, viewerCookie, {
          content: 'x',
          expectedVersionNo: 1,
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await call('POST', `/artifacts/${artifactId}/versions`, devCookie, {
          content: '# v2',
          expectedVersionNo: 1,
        })
      ).statusCode,
    ).toBe(201);
    expect(
      (
        await call('POST', `/artifacts/${artifactId}/versions`, devCookie, {
          content: '# v2b',
          expectedVersionNo: 1,
        })
      ).statusCode,
    ).toBe(409);
    expect((await call('POST', `/artifacts/${artifactId}/versions/2/approve`, devCookie)).statusCode).toBe(
      403,
    );
    expect((await call('POST', `/artifacts/${artifactId}/versions/2/approve`, ownerCookie)).statusCode).toBe(
      200,
    );
    const content = await call('GET', `/artifacts/${artifactId}/versions/approved/content`, viewerCookie);
    expect(content.statusCode).toBe(200);
    expect(content.body).toBe('# v2');
    expect(content.headers['x-content-sha256']).toMatch(/^[0-9a-f]{64}$/);
  });

  it('creates tasks with dependencies and validated transitions', async () => {
    const a = await call('POST', `/projects/${projectId}/tasks`, devCookie, {
      title: 'Schema',
      objective: 'Design DB',
      acceptanceCriteria: ['migrations run'],
    });
    const b = await call('POST', `/projects/${projectId}/tasks`, devCookie, {
      title: 'API',
      objective: 'Build API',
    });
    taskA = a.json().id;
    taskB = b.json().id;
    expect(
      (await call('POST', `/tasks/${taskB}/dependencies`, devCookie, { dependsOnTaskId: taskA })).statusCode,
    ).toBe(204);
    const cycle = await call('POST', `/tasks/${taskA}/dependencies`, devCookie, { dependsOnTaskId: taskB });
    expect(cycle.statusCode).toBe(409);
    expect(cycle.json().code).toBe('dependency_cycle');
    expect(
      (await call('POST', `/tasks/${taskA}/transitions`, devCookie, { to: 'pending' })).json().status,
    ).toBe('ready');
    expect(
      (await call('POST', `/tasks/${taskB}/transitions`, devCookie, { to: 'pending' })).json().status,
    ).toBe('pending');
    const illegal = await call('POST', `/tasks/${taskA}/transitions`, devCookie, { to: 'completed' });
    expect(illegal.statusCode).toBe(409);
    expect(
      (await call('POST', `/tasks/${taskA}/transitions`, devCookie, { to: 'assigned' })).statusCode,
    ).toBe(403);
    expect(
      (await call('POST', `/tasks/${taskA}/transitions`, viewerCookie, { to: 'cancelled' })).statusCode,
    ).toBe(403);
  });

  it('exposes audit trail and OpenAPI', async () => {
    const audit = await call('GET', `/audit-logs?projectId=${projectId}&limit=5`, ownerCookie);
    expect(audit.statusCode).toBe(200);
    expect(audit.json().items).toHaveLength(5);
    expect(audit.json().nextCursor).toBeTruthy();
    const page2 = await call(
      'GET',
      `/audit-logs?projectId=${projectId}&limit=5&cursor=${audit.json().nextCursor}`,
      ownerCookie,
    );
    expect(page2.json().items[0].id < audit.json().items[4].id).toBe(true);
    expect((await call('GET', '/audit-logs', devCookie)).statusCode).toBe(403);
    const spec = await call('GET', '/openapi.json');
    expect(spec.json().openapi).toBe('3.1.0');
    expect(Object.keys(spec.json().paths)).toContain('/api/v1/projects/{id}/tasks');
  });

  it('recovers all state after a full process restart', async () => {
    await stop();
    await start();
    // sessions persist across restarts
    const me = await call('GET', '/auth/me', devCookie);
    expect(me.statusCode).toBe(200);
    expect((await call('GET', `/projects/${projectId}`, devCookie)).json().name).toBe('Shop');
    expect((await call('GET', `/tasks/${taskA}`, devCookie)).json().status).toBe('ready');
    expect((await call('GET', `/tasks/${taskB}`, devCookie)).json().status).toBe('pending');
    const history = await call('GET', `/tasks/${taskA}/history`, devCookie);
    expect(history.json().items.map((h: { toStatus: string }) => h.toStatus)).toEqual(['pending', 'ready']);
    const content = await call('GET', `/artifacts/${artifactId}/versions/1/content`, devCookie);
    expect(content.body).toBe('# v1');
    // logout invalidates the session server-side
    expect((await call('POST', '/auth/logout', devCookie)).statusCode).toBe(204);
    expect((await call('GET', '/auth/me', devCookie)).statusCode).toBe(401);
  });
});
