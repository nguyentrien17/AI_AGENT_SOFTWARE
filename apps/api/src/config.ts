import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Repository root. Relative paths in the configuration are resolved against it, not against the current
 * directory: `npm run dev:api` runs inside `apps/api`, which would otherwise move `./data` and
 * `./agent-library` there.
 */
export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

export interface ApiConfig {
  host: string;
  port: number;
  databaseUrl: string;
  storageRoot: string;
  cookieSecure: boolean;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  rateLimitPerMinute: number;
  agentLibraryDir: string;
  workerEnabled: boolean;
  workerIdleMs: number;
  allowedOrigins: string[];
  /** Directory of the built Web UI, or null when it has not been built. */
  webDistDir: string | null;
}

/** Loads `<repo>/.env` into `process.env`. Variables already set in the environment win. */
export function loadDotEnv(root: string = REPO_ROOT): string | null {
  const file = path.join(root, '.env');
  if (!existsSync(file)) return null;
  process.loadEnvFile(file);
  return file;
}

function resolveDatabaseUrl(url: string | undefined, dataDir: string, root: string): string {
  if (!url) return `pglite://${path.join(dataDir, 'pgdata')}`;
  const m = /^pglite:\/\/(.*)$/.exec(url);
  if (!m || m[1] === 'memory' || m[1] === '') return url;
  return `pglite://${path.resolve(root, m[1]!)}`;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env, root: string = REPO_ROOT): ApiConfig {
  const dataDir = path.resolve(root, env.PLATFORM_DATA_DIR ?? 'data');
  const port = Number(env.PORT ?? 8787);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`Invalid PORT '${env.PORT}'`);
  const logLevel = (env.LOG_LEVEL ?? 'info') as ApiConfig['logLevel'];
  if (!['debug', 'info', 'warn', 'error'].includes(logLevel))
    throw new Error(`Invalid LOG_LEVEL '${env.LOG_LEVEL}'`);
  return {
    host: env.HOST ?? '127.0.0.1',
    port,
    databaseUrl: resolveDatabaseUrl(env.DATABASE_URL, dataDir, root),
    storageRoot: path.resolve(root, env.PLATFORM_STORAGE_ROOT ?? path.join(dataDir, 'storage')),
    cookieSecure: (env.COOKIE_SECURE ?? 'false') === 'true',
    logLevel,
    rateLimitPerMinute: Number(env.RATE_LIMIT_PER_MINUTE ?? 600),
    agentLibraryDir: path.resolve(root, env.AGENT_LIBRARY_DIR ?? 'agent-library'),
    workerEnabled: (env.WORKER_ENABLED ?? 'true') === 'true',
    workerIdleMs: Number(env.WORKER_IDLE_MS ?? 2000),
    webDistDir: (() => {
      const dir = path.resolve(root, env.WEB_DIST_DIR ?? 'apps/web/dist');
      return existsSync(path.join(dir, 'index.html')) ? dir : null;
    })(),
    allowedOrigins: (env.ALLOWED_ORIGINS ?? '')
      .split(',')
      .map((o) => o.trim())
      .filter(Boolean)
      .map((o) => {
        try {
          return new URL(o).origin;
        } catch {
          throw new Error(`Invalid origin '${o}' in ALLOWED_ORIGINS`);
        }
      }),
  };
}
