import path from 'node:path';

export interface ApiConfig {
  host: string;
  port: number;
  databaseUrl: string;
  storageRoot: string;
  cookieSecure: boolean;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  rateLimitPerMinute: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ApiConfig {
  const dataDir = path.resolve(env.PLATFORM_DATA_DIR ?? './data');
  const port = Number(env.PORT ?? 8787);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`Invalid PORT '${env.PORT}'`);
  const logLevel = (env.LOG_LEVEL ?? 'info') as ApiConfig['logLevel'];
  if (!['debug', 'info', 'warn', 'error'].includes(logLevel))
    throw new Error(`Invalid LOG_LEVEL '${env.LOG_LEVEL}'`);
  return {
    host: env.HOST ?? '127.0.0.1',
    port,
    databaseUrl: env.DATABASE_URL ?? `pglite://${path.join(dataDir, 'pgdata')}`,
    storageRoot: path.resolve(env.PLATFORM_STORAGE_ROOT ?? path.join(dataDir, 'storage')),
    cookieSecure: (env.COOKIE_SECURE ?? 'false') === 'true',
    logLevel,
    rateLimitPerMinute: Number(env.RATE_LIMIT_PER_MINUTE ?? 600),
  };
}
