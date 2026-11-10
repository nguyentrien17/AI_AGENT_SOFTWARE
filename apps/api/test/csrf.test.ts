import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createTestDatabase, type DatabaseConnection } from '@platform/db';
import { createLogger } from '@platform/observability';
import { LocalStorage } from '@platform/storage';
import { buildApp } from '../src/app.js';
import { isTrustedOrigin } from '../src/csrf.js';
import { loadConfig } from '../src/config.js';

describe('CSRF origin check (R5)', () => {
  it('trusts same-origin, loopback-to-loopback and allow-listed origins only', () => {
    expect(isTrustedOrigin('http://127.0.0.1:5173', '127.0.0.1:8787', [])).toBe(true);
    expect(isTrustedOrigin('http://localhost:5173', '127.0.0.1:8787', [])).toBe(true);
    expect(isTrustedOrigin('https://platform.example.com', 'platform.example.com', [])).toBe(true);
    expect(isTrustedOrigin('https://evil.example', '127.0.0.1:8787', [])).toBe(false);
    expect(isTrustedOrigin('http://localhost:5173', 'platform.example.com', [])).toBe(false);
    expect(isTrustedOrigin('https://ui.example.com', 'api.example.com', ['https://ui.example.com'])).toBe(true);
    expect(isTrustedOrigin('null', '127.0.0.1:8787', [])).toBe(false);
    expect(loadConfig({ ALLOWED_ORIGINS: 'https://ui.example.com/, http://x.test:8080' }).allowedOrigins).toEqual([
      'https://ui.example.com',
      'http://x.test:8080',
    ]);
    expect(() => loadConfig({ ALLOWED_ORIGINS: 'not a url' })).toThrow(/Invalid origin/);
  });

  let app: FastifyInstance;
  let conn: DatabaseConnection;
  let dir: string;
  beforeAll(async () => {
    conn = await createTestDatabase();
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'csrf-'));
    app = await buildApp({
      db: conn.db,
      storage: new LocalStorage(dir),
      logger: createLogger({ sink: () => undefined }),
      allowedOrigins: ['https://ui.example.com'],
    });
  });
  afterAll(async () => {
    await app.close();
    await conn.close();
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('rejects a cross-site write before it reaches the handler, and allows the rest', async () => {
    const body = { email: 'o@example.com', password: 'correct-horse-battery', displayName: 'O' };
    const evil = await app.inject({ method: 'POST', url: '/api/v1/auth/bootstrap', headers: { origin: 'https://evil.example', host: '127.0.0.1:8787' }, payload: body });
    expect(evil.statusCode).toBe(403);
    expect(evil.json()).toMatchObject({ code: 'csrf_origin_rejected' });
    expect((await app.inject({ method: 'GET', url: '/api/v1/auth/status' })).json()).toMatchObject({ bootstrapped: false });

    const referer = await app.inject({ method: 'POST', url: '/api/v1/auth/bootstrap', headers: { referer: 'https://evil.example/page', host: '127.0.0.1:8787' }, payload: body });
    expect(referer.statusCode).toBe(403);
    // Reads are never blocked; the allow-listed UI and plain clients may write.
    expect((await app.inject({ method: 'GET', url: '/api/v1/health', headers: { origin: 'https://evil.example' } })).statusCode).toBe(200);
    const ui = await app.inject({ method: 'POST', url: '/api/v1/auth/bootstrap', headers: { origin: 'https://ui.example.com', host: 'api.example.com' }, payload: body });
    expect(ui.statusCode).toBe(201);
    const script = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email: body.email, password: body.password } });
    expect(script.statusCode).toBe(200);
  });
});
