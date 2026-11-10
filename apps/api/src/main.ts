import { createDefaultAdapterRegistry, EnvelopeSecretStore } from '@platform/ai-management';
import { connect } from '@platform/db';
import { createLogger } from '@platform/observability';
import { gitAvailable } from '@platform/projects';
import { LocalStorage } from '@platform/storage';
import { buildApp } from './app.js';
import { loadConfig, loadDotEnv } from './config.js';
import { startWorker } from './worker.js';
import { createDefaultToolCatalog, syncToolRegistry } from '@platform/tool-executor';

async function main() {
  const envFile = loadDotEnv();
  const config = loadConfig();
  const logger = createLogger({ level: config.logLevel, bindings: { service: 'api' } });
  if (envFile) logger.info('environment loaded', { file: envFile });
  if (!(await gitAvailable())) throw new Error('git is required but was not found on PATH');

  const conn = await connect({ url: config.databaseUrl });
  await conn.migrate();
  logger.info('database ready', { driver: conn.driver });

  const storage = new LocalStorage(config.storageRoot);
  const secretStore = EnvelopeSecretStore.fromEnv();
  const adapterRegistry = createDefaultAdapterRegistry();
  const toolCatalog = createDefaultToolCatalog();
  logger.info('tool registry synced', { tools: await syncToolRegistry(conn.db, toolCatalog) });
  const app = await buildApp({
    db: conn.db,
    storage,
    logger,
    secretStore,
    adapterRegistry,
    cookieSecure: config.cookieSecure,
    rateLimitPerMinute: config.rateLimitPerMinute,
    agentLibraryDir: config.agentLibraryDir,
    toolCatalog,
  });
  const worker = config.workerEnabled
    ? startWorker({ db: conn.db, storage, secretStore, registry: adapterRegistry, toolCatalog, logger, idleMs: config.workerIdleMs })
    : null;

  const shutdown = async (signal: string) => {
    logger.info('shutting down', { signal });
    await worker?.stop();
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
