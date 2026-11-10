import { connect } from '@platform/db';
import { createLogger } from '@platform/observability';
import { gitAvailable } from '@platform/projects';
import { LocalStorage } from '@platform/storage';
import { buildApp } from './app.js';
import { loadConfig } from './config.js';

async function main() {
  const config = loadConfig();
  const logger = createLogger({ level: config.logLevel, bindings: { service: 'api' } });
  if (!(await gitAvailable())) throw new Error('git is required but was not found on PATH');

  const conn = await connect({ url: config.databaseUrl });
  await conn.migrate();
  logger.info('database ready', { driver: conn.driver });

  const app = await buildApp({
    db: conn.db,
    storage: new LocalStorage(config.storageRoot),
    logger,
    cookieSecure: config.cookieSecure,
    rateLimitPerMinute: config.rateLimitPerMinute,
  });

  const shutdown = async (signal: string) => {
    logger.info('shutting down', { signal });
    await app.close();
    await conn.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  await app.listen({ host: config.host, port: config.port });
  logger.info('api listening', {
    url: `http://${config.host}:${config.port}/api/v1`,
    storageRoot: config.storageRoot,
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
