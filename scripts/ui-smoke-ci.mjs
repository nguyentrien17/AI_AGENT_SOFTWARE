/* global process, setTimeout, clearTimeout, fetch, console */
/* eslint-disable no-console */
// Runs the browser smoke test end to end (used by CI and `npm run smoke:ui`):
//   1. starts the API on a free port with a throwaway data dir, a random master key and the worker off;
//   2. waits for /api/v1/health;
//   3. runs scripts/ui-smoke.mjs against it (headless Edge/Chrome via CDP);
//   4. stops the API, deletes the data dir and exits with the smoke test's exit code.
// The UI must already be built (`npm run build:web`; `npm run smoke:ui` does that first).
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
if (!existsSync(path.join(root, 'apps/web/dist/index.html'))) {
  console.error('apps/web/dist is missing — run `npm run build:web` first.');
  process.exit(2);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () =>
  new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });

const port = Number(process.env.SMOKE_API_PORT ?? (await freePort()));
const dataDir = mkdtempSync(path.join(tmpdir(), 'ui-smoke-data-'));
const base = `http://127.0.0.1:${port}`;
const apiLog = [];
const api = spawn(process.execPath, ['--import', 'tsx', 'src/main.ts'], {
  cwd: path.join(root, 'apps/api'),
  env: {
    ...process.env,
    HOST: '127.0.0.1',
    PORT: String(port),
    PLATFORM_DATA_DIR: dataDir,
    PLATFORM_STORAGE_ROOT: path.join(dataDir, 'storage'),
    DATABASE_URL: `pglite://${path.join(dataDir, 'pgdata')}`,
    PLATFORM_MASTER_KEY: randomBytes(32).toString('base64'),
    WORKER_ENABLED: 'false',
    LOG_LEVEL: 'warn',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
api.stdout.on('data', (d) => apiLog.push(String(d)));
api.stderr.on('data', (d) => apiLog.push(String(d)));

let code = 1;
try {
  let healthy = false;
  for (let i = 0; i < 120 && !healthy && api.exitCode === null; i++) {
    await sleep(500);
    healthy = await fetch(`${base}/api/v1/health`).then((r) => r.ok).catch(() => false);
  }
  if (!healthy) throw new Error(`API did not become healthy on ${base}`);
  console.log(`API ready on ${base} (data: ${dataDir})`);
  const smoke = spawn(process.execPath, [path.join(root, 'scripts/ui-smoke.mjs'), base], { stdio: 'inherit' });
  const limit = Number(process.env.SMOKE_TIMEOUT_MS ?? 300_000) + 30_000;
  code = await new Promise((resolve) => {
    const timer = setTimeout(() => {
      console.error(`ui-smoke did not finish within ${limit} ms; stopping it`);
      smoke.kill();
      resolve(1);
    }, limit);
    smoke.on('exit', (c) => {
      clearTimeout(timer);
      resolve(c ?? 1);
    });
  });
} catch (err) {
  console.error(String(err));
} finally {
  api.kill();
  await sleep(500);
  if (code !== 0) console.error(`--- API output (last 40 lines) ---\n${apiLog.join('').split('\n').slice(-40).join('\n')}`);
  try {
    rmSync(dataDir, { recursive: true, force: true });
  } catch {
    // PGlite may still hold files briefly on Windows; the temp dir is harmless.
  }
}
process.exit(code);
