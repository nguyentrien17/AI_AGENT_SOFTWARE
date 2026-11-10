import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { createArtifact } from '@platform/artifacts';
import { submitHandoff } from '@platform/context';
import { createTestDatabase, type DatabaseConnection } from '@platform/db';
import { createLogger } from '@platform/observability';
import { recordGateEvaluation, transitionTask } from '@platform/orchestration';
import { type Actor, uuidv7 } from '@platform/shared';
import { LocalStorage } from '@platform/storage';
import { buildApp } from '../src/app.js';

/** Phase 2 HTTP surface: context index, packages, handoffs, memories, checkpoints. */
const PW = 'correct-horse-battery';
let dir: string;
let conn: DatabaseConnection;
let storage: LocalStorage;
let app: FastifyInstance;
let cookie: string;
let workspaceId: string;

async function call(method: string, url: string, body?: unknown) {
  return app.inject({
    method: method as never,
    url: `/api/v1${url}`,
    headers: { cookie },
    ...(body !== undefined ? { payload: body as object } : {}),
  });
}
const json = (r: LightMyRequestResponse) => r.json();

beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'api-ctx-'));
  conn = await createTestDatabase();
  storage = new LocalStorage(dir);
  app = await buildApp({ db: conn.db, storage, logger: createLogger({ sink: () => undefined }) });
  const b = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/bootstrap',
    payload: { email: 'o@example.com', password: PW, displayName: 'O' },
  });
  workspaceId = b.json().workspaceId;
  const l = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { email: 'o@example.com', password: PW },
  });
  cookie = String(l.headers['set-cookie']).split(';')[0]!;
});
afterAll(async () => {
  await app.close();
  await conn.close();
  await fs.rm(dir, { recursive: true, force: true });
});

describe('Phase 2 — context API', () => {
  it('serves index, packages, handoffs, memories and checkpoints', async () => {
    const projectId = json(await call('POST', '/projects', { key: 'ctxapi', name: 'Ctx' })).id;
    const t1 = json(
      await call('POST', `/projects/${projectId}/tasks`, { title: 'BA', objective: 'reqs', agentRole: 'ba' }),
    ).id;
    const t2 = json(
      await call('POST', `/projects/${projectId}/tasks`, {
        title: 'Arch',
        objective: 'design',
        agentRole: 'architect',
      }),
    ).id;
    expect((await call('POST', `/tasks/${t2}/dependencies`, { dependsOnTaskId: t1 })).statusCode).toBe(204);
    await call('POST', `/tasks/${t1}/transitions`, { to: 'pending' });
    await call('POST', `/tasks/${t2}/transitions`, { to: 'pending' });

    // Simulated BA agent (agents run inside the platform, not over HTTP).
    const system: Actor = { type: 'system', workspaceId, component: 'test' };
    await transitionTask(conn.db, system, t1, 'assigned');
    await transitionTask(conn.db, system, t1, 'running');
    const ba: Actor = { type: 'agent', agentKey: 'ba', agentVersion: 1, workspaceId, taskId: t1 };
    const { version } = await createArtifact({ db: conn.db, storage }, ba, projectId, {
      path: '.ai-context/01-requirements/overview.md',
      type: 'requirement',
      content: '# Shop',
    });
    const handoffId = uuidv7();
    await submitHandoff({ db: conn.db, storage }, ba, {
      schema_version: '1.0',
      handoff_id: handoffId,
      project_id: projectId,
      task_id: t1,
      from_agent: 'ba',
      to_agent: 'architect',
      status: 'completed',
      output_refs: [{ path: '.ai-context/01-requirements/overview.md', version: 1, sha256: version.sha256 }],
      decisions: [],
      assumptions: [],
      open_questions: [],
      required_actions: [],
      created_at: new Date().toISOString(),
    });
    await recordGateEvaluation(conn.db, system, t1, {
      gateKey: 'review',
      outcome: 'passed',
      evidence: {
        tool: 't',
        toolVersion: '1',
        command: 'n/a',
        environmentId: 'e',
        gitTreeHash: null,
        logUri: null,
      },
    });
    await transitionTask(conn.db, system, t1, 'completed');

    const index = json(await call('GET', `/projects/${projectId}/context`));
    expect(index.items.map((i: { path: string }) => i.path)).toEqual(
      expect.arrayContaining(['.ai-context/01-requirements/overview.md']),
    );
    const itemId = index.items.find((i: { path: string }) => i.path.endsWith('overview.md')).id;
    expect(json(await call('GET', `/projects/${projectId}/context/${itemId}`)).versions).toHaveLength(1);

    const handoffs = json(await call('GET', `/projects/${projectId}/handoffs?taskId=${t1}`));
    expect(handoffs.items[0].id).toBe(handoffId);
    expect((await call('GET', `/agent-handoffs/${handoffId}`)).statusCode).toBe(200);

    // A human can preview the package an agent would receive.
    const built = await call('POST', `/projects/${projectId}/context/packages`, { taskId: t2 });
    expect(built.statusCode).toBe(201);
    const pkg = json(built);
    expect(pkg.manifest.items[0].path).toBe('.ai-context/01-requirements/overview.md');
    expect((await call('POST', `/projects/${projectId}/context/packages`, { taskId: t2 })).statusCode).toBe(
      200,
    ); // cache hit
    expect(json(await call('GET', `/tasks/${t2}/context`)).id).toBe(pkg.packageId);
    expect(json(await call('GET', `/context-packages/${pkg.packageId}`)).invalidatedAt).toBeNull();

    const mem = await call('POST', `/projects/${projectId}/memories`, {
      kind: 'constraint',
      content: 'GDPR applies',
    });
    expect(mem.statusCode).toBe(201);
    expect(json(await call('GET', `/context-packages/${pkg.packageId}`)).invalidatedAt).not.toBeNull();
    expect((await call('GET', `/tasks/${t2}/context`)).statusCode).toBe(404);
    expect(json(await call('GET', `/projects/${projectId}/memories?kind=constraint`)).items).toHaveLength(1);

    const cp = await call('POST', `/projects/${projectId}/checkpoints`, { label: 'design ready' });
    expect(cp.statusCode).toBe(201);
    const verified = json(await call('GET', `/checkpoints/${json(cp).id}`));
    expect(verified.verification).toEqual({ valid: true, problems: [] });
    expect(json(await call('GET', `/projects/${projectId}/checkpoints`)).items).toHaveLength(1);

    // Humans cannot write agent-owned areas through the API.
    const denied = await call('POST', `/projects/${projectId}/artifacts`, {
      path: '.ai-context/02-architecture/system-architecture.md',
      type: 'architecture',
      content: 'x',
    });
    expect(denied.statusCode).toBe(403);
    // Platform-managed paths are rejected outright.
    expect(
      (
        await call('POST', `/projects/${projectId}/artifacts`, {
          path: '.ai-context/10-checkpoints/x.json',
          type: 'x',
          content: 'x',
        })
      ).statusCode,
    ).toBe(400);
  });
});
