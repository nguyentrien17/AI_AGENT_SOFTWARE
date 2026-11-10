// Usage: npx tsx scripts/smoke.ts (requires loopback networking; not available inside restricted sandboxes)
// Smoke test: real TCP listen + HTTP fetch in a single process, using a fresh persistent PGlite data dir.
import path from 'node:path';
import { rm } from 'node:fs/promises';
import { connect } from '@platform/db';
import { createLogger } from '@platform/observability';
import { LocalStorage } from '@platform/storage';
import { buildApp } from '../apps/api/src/app.ts';

const dir = path.resolve('.tmp/smoke2');
await rm(dir, { recursive: true, force: true });
const conn = await connect({ url: `pglite://${path.join(dir, 'pgdata')}` });
await conn.migrate();
const app = await buildApp({
  db: conn.db,
  storage: new LocalStorage(path.join(dir, 'storage')),
  logger: createLogger({ sink: () => {} }),
});
await app.listen({ host: '127.0.0.1', port: 8798 });
const base = 'http://127.0.0.1:8798/api/v1';
const out: Record<string, unknown> = {};
out.health = await (await fetch(`${base}/health`)).json();
out.status = await (await fetch(`${base}/auth/status`)).json();
out.unauth = (await fetch(`${base}/projects`)).status;
const boot = await fetch(`${base}/auth/bootstrap`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    email: 'owner@example.com',
    password: 'correct-horse-battery',
    displayName: 'Owner',
  }),
});
out.bootstrap = boot.status;
const login = await fetch(`${base}/auth/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: 'owner@example.com', password: 'correct-horse-battery' }),
});
const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0]!;
const proj = await fetch(`${base}/projects`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', cookie },
  body: JSON.stringify({ key: 'demo', name: 'Demo' }),
});
out.createProject = proj.status;
out.formPostRejected = (
  await fetch(`${base}/projects`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
    body: 'key=x&name=y',
  })
).status;
await app.close();
await conn.close();
process.stdout.write(JSON.stringify(out, null, 2) + '\n');
